// Types for the Skill Crystallization system.
//
// A "crystallized skill" is a reusable WorkflowDef the platform
// learned by watching an agent succeed at a multi-step task. The
// learning pipeline is:
//
//   resolution + reflection      ResolutionAnalyzer (score + safety)
//   ─────────────────────────►   SkillCrystallizer (generalize)
//                                ─────────────────────────►   draft skill
//                                                              │
//                              AutoPromotion (lifecycle)        ▼
//                              ─────────────────────────►  approved → active
//
// Every record is auditable: source_resolution_id and
// source_agent_id link back to where the skill came from, and
// usage_count + success_rate track how it actually performs once
// promoted.

/** Lifecycle states. Movement is enforced by AutoPromotion + the
 *  approve / reject endpoints; nothing else should mutate `status`
 *  directly. */
export type CrystallizedSkillStatus = 'draft' | 'approved' | 'active' | 'rejected';

/** A parameter slot the crystallizer extracted from the source
 *  resolution. The runtime passes a value for each slot when the
 *  generated workflow is invoked. */
export interface CrystallizedParameter {
  /** Slot name as it appears in the workflow body (e.g. "hostname"). */
  name: string;
  /** Coarse type used for input validation + dashboard hints. */
  type: 'string' | 'number' | 'boolean';
  /** Free-form note about what this parameter represents. */
  description?: string;
  /** Sample value pulled from the source resolution. Useful for the
   *  approval-review UI; not used at runtime. */
  example?: string;
}

/** What we record per usage so AutoPromotion has a window of
 *  outcomes to make demotion decisions on. Append-only. */
export interface CrystallizedSkillUsage {
  at: string;                  // ISO timestamp
  outcome: 'success' | 'failed';
  durationMs?: number;
  /** Optional free-form reason on failure — operator-readable, not
   *  parsed by the auto-promotion engine. */
  reason?: string;
}

/** Persisted record. Matches the columns in CrystallizedSkillStore. */
export interface CrystallizedSkill {
  id: string;
  /** Tenant scoping — every store call uses the active tenant. */
  tenantId: string;
  name: string;
  description: string;

  /** Resolution + agent that produced this skill. */
  sourceResolutionId: string;
  sourceAgentId: string;

  /** The generated WorkflowDef as a JSON-stringified value. We keep
   *  it stringified at the storage layer so the schema fields stay
   *  versioned with the WorkflowDef contract — the JSON is opaque to
   *  this store. */
  generatedWorkflow: string;

  /** Slots extracted from the source. Decoded on read. */
  parameters: CrystallizedParameter[];

  /** Tags inferred by the analyzer (networking / disk / service / …). */
  tags: string[];

  status: CrystallizedSkillStatus;
  /** 0..1; analyzer's confidence the skill is worth crystallizing.
   *  Used by the auto-promotion engine. */
  confidenceScore: number;

  /** Aggregated counters. Updated atomically by recordUsage(). */
  usageCount: number;
  /** Most recent N outcomes (ring buffer at the application layer);
   *  the analytical "rolling success rate" reads this. */
  recentUsage: CrystallizedSkillUsage[];

  createdAt: string;
  updatedAt: string;
}

// ─── Safety: destructive-command detection ────────────────────────────

/**
 * Patterns we *never* auto-crystallize without manual review. Each
 * regex matches against a normalised lowercased command string. New
 * patterns: add here, document why; tests in
 * SkillCrystallizer.test.ts assert each one is caught.
 */
export const DESTRUCTIVE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'rm -rf',          re: /\brm\s+(-[a-z]*r[a-z]*[fF]?|-[a-z]*[fF][a-z]*r)/i },
  { name: 'dd to disk',      re: /\bdd\s+.*\bof\s*=\s*\/dev\/(sd|nvme|hd|vd|xvd)/i },
  { name: 'mkfs',            re: /\bmkfs(\.|\s)/i },
  { name: 'fdisk format',    re: /\bfdisk\b.*\b(o|d|w)\b/i },
  { name: 'shutdown',        re: /\b(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/i },
  { name: 'sql DROP',        re: /\bDROP\s+(DATABASE|TABLE|SCHEMA|USER)\b/i },
  { name: 'sql TRUNCATE',    re: /\bTRUNCATE\s+TABLE\b/i },
  { name: 'sql DELETE *',    re: /\bDELETE\s+FROM\s+\S+\s*(?:;|$)/i },
  { name: 'kubectl delete',  re: /\bkubectl\s+delete\s+(ns|namespace|deployment|pod)/i },
  { name: 'docker rm -f',    re: /\bdocker\s+rm\s+-[a-z]*f/i },
  { name: 'iptables flush',  re: /\biptables\s+-F\b/i },
  { name: 'chmod 777 /',     re: /\bchmod\s+(777|0?777)\s+\//i },
  { name: 'chown root /',    re: /\bchown\s+root.*\s+\//i },
  { name: 'curl|sh',         re: /\bcurl\s+[^|]+\|\s*(sh|bash|zsh)\b/i },
  { name: 'wget|sh',         re: /\bwget\s+[^|]+\|\s*(sh|bash|zsh)\b/i },
];

/** Return the first destructive pattern that matches `command`, or
 *  undefined when the command is safe. Matching short-circuits so the
 *  caller can include the pattern name in the audit log. */
export function detectDestructive(command: string): { name: string; re: RegExp } | undefined {
  for (const p of DESTRUCTIVE_PATTERNS) if (p.re.test(command)) return p;
  return undefined;
}

// ─── Safety: secret-shaped value detection ────────────────────────────

/**
 * Patterns that *look like* credentials. We use these to mask values
 * before they end up in a stored skill — the original resolution's
 * tokens don't make sense as parameters anyway, and a leaked secret
 * is a much worse failure than losing parameter inference for one
 * token.
 *
 * Matching is intentionally conservative — false positives only cost
 * us a parameter that needs a fresh value at runtime; false negatives
 * could publish a secret to the catalog.
 */
export const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'aws-access-key',     re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'aws-secret',         re: /\b[A-Za-z0-9/+=]{40}\b(?=.*aws|.*secret)/i }, // contextual
  { name: 'github-pat',         re: /\bghp_[A-Za-z0-9]{30,}\b/ },
  { name: 'github-fine-grained',re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'slack-token',        re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'jwt',                re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { name: 'private-key-pem',    re: /-----BEGIN [A-Z ]+PRIVATE KEY-----/ },
  { name: 'bearer-token',       re: /\b(?:Bearer|bearer)\s+[A-Za-z0-9._~+/=-]{16,}\b/ },
  // Catch-all for "<key>=<longish opaque>" pairs. Captures common
  // names so we don't accidentally hash a numeric port or a path.
  { name: 'env-style-secret',   re: /\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/i },
];

export function looksLikeSecret(value: string): { name: string } | undefined {
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(value)) return { name: p.name };
  }
  return undefined;
}

/** Replace any detected secret in `text` with the literal token
 *  "[REDACTED:<pattern-name>]" so the caller can audit *why* a value
 *  was masked. Idempotent. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p.re, `[REDACTED:${p.name}]`);
  }
  return out;
}
