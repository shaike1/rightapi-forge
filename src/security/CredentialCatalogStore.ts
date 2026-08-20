import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface CredentialCatalogEntry {
  id: string;
  name: string;
  agentId: string;
  environment: string;
  system: string;
  scope: string;
  description?: string;
  tags: string[];
  active: boolean;
  disabledAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface CredentialCatalogFile {
  version: number;
  entries: CredentialCatalogEntry[];
}

interface CredentialCatalogCreateInput {
  name: string;
  agentId: string;
  environment: string;
  system: string;
  scope: string;
  description?: string;
  tags?: string[];
  active?: boolean;
}

interface CredentialCatalogUpdateInput {
  name?: string;
  agentId?: string;
  environment?: string;
  system?: string;
  scope?: string;
  description?: string;
  tags?: string[];
  active?: boolean;
}

function normalizeString(value: unknown): string {
  return String(value || '').trim();
}

function normalizeTags(tags?: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags || []) {
    const normalized = normalizeString(raw).toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export class CredentialCatalogStore {
  private filePath: string;
  private entries: Map<string, CredentialCatalogEntry> = new Map();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  list(filters?: { agentId?: string; environment?: string; system?: string; scope?: string; active?: boolean; q?: string }): CredentialCatalogEntry[] {
    const query = normalizeString(filters?.q).toLowerCase();
    return Array.from(this.entries.values())
      .filter(entry => !filters?.agentId || entry.agentId === filters.agentId)
      .filter(entry => !filters?.environment || entry.environment === filters.environment)
      .filter(entry => !filters?.system || entry.system === filters.system)
      .filter(entry => !filters?.scope || entry.scope === filters.scope)
      .filter(entry => filters?.active === undefined || entry.active === filters.active)
      .filter(entry => {
        if (!query) return true;
        return [entry.name, entry.agentId, entry.environment, entry.system, entry.scope, entry.description || '', ...entry.tags]
          .join(' ')
          .toLowerCase()
          .includes(query);
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  create(input: CredentialCatalogCreateInput): CredentialCatalogEntry {
    const now = new Date().toISOString();
    const entry: CredentialCatalogEntry = {
      id: crypto.randomUUID(),
      name: normalizeString(input.name),
      agentId: normalizeString(input.agentId),
      environment: normalizeString(input.environment),
      system: normalizeString(input.system),
      scope: normalizeString(input.scope),
      description: normalizeString(input.description) || undefined,
      tags: normalizeTags(input.tags),
      active: input.active !== false,
      disabledAt: input.active === false ? now : undefined,
      createdAt: now,
      updatedAt: now
    };
    this.validate(entry);
    this.entries.set(entry.id, entry);
    this.save();
    return entry;
  }

  update(id: string, partial: CredentialCatalogUpdateInput): CredentialCatalogEntry | null {
    const existing = this.entries.get(id);
    if (!existing) return null;
    const now = new Date().toISOString();
    const active = partial.active === undefined ? existing.active : Boolean(partial.active);
    const updated: CredentialCatalogEntry = {
      ...existing,
      name: partial.name !== undefined ? normalizeString(partial.name) : existing.name,
      agentId: partial.agentId !== undefined ? normalizeString(partial.agentId) : existing.agentId,
      environment: partial.environment !== undefined ? normalizeString(partial.environment) : existing.environment,
      system: partial.system !== undefined ? normalizeString(partial.system) : existing.system,
      scope: partial.scope !== undefined ? normalizeString(partial.scope) : existing.scope,
      description: partial.description !== undefined ? normalizeString(partial.description) || undefined : existing.description,
      tags: partial.tags !== undefined ? normalizeTags(partial.tags) : existing.tags,
      active,
      disabledAt: active ? undefined : (existing.disabledAt || now),
      updatedAt: now
    };
    this.validate(updated);
    this.entries.set(id, updated);
    this.save();
    return updated;
  }

  delete(id: string, softDelete: boolean = true): boolean {
    if (softDelete) {
      const existing = this.entries.get(id);
      if (!existing) return false;
      if (!existing.active) return true;
      this.entries.set(id, {
        ...existing,
        active: false,
        disabledAt: existing.disabledAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      this.save();
      return true;
    }
    const removed = this.entries.delete(id);
    if (removed) this.save();
    return removed;
  }

  private validate(entry: CredentialCatalogEntry): void {
    if (!entry.name || !entry.agentId || !entry.environment || !entry.system || !entry.scope) {
      throw new Error('name, agentId, environment, system, and scope are required');
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as CredentialCatalogFile;
      for (const entry of parsed.entries || []) {
        if (!entry?.id) continue;
        this.entries.set(entry.id, {
          ...entry,
          tags: normalizeTags(entry.tags),
          active: entry.active !== false
        });
      }
    } catch {
      this.entries.clear();
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: CredentialCatalogFile = {
      version: 1,
      entries: Array.from(this.entries.values())
    };
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
  }
}
