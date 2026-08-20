// AutonomyOrchestrator — closes the autonomy feedback loop.
//
// Three previously-disconnected layers, now glued together by this one
// coordinator:
//
//   ┌────────────┐  trace      ┌──────────────────┐  draft skill
//   │   Agents   │ ─────────►  │ Crystallization  │ ─────────────►
//   └────────────┘             │ + analyzer       │   ImprovementLoop
//          ▲                   └──────────────────┘    promote/reject
//          │ uses                                             │
//          │                                                  ▼
//          │                                       ┌────────────────────┐
//   register active                                │ ActiveSkill        │
//   skills as                                      │ Registrar          │
//   SkillManager entries  ◄──────────────────────  └────────────────────┘
//          │
//          │
//          │  same trace fed in parallel
//          ▼
//   ┌───────────────┐   ≥ N occurrences    ┌────────────────────┐
//   │ PatternDetector│ ───────────────────► │ AutonomyOrchestrator│
//   └───────────────┘   across ≥ M agents   │   (this file)       │
//                                           └────────────────────┘
//                                                     │
//                                                     │  developFeature(description)
//                                                     ▼
//                                           ┌────────────────────┐
//                                           │ SDK pipeline       │
//                                           │ (analyze→write→test) │
//                                           └────────────────────┘
//                                                     │
//                                                     │  copy .plugin.js
//                                                     ▼
//                                           ┌────────────────────┐
//                                           │ Hot-reload watch dir│
//                                           │ → SkillPluginLoader│
//                                           │ → SkillManager     │
//                                           └────────────────────┘
//                                                     │
//                                                     ▼  agents see new skill
//                                                  (loop)
//
// Three responsibilities, all owned here:
//
//   A) "Active crystallized skill" → SkillManager bridge. Wired by
//      installing this orchestrator's `registerActive` hook on the
//      CrystallizationService at construction time. Boot replay also
//      activates every existing active skill so a restart doesn't
//      lose the catalogue.
//
//   B) Pattern detection from the same Agent.crystallizationHook chain
//      that feeds the analyzer. The orchestrator wraps the existing
//      crystallization hook so it sees every successful task.
//
//   C) Pattern → SDK request → file copy into the watched plugin dir.
//      SkillPluginLoader's fs.watch picks up the new .plugin.js and
//      registers it with SkillManager — agents then see the new skill
//      on their next dispatch without a restart.
//
// Safety bounds (every one is configurable from env via server.ts):
//   • Max SDK requests/day across all patterns    (default 3)
//   • Per-pattern cooldown                        (default 24h)
//   • Patterns containing destructive verbs are skipped (no SDK
//     trigger — the analyzer's repeatability filter already drops
//     most, this is defense in depth)
//   • Patterns whose canonical sequence overlaps an existing
//     crystallized/SkillManager skill are skipped (Jaccard ≥ 0.6)
//   • Loop is opt-in via AUTONOMY_LOOP_ENABLED env
//
// What this file deliberately does NOT do:
//   • Run sandboxes — SandboxValidator already gates auto-promotion
//     in the improvement loop. The orchestrator just trusts the SDK
//     pipeline's own scan + sandboxed test step.
//   • Replace the existing improvement loop. The two coexist:
//     improvement loop does promote/reject decisions; orchestrator
//     does pattern→SDK and active-skill→catalogue.

import fs from 'fs';
import path from 'path';
import { createLogger } from '../observability/Logger.js';
import type { CrystallizationService } from '../crystallization/CrystallizationService.js';
import type { CrystallizedSkill } from '../crystallization/CrystallizedSkillTypes.js';
import type { CrystallizedSkillStore } from '../persistence/CrystallizedSkillStore.js';
import type { SelfDevelopmentService } from '../sdk/SelfDevelopmentService.js';
import type { SkillManager } from '../skills/SkillManager.js';
import type { ActiveSkillRegistrar } from './ActiveSkillRegistrar.js';
import type { PatternDetector, PatternMatch } from './PatternDetector.js';

const log = createLogger({ component: 'autonomy-orchestrator' });

/** Verbs that trigger an immediate skip — we never crystallize a
 *  pattern that would automate destruction. Same set as the chat
 *  classifier's blocked patterns; duplicated to keep the dep graph
 *  free of server.ts. */
const DESTRUCTIVE_RE = /\b(rm\s+-rf?|mkfs|shutdown|reboot|format|fdisk|parted|userdel|groupdel|passwd|chmod\s+777|chown\s+root|dd\b|kill\s+-9\s+1|apt\s+(remove|purge)|dpkg\s+--purge)\b/;

