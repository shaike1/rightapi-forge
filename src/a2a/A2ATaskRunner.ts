/**
 * A2ATaskRunner — executes A2A tasks for a specific agent
 * Phase 2: Task Execution
 * Phase 3: Peer routing — when local command resolution fails, delegate to best peer
 *
 * Command resolution order:
 *   1. Direct format: "skill.command" or "skill.command key=val key2=val2"
 *   2. Direct format with JSON params: "skill.command { "key": "value" }"
 *   3. Fuzzy keyword match against the agent's own skill commands
 *   4. [Phase 3] Peer routing — find the best agent in the mesh that can handle it
 */
import type { A2AMessage, A2ATaskSendParams } from './A2ATypes.js';
import type { A2ATaskRecord } from './A2ATaskStore.js';
import { A2ATaskStore } from './A2ATaskStore.js';
import { AgentCardService } from './AgentCardService.js';
import type { A2APeerClient } from './A2APeerClient.js';
import type { A2APeerRouter } from './A2APeerRouter.js';
import type { ExternalAgentRegistry } from './ExternalAgentRegistry.js';
import { logger } from '../utils/logger.js';

type SkillExecutor = (command: string, params: Record<string, unknown>) => Promise<unknown>;

/** Describes one resolvable command with its keyword aliases */
interface CommandMeta {
  command: string;    // e.g. "docker.list"
  keywords: string[]; // e.g. ["docker", "list", "container"]
}

export class A2ATaskRunner {
  /** Tracks which tasks are currently running so we can cancel them */
  private runningTasks = new Set<string>();

  private peerClient?: A2APeerClient;
  private peerRouter?: A2APeerRouter;
  private externalRegistry?: ExternalAgentRegistry;

  constructor(
    private readonly store: A2ATaskStore,
    private readonly executeSkill: SkillExecutor,
    private readonly cardService: AgentCardService,
  ) {}

  /** Wire in peer routing after construction (Phase 3) */
  setPeerRouting(client: A2APeerClient, router: A2APeerRouter, registry?: ExternalAgentRegistry): void {
    this.peerClient = client;
    this.peerRouter = router;
    this.externalRegistry = registry;
  }

  /**
   * Create a task and start executing it asynchronously.
   * Returns immediately with the submitted task record.
   */
  async send(agentId: string, params: A2ATaskSendParams): Promise<A2ATaskRecord> {
    const task = this.store.create({
      agentId,
      sessionId: params.sessionId,
      message: params.message,
      metadata: { ...params.metadata, agentId },
    });

    this.runningTasks.add(task.id);

    // Fire-and-forget — caller polls or uses SSE
    this._execute(agentId, task.id, params.message)
      .catch(e => {
        this.store.updateStatus(task.id, 'failed', {
          role: 'agent',
          parts: [{ type: 'text', text: `Unhandled error: ${(e as Error).message}` }],
        });
      })
      .finally(() => {
        this.runningTasks.delete(task.id);
      });

    return this.store.get(task.id)!;
  }

