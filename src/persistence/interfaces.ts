// Shared store contracts.
//
// SqliteStore and PostgresStore both implement these — StoreFactory hands
// back whichever the operator picked via DB_PROVIDER. Existing call-sites
// that imported the concrete Sqlite classes keep working because those
// classes structurally satisfy these interfaces (no runtime change).
//
// Keeping the type-only contract small and synchronous-or-promise-permitting
// (where the SQL backend differs) lets the rest of the codebase migrate one
// call-site at a time without a flag-day rewrite.

import type { Task } from '../types/index.js';

// Re-export the persisted record shapes so consumers can import them through
// a single module regardless of the backing store.
export type {
  Incident,
  IncidentSeverity,
  IncidentStatus,
  IncidentSource,
  TimelineEntry,
  TimelineEventType,
  ResolutionRecord,
  ResolutionStep,
  ReflectionRecord,
  StoredReflection,
} from './SqliteStore.js';

import type {
  Incident,
  TimelineEntry,
  ResolutionRecord,
  ReflectionRecord,
  StoredReflection,
} from './SqliteStore.js';

// ─── Task store ────────────────────────────────────────────────────────────

export interface TaskStore {
  upsert(task: Task): void | Promise<void>;
  get(id: string): Task | undefined | Promise<Task | undefined>;
  getAll(): Task[] | Promise<Task[]>;
  getByStatus(status: string): Task[] | Promise<Task[]>;
  getByOwner(ownerId: string): Task[] | Promise<Task[]>;
  getByCategory(category: string): Task[] | Promise<Task[]>;
  delete(id: string): void | Promise<void>;
  count(): number | Promise<number>;
  close(): void | Promise<void>;
}

// ─── Incident store ────────────────────────────────────────────────────────

export interface IncidentStore {
  upsert(inc: Incident): void | Promise<void>;
  addTimeline(entry: TimelineEntry): void | Promise<void>;
  get(id: string): Incident | null | Promise<Incident | null>;
  list(filter?: { status?: string; severity?: string; assignedTo?: string }): Incident[] | Promise<Incident[]>;
  search(q: string): string[] | Promise<string[]>;
  getTimeline(incidentId: string): TimelineEntry[] | Promise<TimelineEntry[]>;
  stats(): {
    open: number;
    investigating: number;
    resolved: number;
    avgResolutionMinutes: number;
    slaBreaches: number;
  } | Promise<{
    open: number;
    investigating: number;
    resolved: number;
    avgResolutionMinutes: number;
    slaBreaches: number;
  }>;
  markTicketingSynced(id: string, githubIssueNumber?: number): void | Promise<void>;
  updateGitHubIssueNumber(id: string, issueNumber: number): void | Promise<void>;
  updateJiraKey(id: string, jiraKey: string, jiraUrl: string): void | Promise<void>;
  saveAnalysis(id: string, analysisJson: string): void | Promise<void>;
  purge(opts: { maxAgeDays?: number; keepLatest?: number; statusFilter?: string[]; dryRun?: boolean }): number | Promise<number>;
  close(): void | Promise<void>;
}

// ─── Agent memory store ───────────────────────────────────────────────────

export interface AgentMemoryStore {
  // Facts
  saveFact(agentId: string, fact: string): void | Promise<void>;
  rememberFact(agentId: string, fact: string): void | Promise<void>;
  getFacts(agentId: string): { fact: string; created_at: string }[] | Promise<{ fact: string; created_at: string }[]>;
  listFacts(agentId: string): string[] | Promise<string[]>;
  purgeFacts(opts: { maxAgeDays?: number; dryRun?: boolean }): number | Promise<number>;

  // Resolutions
  storeResolution(
    agentId: string,
    incident: { title: string; severity: string },
    resolution: string,
    runbookUsed?: string
  ): void | Promise<void>;
  recordResolution(input: {
    agentId: string;
    incidentTitle: string;
    incidentSeverity?: string;
    problemDescription?: string;
    stepsTried?: Array<{ tool?: string; params?: unknown; result?: string; thought?: string }>;
    whatWorked?: string;
    resolution: string;
    runbookUsed?: string;
    resolutionTimeMs?: number;
    outcome?: 'success' | 'partial' | 'failed';
  }): string | Promise<string>;
  recallSimilarResolutions(
    agentId: string,
    incidentTitle: string,
    severity: string,
    limit?: number
  ): ResolutionRecord[] | Promise<ResolutionRecord[]>;
  buildIncidentRecallPrompt(
    agentId: string,
    incidentTitle: string,
    severity: string,
    limit?: number
  ): string | Promise<string>;
  listResolutions(agentId: string): ResolutionRecord[] | Promise<ResolutionRecord[]>;

  // Reflections
  storeReflection(reflection: ReflectionRecord): string | Promise<string>;
  getReflections(agentId: string, limit?: number): StoredReflection[] | Promise<StoredReflection[]>;
  getReflectionsByRating(
    agentId: string, minRating?: number, maxRating?: number, limit?: number
  ): StoredReflection[] | Promise<StoredReflection[]>;
  getAverageRating(agentId: string): number | Promise<number>;
  getRelevantLessons(
    agentId: string,
    taskTitle: string,
    opts?: { limit?: number; maxLowRating?: number }
  ): {
    lessons: string[];
    wouldDoDifferently: string[];
    averageRating: number;
    recentTrend: 'improving' | 'declining' | 'stable' | 'insufficient';
    sampleSize: number;
  } | Promise<{
    lessons: string[];
    wouldDoDifferently: string[];
    averageRating: number;
    recentTrend: 'improving' | 'declining' | 'stable' | 'insufficient';
    sampleSize: number;
  }>;
  getPerformanceStats(agentId: string): {
    totalReflections: number;
    averageRating: number;
    trend: 'improving' | 'declining' | 'stable' | 'insufficient';
    ratingDistribution: Record<1 | 2 | 3 | 4 | 5, number>;
    mostEffectiveTools: Array<{ tool: string; usefulCount: number; total: number }>;
    commonFailurePatterns: Array<{ pattern: string; count: number }>;
  } | Promise<{
    totalReflections: number;
    averageRating: number;
    trend: 'improving' | 'declining' | 'stable' | 'insufficient';
    ratingDistribution: Record<1 | 2 | 3 | 4 | 5, number>;
    mostEffectiveTools: Array<{ tool: string; usefulCount: number; total: number }>;
    commonFailurePatterns: Array<{ pattern: string; count: number }>;
  }>;

  // Messages
  saveMessage(agentId: string, role: string, content: string): void | Promise<void>;
  getRecentMessages(agentId: string, limit?: number): { role: string; content: string }[] | Promise<{ role: string; content: string }[]>;
  clearMessages(agentId: string): void | Promise<void>;
  purgeMessages(opts: { maxAgeDays?: number; keepLatestPerAgent?: number; dryRun?: boolean }): number | Promise<number>;

  // Stats
  getMemoryStats(agentId: string): {
    totalFacts: number;
    resolutionPatterns: number;
    lastUpdated: string | null;
  } | Promise<{
    totalFacts: number;
    resolutionPatterns: number;
    lastUpdated: string | null;
  }>;

  // Lifecycle
  clearAll(agentId: string): void | Promise<void>;
  close(): void | Promise<void>;
}