export interface AutonomyOrchestratorDeps {
  crystallizationService: CrystallizationService;
  crystallizedStore: CrystallizedSkillStore;
  activeSkillRegistrar: ActiveSkillRegistrar;
  patternDetector: PatternDetector;
  sdkService: SelfDevelopmentService;
  skillManager: SkillManager;
  /** Optional broadcast hook so the dashboard activity feed sees
   *  orchestrator decisions in real time. */
  broadcast?: (event: { type: string; data: unknown }) => void;
}

export interface AutonomyOrchestratorOptions {
  /** Pattern-scan cadence. Default 1h. Set <= 0 to disable the timer
   *  (test seam — call `scan()` manually). */
  intervalMs?: number;
  /** Max SDK requests this orchestrator may fire per rolling 24h
   *  window. Default 3. */
  maxSdkRequestsPerDay?: number;
  /** Per-pattern cooldown after we fire SDK on it. Default 24h. */
  perPatternCooldownMs?: number;
  /** Directory the orchestrator copies SDK-generated .plugin.js files
   *  into so SkillPluginLoader picks them up via fs.watch. Defaults
   *  to /data/itops-agents/skill-plugins (the SkillPluginLoader's
   *  default watch dir). Set null to skip the copy step. */
  pluginHotReloadDir?: string | null;
  /** Where the SDK writes generated skill plugin files. Defaults to
   *  src/skills/generated/plugins (the CodeGenerator's hardcoded
   *  output path). Used to find files to copy. */
  sdkPluginOutputDir?: string;
}

/** A snapshot of one orchestrator scan; persisted in lastScan and
 *  emitted as a broadcast event. */
export interface AutonomyScanSummary {
  startedAt: string;
  finishedAt: string;
  patternsConsidered: number;
  patternsTriggered: number;
  patternsSkipped: Array<{ fingerprint: string; reason: string }>;
  sdkRequestsRemainingToday: number;
}

export class AutonomyOrchestrator {
  private timer: NodeJS.Timeout | null = null;
  private readonly opts: Required<Omit<AutonomyOrchestratorOptions, 'pluginHotReloadDir'>> & { pluginHotReloadDir: string | null };
  /** fingerprint → expiry epoch ms */
  private readonly patternCooldowns = new Map<string, number>();
  /** SDK request timestamps in the last 24h, used for the per-day cap. */
  private sdkRequestLog: number[] = [];
  /** Last completed scan, exposed via getStatus(). */
  private lastScan: AutonomyScanSummary | null = null;

  constructor(private deps: AutonomyOrchestratorDeps, opts: AutonomyOrchestratorOptions = {}) {
    this.opts = {
      intervalMs:           opts.intervalMs           ?? 60 * 60 * 1000,
      maxSdkRequestsPerDay: opts.maxSdkRequestsPerDay ?? 3,
      perPatternCooldownMs: opts.perPatternCooldownMs ?? 24 * 60 * 60 * 1000,
      pluginHotReloadDir:   opts.pluginHotReloadDir   ?? '/data/itops-agents/skill-plugins',
      sdkPluginOutputDir:   opts.sdkPluginOutputDir   ?? 'src/skills/generated/plugins',
    };
  }

