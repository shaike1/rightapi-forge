/**
 * A2APeerRouter — finds the best agent in the mesh to handle a given message.
 * Phase 3: Agent-calls-Agent (internal mesh)
 * Phase 4: Cross-system federation (external agents included)
 *
 * Scoring strategy (higher = better match):
 *   10 — message contains exact skill ID (e.g. "docker.list")
 *    5 — message contains the skill's base name (e.g. "docker")
 *    1 — message overlaps with skill tags, examples, or name words
 */
import type { A2ASkillCard } from './A2ATypes.js';
import type { AgentCardService } from './AgentCardService.js';
import type { ExternalAgentRegistry } from './ExternalAgentRegistry.js';
import type { NLIntentClassifier } from './NLIntentClassifier.js';

export interface PeerMatch {
  agentId: string;
  agentName: string;
  skillId: string;
  skillName: string;
  score: number;
  /** True if this agent lives on an external system */
  isExternal: boolean;
  /** For external agents: the full task endpoint URL from their card */
  taskEndpoint?: string;
}

export class A2APeerRouter {
  private externalRegistry?: ExternalAgentRegistry;
  private nlClassifier?: NLIntentClassifier;

  constructor(private readonly cardService: AgentCardService) {}

  /** Optionally attach the external agent registry (Phase 4) */
  setExternalRegistry(registry: ExternalAgentRegistry): void {
    this.externalRegistry = registry;
  }

  /** Optionally attach the NL intent classifier for natural-language routing */
  setNLClassifier(classifier: NLIntentClassifier): void {
    this.nlClassifier = classifier;
  }

  /**
   * Find the best agent (other than the caller) to handle a message.
   * Checks both internal mesh agents and registered external agents.
   * Returns null when no agent scores above zero.
   */
  findBestPeer(message: string, excludeAgentId: string): PeerMatch | null {
    const all = this.findAllPeers(message, excludeAgentId);
    return all.length > 0 ? all[0] : null;
  }

  /**
   * Return ALL agents (other than the caller) that could handle a message,
   * sorted best-first. Includes both internal and external agents.
   * When keyword scoring finds no matches, falls back to NL classification if available.
   */
  async findAllPeersAsync(message: string, excludeAgentId: string): Promise<PeerMatch[]> {
    const keyword = this.findAllPeers(message, excludeAgentId);
    if (keyword.length > 0) return keyword;
    if (!this.nlClassifier) return [];

    // Build flat skill catalogue across all agents
    const catalogue: Array<{ agentId: string; agentName: string; skill: import('./A2ATypes.js').A2ASkillCard }> = [];
    for (const card of this.cardService.getAllAgentCards()) {
      const agentId = card.metadata?.agentId as string | undefined;
      if (!agentId || agentId === excludeAgentId) continue;
      for (const skill of card.skills) {
        catalogue.push({ agentId, agentName: card.name, skill });
      }
    }
    if (this.externalRegistry) {
      for (const record of this.externalRegistry.list()) {
        if (record.id === excludeAgentId) continue;
        for (const skill of (record.card.skills ?? [])) {
          catalogue.push({ agentId: record.id, agentName: `[ext] ${record.card.name}`, skill });
        }
      }
    }

    const nlResults = await this.nlClassifier.classify(message, catalogue);
    const confidenceScore = { high: 8, medium: 4, low: 2 } as const;

    return nlResults.map(r => {
      const entry = catalogue.find(c => c.agentId === r.agentId && c.skill.id === r.skillId);
      const isExt = entry ? this._isExternal(entry.agentId) : false;
      const taskEndpoint = isExt
        ? this.externalRegistry?.get(r.agentId)?.card.url
        : undefined;
      return {
        agentId: r.agentId,
        agentName: entry?.agentName ?? r.agentId,
        skillId: r.skillId,
        skillName: entry?.skill.name ?? r.skillId,
        score: confidenceScore[r.confidence],
        isExternal: isExt,
        taskEndpoint,
        nlReasoning: r.reasoning,
      } as PeerMatch & { nlReasoning?: string };
    });
  }

  private _isExternal(agentId: string): boolean {
    if (!this.externalRegistry) return false;
    return this.externalRegistry.list().some(r => r.id === agentId);
  }

  /**
   * Return ALL agents (other than the caller) that could handle a message,
   * sorted best-first. Includes both internal and external agents.
   */
  findAllPeers(message: string, excludeAgentId: string): PeerMatch[] {
    const lower = message.toLowerCase();
    const results: PeerMatch[] = [];

    // ── Internal agents ────────────────────────────────────────────
    for (const card of this.cardService.getAllAgentCards()) {
      const agentId = card.metadata?.agentId as string | undefined;
      if (!agentId || agentId === excludeAgentId) continue;

      let best: { skillId: string; skillName: string; score: number } | null = null;
      for (const skill of card.skills) {
        const score = this._scoreSkill(skill, lower);
        if (score > 0 && (!best || score > best.score)) {
          best = { skillId: skill.id, skillName: skill.name, score };
        }
      }
      if (best) {
        results.push({
          agentId,
          agentName: card.name,
          skillId: best.skillId,
          skillName: best.skillName,
          score: best.score,
          isExternal: false,
        });
      }
    }

    // ── External agents (Phase 4) ──────────────────────────────────
    if (this.externalRegistry) {
      for (const record of this.externalRegistry.list()) {
        if (record.id === excludeAgentId) continue;
        const card = record.card;

        let best: { skillId: string; skillName: string; score: number } | null = null;
        for (const skill of (card.skills ?? [])) {
          const score = this._scoreSkill(skill, lower);
          if (score > 0 && (!best || score > best.score)) {
            best = { skillId: skill.id, skillName: skill.name, score };
          }
        }
        if (best) {
          results.push({
            agentId: record.id,
            agentName: `[ext] ${card.name}`,
            skillId: best.skillId,
            skillName: best.skillName,
            score: best.score,
            isExternal: true,
            taskEndpoint: card.url,
          });
        }
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  private _scoreSkill(skill: A2ASkillCard, lowerMessage: string): number {
    // Exact skill ID match
    if (lowerMessage.includes(skill.id.toLowerCase())) return 10;

    // Skill base name match (e.g. "docker" from "docker.list")
    const base = skill.id.split('.')[0].toLowerCase();
    if (base && lowerMessage.includes(base)) return 5;

    // Keyword overlap from skill metadata
    const keywords = [
      skill.name,
      ...(skill.tags ?? []),
      ...(skill.examples ?? []),
    ]
      .join(' ')
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 3);

    let score = 0;
    for (const kw of keywords) {
      if (lowerMessage.includes(kw)) score++;
    }
    return score;
  }
}
