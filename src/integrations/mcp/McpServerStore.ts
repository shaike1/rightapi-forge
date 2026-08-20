// Persistent store for MCP-client server definitions. JSON-on-disk to match
// the rest of the lightweight integration config (see TeamsConfigStore,
// integrationsApi, etc.). The file is rewritten in full on every change —
// the dataset is tiny and atomic-ish writes via mkdir+writeFile keep it
// simple.

import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger.js';
import type { McpServerDef } from './types.js';

const DEFAULT_PATH = process.env.MCP_CLIENTS_CONFIG_PATH
  || '/data/itops-agents/mcp-clients.json';

interface FileShape {
  servers: McpServerDef[];
}

export class McpServerStore {
  private servers = new Map<string, McpServerDef>();

  constructor(private readonly filePath: string = DEFAULT_PATH) {
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as FileShape;
      const list = Array.isArray(parsed?.servers) ? parsed.servers : [];
      for (const def of list) {
        if (def?.id && def?.transport) this.servers.set(def.id, def);
      }
      logger.info('[McpServerStore] loaded servers from disk', {
        path: this.filePath, count: this.servers.size,
      });
    } catch (e) {
      logger.error('[McpServerStore] failed to load store; starting empty', {
        path: this.filePath,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const out: FileShape = { servers: Array.from(this.servers.values()) };
      fs.writeFileSync(this.filePath, JSON.stringify(out, null, 2));
    } catch (e) {
      logger.error('[McpServerStore] persist failed', {
        path: this.filePath,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  list(): McpServerDef[] {
    return Array.from(this.servers.values());
  }

  get(id: string): McpServerDef | undefined {
    return this.servers.get(id);
  }

  upsert(def: McpServerDef): void {
    this.servers.set(def.id, def);
    this.persist();
  }

  delete(id: string): boolean {
    const had = this.servers.delete(id);
    if (had) this.persist();
    return had;
  }
}