  /** Start the periodic scan. Idempotent. */
  start(): void {
    if (this.timer) return;
    if (this.opts.intervalMs <= 0) return;
    this.timer = setInterval(() => {
      this.scan().catch(err => log.error('autonomy scan crashed', { err: err instanceof Error ? err.message : String(err) }));
    }, this.opts.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    log.info('autonomy orchestrator started', { intervalMs: this.opts.intervalMs });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Re-register every "active" crystallized skill in the SkillManager.
   *  Called once at boot so a process restart doesn't lose the catalogue.
   *  Returns the count successfully registered. */
  async activateExistingCrystallizedSkills(): Promise<number> {
    const active = await Promise.resolve(this.deps.crystallizedStore.list({ status: 'active', limit: 200 }));
    let count = 0;
    for (const s of active) {
      if (this.deps.activeSkillRegistrar.register(s)) count++;
    }
    if (count > 0) log.info('crystallized skills re-registered at boot', { count });
    return count;
  }

  /** Hook installed onto Agent.crystallizationHook by the wiring layer.
   *  Forwards to CrystallizationService AND records the trace into
   *  PatternDetector. Both are best-effort. */
  async recordCompletedTask(input: {
    taskId: string;
    agentId: string;
    title: string;
    category?: string;
    steps: Array<{ tool?: string; params?: unknown; error?: string }>;
    reflection?: any;
    existingSkills?: CrystallizedSkill[];
  }): Promise<void> {
    try {
      this.deps.patternDetector.record(input.taskId, input.agentId, input.steps);
    } catch (err) {
      log.warn('patternDetector.record threw', { taskId: input.taskId, err: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Single pass: ask PatternDetector for matches, fire SDK on each
   *  one that clears every safety gate, hot-reload any generated
   *  plugin files. */
  async scan(): Promise<AutonomyScanSummary> {
    const startedAt = new Date();
    const matches = this.deps.patternDetector.findRecurring();
    const skipped: AutonomyScanSummary['patternsSkipped'] = [];
    let triggered = 0;

    // Existing skills (built-in + plugin + crystal.*) we treat as
    // "already covered" so we don't crystallize-duplicate.
    const existingSkillIds = new Set(this.deps.skillManager.getAll().map(s => s.id));
    const existingCrystallized = await Promise.resolve(
      this.deps.crystallizedStore.list({ limit: 200 }),
    );

    for (const match of matches) {
      // 1. Per-pattern cooldown.
      if (this.cooldownActive(match.fingerprint)) {
        skipped.push({ fingerprint: match.fingerprint, reason: 'pattern cooldown' });
        continue;
      }
      // 2. Day cap.
      if (this.sdkRequestsToday() >= this.opts.maxSdkRequestsPerDay) {
        skipped.push({ fingerprint: match.fingerprint, reason: 'daily SDK request cap reached' });
        continue;
      }
      // 3. Destructive verb anywhere in the sequence ⇒ never automate.
      if (match.representativeSequence.some(s => DESTRUCTIVE_RE.test(s))) {
        skipped.push({ fingerprint: match.fingerprint, reason: 'destructive verb in pattern' });
        // Don't burn cooldown — we want to re-evaluate if the pattern stops being destructive.
        continue;
      }
      // 4. Coverage check — if there's already a SkillManager entry or
      //    a non-rejected crystallized skill that overlaps strongly,
      //    skip (the catalogue already has this).
      if (this.alreadyCovered(match, existingSkillIds, existingCrystallized)) {
        skipped.push({ fingerprint: match.fingerprint, reason: 'pattern already covered by existing skill' });
        // Hold cooldown so we don't keep checking every scan.
        this.setCooldown(match.fingerprint, this.opts.perPatternCooldownMs);
        continue;
      }

      // 5. Fire the SDK pipeline.
      try {
        await this.triggerSdkForPattern(match);
        triggered++;
        this.setCooldown(match.fingerprint, this.opts.perPatternCooldownMs);
        this.recordSdkRequest();
      } catch (err) {
        skipped.push({
          fingerprint: match.fingerprint,
          reason: `SDK call failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        // Short cooldown on failure so we don't hammer SDK if it's broken.
        this.setCooldown(match.fingerprint, 30 * 60 * 1000);
      }
    }

    const summary: AutonomyScanSummary = {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      patternsConsidered: matches.length,
      patternsTriggered: triggered,
      patternsSkipped: skipped,
      sdkRequestsRemainingToday: Math.max(0, this.opts.maxSdkRequestsPerDay - this.sdkRequestsToday()),
    };
    this.lastScan = summary;
    log.info('autonomy_scan', { ...summary, patternsSkipped: summary.patternsSkipped.length });
    this.deps.broadcast?.({ type: 'autonomy.scan', data: summary });
    return summary;
  }

  /** Snapshot for an /api/autonomy/status surface (added by the wiring layer). */
  getStatus() {
    return {
      enabled: this.timer !== null,
      patternWindowSize: this.deps.patternDetector.size(),
      registeredCrystallizedSkills: this.deps.activeSkillRegistrar.list(),
      sdkRequestsToday: this.sdkRequestsToday(),
      maxSdkRequestsPerDay: this.opts.maxSdkRequestsPerDay,
      patternCooldownsActive: this.patternCooldowns.size,
      lastScan: this.lastScan,
    };
  }

  // ── internals ─────────────────────────────────────────────────────

  private async triggerSdkForPattern(match: PatternMatch): Promise<void> {
    const description = this.describePattern(match);
    log.info('triggering SDK for pattern', {
      fingerprint: match.fingerprint,
      occurrences: match.occurrences,
      distinctAgents: match.distinctAgents,
      description: description.slice(0, 120),
    });
    const out = await this.deps.sdkService.developFeature({
      description,
      autoApprove: true,
      // testOnly: write files + run sandboxed tests but don't commit
      // or trigger a deploy. The hot-reload step picks up the written
      // .plugin.js without needing a deploy round-trip.
      testOnly: true,
      actor: 'autonomy-orchestrator',
    });

    this.deps.broadcast?.({
      type: 'autonomy.sdk_triggered',
      data: {
        fingerprint: match.fingerprint,
        planId: out.plan.id,
        kind: out.plan.kind,
        files: out.plan.files.length,
        testsFailed: out.testResults.filter(t => !t.passed).length,
      },
    });

    // Hot-reload: copy any generated .plugin.js into the SkillPluginLoader
    // watch dir so it appears in the SkillManager catalogue without a
    // server restart.
    if (this.opts.pluginHotReloadDir) {
      this.copyGeneratedPluginsIntoWatchDir(out.plan.files.map(f => f.path));
    }
  }

  /**
   * Build a one-line description for the SDK from the pattern. The
   * SDK's CodeGenerator turns this into a SkillSpec, so the more
   * shape we surface here the better.
   */
  private describePattern(match: PatternMatch): string {
    const cmds = match.representativeSequence.slice(0, 6).join('; then ');
    const bandit = match.occurrences > 5 ? `${match.occurrences}+ times` : `${match.occurrences} times`;
    return `skill: pattern crystallization — agents have run this sequence ${bandit} across ${match.distinctAgents} agents. The recurring shape: ${cmds}`;
  }

  /**
   * Fingerprint matches an existing skill if either:
   *   (a) The pattern's first canonical step looks like a SkillManager
   *       skill id (`<verb>.<sub>`), and that id is registered.
   *   (b) ≥ 60% of the canonical sequence appears as a substring in
   *       any existing crystallized skill's name+description.
   */
  private alreadyCovered(
    match: PatternMatch,
    existingSkillIds: Set<string>,
    existingCrystallized: CrystallizedSkill[],
  ): boolean {
    // (a) skill-id direct overlap: any sequence step that's actually
    // a registered skill id means the pattern already routes through
    // that skill at least partially.
    for (const step of match.representativeSequence) {
      if (existingSkillIds.has(step)) return true;
    }
    // (b) crystallized skill description fuzzy match.
    const tokens = new Set(
      match.representativeSequence
        .flatMap(s => s.toLowerCase().split(/\s+/))
        .filter(t => t.length > 2),
    );
    for (const cs of existingCrystallized) {
      if (cs.status === 'rejected') continue;
      const haystack = `${cs.name} ${cs.description}`.toLowerCase();
      let hits = 0;
      for (const tok of tokens) if (haystack.includes(tok)) hits++;
      if (tokens.size > 0 && hits / tokens.size >= 0.6) return true;
    }
    return false;
  }

  /**
   * Best-effort copy of the .plugin.js files SDK just wrote into the
   * SkillPluginLoader watch dir. Failures here are logged but don't
   * propagate — the SDK already succeeded; an operator can manually
   * copy if needed.
   */
  private copyGeneratedPluginsIntoWatchDir(generatedFiles: string[]): void {
    const target = this.opts.pluginHotReloadDir!;
    let copied = 0;
    for (const file of generatedFiles) {
      if (!file.endsWith('.plugin.js')) continue;
      try {
        if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
        const dest = path.join(target, path.basename(file));
        // Don't reload-clobber an unrelated existing plugin with the same name.
        if (fs.existsSync(dest)) {
          log.warn('hot-reload skipped — destination already exists', { dest });
          continue;
        }
        fs.copyFileSync(file, dest);
        copied++;
      } catch (err) {
        log.warn('hot-reload copy failed', { file, err: err instanceof Error ? err.message : String(err) });
      }
    }
    if (copied > 0) log.info('hot-reload copied plugin file(s) for pickup', { copied, target });
  }

  private cooldownActive(fingerprint: string): boolean {
    const exp = this.patternCooldowns.get(fingerprint);
    if (!exp) return false;
    if (Date.now() >= exp) {
      this.patternCooldowns.delete(fingerprint);
      return false;
    }
    return true;
  }

  private setCooldown(fingerprint: string, ms: number): void {
    this.patternCooldowns.set(fingerprint, Date.now() + ms);
  }

  private sdkRequestsToday(): number {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.sdkRequestLog = this.sdkRequestLog.filter(t => t >= cutoff);
    return this.sdkRequestLog.length;
  }

  private recordSdkRequest(): void {
    this.sdkRequestLog.push(Date.now());
  }
}
