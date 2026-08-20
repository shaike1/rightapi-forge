// RunbookLibrary — index over the bundled .workflow.json files in
// src/runbooks/library/ that ship with the platform.
//
// Why a dedicated class instead of just dumping the files into the
// existing WorkflowRegistry: the library is a curated, versioned set
// of platform-supplied runbooks. Operators may also register their
// own one-off workflows via the registry's loadOne() / WORKFLOW_DIR
// path; conflating the two would make it harder to:
//   - tell library content apart from operator content,
//   - ship updates to the library without touching operator state,
//   - search/filter by tag or category (operator workflows often
//     don't have tags — the library always does).
//
// On startup the library scans its own directory, parses each file
// into a WorkflowDef via the validator, and registers each one with
// the supplied registry so /api/workflows/json/:id/run can execute
// them. The originals stay on disk; the registry holds the validated
// in-memory copy.

import fs from 'fs';
import path from 'path';
import url from 'url';
import { createLogger } from '../observability/Logger.js';
import {
  validateWorkflowDef,
  type WorkflowDef,
  type WorkflowRegistry,
  type ValidationError,
} from '../workflows/index.js';

const log = createLogger({ component: 'runbook-library' });

export interface LibraryRunbook {
  /** Workflow id — matches WorkflowDef.id ("library.<name>"). */
  id: string;
  name: string;
  description: string;
  version: string;
  tags: string[];
  steps: number;
  /** Source file path on disk — surfaced for /api/runbooks for ops
   *  observability. */
  filePath: string;
  /** The validated, ready-to-run workflow definition. */
  workflow: WorkflowDef;
}

export interface LibraryLoadFailure {
  filePath: string;
  errors: ValidationError[] | string;
}

export interface RunbookLibraryOptions {
  /** Directory to scan. Defaults to the bundled library shipped next
   *  to this file. Override for tests / alternate libraries. */
  libraryDir?: string;
  /** Filename suffix (default ".workflow.json"). */
  suffix?: string;
}

/**
 * Library of platform-supplied runbooks. Construct, then call
 * `loadAll(registry)` to register each runbook with the
 * WorkflowRegistry so the run + validate endpoints can dispatch them.
 */
export class RunbookLibrary {
  private readonly libraryDir: string;
  private readonly suffix: string;
  private readonly byId: Map<string, LibraryRunbook> = new Map();
  private readonly failures: LibraryLoadFailure[] = [];

  constructor(opts: RunbookLibraryOptions = {}) {
    this.libraryDir = opts.libraryDir ?? defaultLibraryDir();
    this.suffix     = opts.suffix     ?? '.workflow.json';
  }

  /** Scan the library directory, validate each file, and register
   *  successful loads with `registry`. Returns counts so the wiring
   *  layer can surface them in startup logs. */
  loadAll(registry: WorkflowRegistry): { loaded: number; failed: number } {
    if (!fs.existsSync(this.libraryDir)) {
      log.warn('runbook library directory missing — skipping', { libraryDir: this.libraryDir });
      return { loaded: 0, failed: 0 };
    }
    this.byId.clear();
    this.failures.length = 0;
    let loaded = 0, failed = 0;
    for (const entry of fs.readdirSync(this.libraryDir)) {
      if (!entry.endsWith(this.suffix)) continue;
      const full = path.join(this.libraryDir, entry);
      const ok = this.loadOne(full, registry);
      if (ok) loaded++; else failed++;
    }
    log.info('runbook library scan complete', { libraryDir: this.libraryDir, loaded, failed });
    return { loaded, failed };
  }

  /** Validate-and-register one file. */
  loadOne(filePath: string, registry: WorkflowRegistry): boolean {
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.failures.push({ filePath, errors: msg });
      log.warn('runbook parse failed', { filePath, err: msg });
      return false;
    }
    const v = validateWorkflowDef(parsed);
    if (!v.ok) {
      this.failures.push({ filePath, errors: v.errors });
      log.warn('runbook validation failed', { filePath, errors: v.errors });
      return false;
    }
    const wf = v.workflow!;
    registry.registerFromObject(wf);
    this.byId.set(wf.id, {
      id:           wf.id,
      name:         wf.name,
      description:  wf.description ?? '',
      version:      wf.version,
      tags:         wf.tags ?? [],
      steps:        wf.steps.length,
      filePath,
      workflow:     wf,
    });
    return true;
  }

  /** Return every loaded runbook. Order is stable (sorted by id) so
   *  the API response is deterministic. */
  list(): LibraryRunbook[] {
    return Array.from(this.byId.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Lookup by workflow id. */
  get(id: string): LibraryRunbook | undefined {
    return this.byId.get(id);
  }

  /** Filter by tag — exact match, case-insensitive. */
  byTag(tag: string): LibraryRunbook[] {
    const t = tag.toLowerCase();
    return this.list().filter(r => r.tags.some(x => x.toLowerCase() === t));
  }

  /** Free-text search across id / name / description / tags. The
   *  match is substring, lowercase. Designed for an operator search
   *  box; not a full-text engine. */
  search(query: string): LibraryRunbook[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.list();
    return this.list().filter(r =>
      r.id.toLowerCase().includes(q)
      || r.name.toLowerCase().includes(q)
      || r.description.toLowerCase().includes(q)
      || r.tags.some(t => t.toLowerCase().includes(q)),
    );
  }

  /** Distinct tag set across the library — drives the /api/runbooks/tags
   *  list and the dashboard's filter chip row. */
  allTags(): string[] {
    const set = new Set<string>();
    for (const r of this.byId.values()) for (const t of r.tags) set.add(t);
    return Array.from(set).sort();
  }

  /** Last-N validation failures for the diagnostics endpoint. */
  recentFailures(): LibraryLoadFailure[] {
    return this.failures.slice(-50);
  }
}

/** Resolve the bundled library directory regardless of whether we're
 *  running from source (src/runbooks/library) or from the build output
 *  (dist/runbooks/library). Esbuild ships .json files alongside the
 *  compiled .js, so the relative path holds in both layouts. */
function defaultLibraryDir(): string {
  const here = url.fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), 'library');
}
