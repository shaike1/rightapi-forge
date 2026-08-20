/**
 * LetThemTalkBridge
 * Manages the .agent-bridge/ shared filesystem for ACP worker coordination.
 * Compatible with the let-them-talk MCP server (github.com/Dekelelz/let-them-talk).
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

export const AGENT_BRIDGE_DIR =
  process.env.AGENT_BRIDGE_DIR || '/data/itops-agents/agent-bridge';

export interface BridgeMessage {
  id?: string;
  from?: string;
  to?: string;
  content?: string;
  type?: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface BridgeAgent {
  id?: string;
  name?: string;
  status?: string;
  registeredAt?: string;
  [key: string]: unknown;
}

export interface BridgeTask {
  id?: string;
  title?: string;
  status?: string;
  assignedTo?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export class LetThemTalkBridge {
  private bridgeDir: string;

  constructor(bridgeDir: string = AGENT_BRIDGE_DIR) {
    this.bridgeDir = bridgeDir;
  }

  /** Ensure bridge directory and required files exist */
  init(): void {
    fs.mkdirSync(this.bridgeDir, { recursive: true });
    const required = ['messages.jsonl', 'history.jsonl', 'agents.json', 'tasks.json'];
    for (const file of required) {
      const filePath = path.join(this.bridgeDir, file);
      if (!fs.existsSync(filePath)) {
        const content = file.endsWith('.json') ? '{}' : '';
        fs.writeFileSync(filePath, content, 'utf8');
        logger.info(`LetThemTalkBridge: created ${file}`);
      }
    }
    fs.mkdirSync(path.join(this.bridgeDir, 'workspaces'), { recursive: true });
    logger.info(`LetThemTalkBridge: initialized at ${this.bridgeDir}`);
  }

  /** Read last N messages from messages.jsonl */
  readMessages(limit = 100): BridgeMessage[] {
    return this._readJsonl(path.join(this.bridgeDir, 'messages.jsonl'), limit);
  }

  /** Read last N entries from history.jsonl */
  readHistory(limit = 50): BridgeMessage[] {
    return this._readJsonl(path.join(this.bridgeDir, 'history.jsonl'), limit);
  }

  /** Read agents registry */
  readAgents(): BridgeAgent[] {
    const raw = this._readJson(path.join(this.bridgeDir, 'agents.json'));
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') return Object.values(raw as object);
    return [];
  }

  /** Read tasks */
  readTasks(): BridgeTask[] {
    const raw = this._readJson(path.join(this.bridgeDir, 'tasks.json'));
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') return Object.values(raw as object);
    return [];
  }

  /** Get bridge directory status */
  status(): { initialized: boolean; dir: string; files: Record<string, number> } {
    const files: Record<string, number> = {};
    const names = ['messages.jsonl', 'history.jsonl', 'agents.json', 'tasks.json'];
    let initialized = false;
    try {
      initialized = fs.existsSync(this.bridgeDir);
      for (const name of names) {
        const p = path.join(this.bridgeDir, name);
        files[name] = fs.existsSync(p) ? fs.statSync(p).size : -1;
      }
    } catch (_) { /* ignore */ }
    return { initialized, dir: this.bridgeDir, files };
  }

  /**
   * Generate the .mcp.json config for an ACP worker to connect via let-them-talk.
   */
  getMcpConfig(agentName: string): object {
    return {
      mcpServers: {
        'let-them-talk': {
          command: 'npx',
          args: ['let-them-talk', 'server'],
          env: {
            AGENT_BRIDGE_DIR: this.bridgeDir,
            AGENT_NAME: agentName,
          },
        },
      },
    };
  }

  private _readJsonl(filePath: string, limit: number): BridgeMessage[] {
    if (!fs.existsSync(filePath)) return [];
    try {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
      return lines
        .slice(-limit)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter((x): x is BridgeMessage => x !== null);
    } catch (err) {
      logger.warn(`LetThemTalkBridge: failed to read ${filePath}: ${err}`);
      return [];
    }
  }

  private _readJson(filePath: string): unknown {
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      logger.warn(`LetThemTalkBridge: failed to parse ${filePath}: ${err}`);
      return null;
    }
  }
}