  private async _execute(agentId: string, taskId: string, message: A2AMessage): Promise<void> {
    this.store.updateStatus(taskId, 'working');

    const card = this.cardService.getAgentCard(agentId);
    if (!card) {
      this.store.updateStatus(taskId, 'failed', {
        role: 'agent',
        parts: [{ type: 'text', text: `Agent "${agentId}" not found in mesh` }],
      });
      return;
    }

    // Extract plaintext from message
    const text = message.parts
      .filter(p => p.type === 'text')
      .map(p => (p as { type: 'text'; text: string }).text)
      .join(' ')
      .trim();

    if (!text) {
      this.store.updateStatus(taskId, 'failed', {
        role: 'agent',
        parts: [{ type: 'text', text: 'No text content in message. Provide a skill command, e.g. "docker.list" or "incident.create title=Test"' }],
      });
      return;
    }

    // Resolve command against this agent's own skills
    const resolved = this._resolveCommand(text, card.skills.map(s => s.id));

    if (!resolved.command) {
      // ── Phase 3+NL: Peer routing ──────────────────────────────────────────
      if (this.peerRouter && this.peerClient) {
        // Try async peer lookup (includes NL classification fallback)
        const peers = await this.peerRouter.findAllPeersAsync(text, agentId);
        const peer = peers.length > 0 ? peers[0] : null;
        if (peer) {
          const nlNote = (peer as any).nlReasoning ? ` [NL: ${(peer as any).nlReasoning}]` : '';
          logger.info(`[A2A] Peer routing task ${taskId}: "${text}" → ${peer.agentName} (${peer.skillId}, score=${peer.score}${peer.isExternal ? ', external' : ''}${nlNote})`);
          try {
            const peerTask = await this.peerClient.invoke(peer.agentId, message, {
              parentTaskId: taskId,
              taskEndpoint: peer.taskEndpoint,
              authConfig: peer.isExternal && this.externalRegistry
                ? this.externalRegistry.get(peer.agentId)?.authConfig
                : undefined,
            });

            // Forward peer artifacts into this task
            for (const artifact of (peerTask.artifacts ?? [])) {
              this.store.addArtifact(taskId, {
                ...artifact,
                name: `[${peer.agentName}] ${artifact.name ?? peer.skillId}`,
                metadata: {
                  ...(artifact.metadata ?? {}),
                  delegatedTo: peer.agentId,
                  delegatedAgent: peer.agentName,
                  peerTaskId: peerTask.id,
                },
              });
            }

            const peerState = peerTask.status.state;
            if (peerState === 'completed') {
              this.store.updateStatus(taskId, 'completed', {
                role: 'agent',
                parts: [{
                  type: 'text',
                  text: `✓ Delegated to ${peer.agentName} (${peer.skillId}) — completed`,
                }],
              });
            } else {
              this.store.updateStatus(taskId, 'failed', {
                role: 'agent',
                parts: [{
                  type: 'text',
                  text: `Peer ${peer.agentName} returned state: ${peerState}`,
                }],
              });
            }
          } catch (e) {
            this.store.updateStatus(taskId, 'failed', {
              role: 'agent',
              parts: [{
                type: 'text',
                text: `Peer routing to ${peer.agentName} failed: ${(e as Error).message}`,
              }],
            });
          }
          return;
        }
      }

      this.store.updateStatus(taskId, 'failed', {
        role: 'agent',
        parts: [{
          type: 'text',
          text: `Could not resolve a skill command from: "${text}".\n` +
                `This agent supports: ${card.skills.map(s => s.id).join(', ')}\n` +
                `Try: "skill.command" or "skill.command key=value"`,
        }],
      });
      return;
    }

    try {
      const result = await this.executeSkill(resolved.command, resolved.params);

      this.store.addArtifact(taskId, {
        name: resolved.command,
        description: `Result of executing ${resolved.command}`,
        parts: [
          {
            type: 'data',
            data: {
              command: resolved.command,
              params: resolved.params,
              result,
              agentId,
            },
          },
          {
            type: 'text',
            text: typeof result === 'string'
              ? result
              : JSON.stringify(result, null, 2),
          },
        ],
        index: 0,
        lastChunk: true,
      });

      this.store.updateStatus(taskId, 'completed', {
        role: 'agent',
        parts: [{ type: 'text', text: `✓ Completed: ${resolved.command}` }],
      });
    } catch (e) {
      this.store.updateStatus(taskId, 'failed', {
        role: 'agent',
        parts: [{
          type: 'text',
          text: `Skill execution failed: ${(e as Error).message}`,
        }],
      });
    }
  }

  /**
   * Resolve a skill command and params from a text string.
   *
   * Supported formats:
   *   "docker.list"
   *   "docker.list host=server1"
   *   "docker.list {"host":"server1"}"
   *   "incident.create title=Disk full severity=high"
   *
   * Fuzzy match (experimental):
   *   "list running containers" → docker.list (if agent has docker skill)
   */
  private _resolveCommand(
    text: string,
    agentSkillIds: string[],
  ): { command: string | null; params: Record<string, unknown> } {
    const trimmed = text.trim();

    // Pattern 1: direct command — skill.command [args]
    const directMatch = trimmed.match(/^([a-z][a-z0-9-]*\.[a-z][a-z0-9_.-]*)(.*)$/i);
    if (directMatch) {
      const command = directMatch[1].toLowerCase();
      const rawArgs = (directMatch[2] ?? '').trim();
      return { command, params: this._parseArgs(rawArgs) };
    }

    // Pattern 2: fuzzy keyword match against agent skills
    const lower = trimmed.toLowerCase();
    const commandMeta = this._buildCommandMeta(agentSkillIds);
    let bestScore = 0;
    let bestCommand: string | null = null;

    for (const meta of commandMeta) {
      let score = 0;
      for (const kw of meta.keywords) {
        if (lower.includes(kw)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestCommand = meta.command;
      }
    }

    // Only accept fuzzy match if at least 2 keywords matched
    if (bestScore >= 2 && bestCommand) {
      return { command: bestCommand, params: this._parseArgs(trimmed) };
    }

    return { command: null, params: {} };
  }

  /** Build keyword metadata for fuzzy matching against skill IDs */
  private _buildCommandMeta(skillIds: string[]): CommandMeta[] {
    return skillIds.map(skillId => {
      const parts = skillId.split('.');
      return {
        command: skillId,
        keywords: parts.flatMap(p => [p, ...p.split(/[-_]/g)]),
      };
    });
  }

  /** Parse raw argument string into a params object */
  private _parseArgs(raw: string): Record<string, unknown> {
    if (!raw) return {};

    // JSON object
    const jsonStart = raw.indexOf('{');
    if (jsonStart !== -1) {
      try {
        return JSON.parse(raw.slice(jsonStart)) as Record<string, unknown>;
      } catch { /* fall through */ }
    }

    // key=value pairs (supports quoted values)
    const params: Record<string, unknown> = {};
    const pairRe = /(\w+)=(?:"([^"]*)"|([\S]*))/g;
    let match: RegExpExecArray | null;
    while ((match = pairRe.exec(raw)) !== null) {
      params[match[1]] = match[2] ?? match[3] ?? '';
    }

    // Bare text → treat as query/message param
    if (Object.keys(params).length === 0 && raw.trim()) {
      params.query = raw.trim();
    }

    return params;
  }
}
