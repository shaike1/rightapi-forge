/**
 * ExternalAgentRegistry — stores A2A agent cards from external systems.
 * Phase 4: Cross-system federation
 *
 * External agents are registered by providing their well-known URL
 * (e.g. https://other-platform.com/.well-known/agent.json).
 * The card is fetched, validated, and persisted locally so the peer
 * router can include them in task routing decisions.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { A2AAgentCard } from './A2ATypes.js';
import { logger } from '../utils/logger.js';

/** Auth configuration for calling an external agent's task endpoint */
export interface ExternalAgentAuthConfig {
  /** 'bearer' sends Authorization: Bearer <token>
   *  'apikey' sends a custom header (defaults to X-Api-Key) */
  type: 'bearer' | 'apikey' | 'none';
  token?: string;
  /** Custom header name when type = 'apikey'. Defaults to 'X-Api-Key' */
  header?: string;
}

export interface ExternalAgentRecord {
  /** Unique ID derived from the card (card.metadata.agentId or slugified name) */
  id: string;
  /** URL used to fetch the card (well-known endpoint or direct card URL) */
  registrationUrl: string;
  /** The full A2A agent card fetched from the remote system */
  card: A2AAgentCard;
  /** Optional auth config for calling this agent's task endpoint */
  authConfig?: ExternalAgentAuthConfig;
  /** When this record was registered */
  registeredAt: string;
  /** When the card was last successfully refreshed */
  lastRefreshedAt: string;
}

export class ExternalAgentRegistry {
  private agents = new Map<string, ExternalAgentRecord>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  /**
   * Register an external agent by fetching its A2A card from the given URL.
   * Accepts both:
   *   - well-known URLs:  https://host/.well-known/agent.json
   *   - direct card URLs: https://host/a2a/agents/:id
   *
   * Optionally supply an authConfig to use when calling this agent's task endpoint.
   * Returns the created record.
   * Throws if the URL is unreachable or does not return a valid A2A card.
   */
  async register(url: string, authConfig?: ExternalAgentAuthConfig): Promise<ExternalAgentRecord> {
    const card = await this._fetchCard(url);
    const id = this._deriveId(card);

    const existing = this.agents.get(id);
    const record: ExternalAgentRecord = {
      id,
      registrationUrl: url,
      card,
      authConfig: authConfig ?? existing?.authConfig,
      registeredAt: existing?.registeredAt ?? new Date().toISOString(),
      lastRefreshedAt: new Date().toISOString(),
    };

    this.agents.set(id, record);
    this.save();
    logger.info(`[ExternalAgentRegistry] Registered external agent: ${card.name} (${id})`);
    return record;
  }

  /**
   * Re-fetch the card for an already-registered agent.
   * Useful for picking up updated skills / metadata.
   */
  async refresh(id: string): Promise<ExternalAgentRecord> {
    const record = this.agents.get(id);
    if (!record) throw new Error(`External agent "${id}" not registered`);
    return this.register(record.registrationUrl);
  }

  unregister(id: string): boolean {
    const existed = this.agents.delete(id);
    if (existed) {
      this.save();
      logger.info(`[ExternalAgentRegistry] Unregistered external agent: ${id}`);
    }
    return existed;
  }

  get(id: string): ExternalAgentRecord | undefined {
    return this.agents.get(id);
  }

  list(): ExternalAgentRecord[] {
    return Array.from(this.agents.values());
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  /**
   * Update the auth configuration for a registered external agent.
   * Use this to add/change API keys or Bearer tokens after initial registration.
   */
  updateAuth(id: string, authConfig: ExternalAgentAuthConfig): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    record.authConfig = authConfig;
    this.save();
    return true;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async _fetchCard(url: string): Promise<A2AAgentCard> {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new Error(`Could not reach ${url}: ${(e as Error).message}`);
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Non-JSON response from ${url}`);
    }

    // If this is a system card (has `.agents` array), extract the first agent card
    // or treat the system card itself as the card.
    const card = data as A2AAgentCard & { agents?: A2AAgentCard[] };

    if (!card.name || !card.url) {
      throw new Error(`Response from ${url} is not a valid A2A agent card (missing name or url)`);
    }

    return card;
  }

  private _deriveId(card: A2AAgentCard): string {
    // Prefer explicit agentId in metadata
    if (card.metadata?.agentId && typeof card.metadata.agentId === 'string') {
      return card.metadata.agentId;
    }
    // Fall back to slugified name + provider
    const slug = (card.name + '-' + (card.provider?.organization ?? 'ext'))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    return slug;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as ExternalAgentRecord[];
      raw.forEach(r => this.agents.set(r.id, r));
      logger.info(`[ExternalAgentRegistry] Loaded ${this.agents.size} external agent(s)`);
    } catch {
      logger.warn(`[ExternalAgentRegistry] Could not load ${this.filePath} — starting fresh`);
    }
  }

  private save(): void {
    try {
      writeFileSync(
        this.filePath,
        JSON.stringify(Array.from(this.agents.values()), null, 2),
      );
    } catch (e) {
      logger.warn(`[ExternalAgentRegistry] Failed to persist: ${(e as Error).message}`);
    }
  }
}
