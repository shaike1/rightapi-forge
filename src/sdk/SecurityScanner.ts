// Static checks for code the SDK is about to write to disk.
//
// Generation is deterministic + template-driven (so the patterns we
// emit are well-known shapes), but:
//   - the operator's description can land verbatim in command bodies,
//   - skill specs include shell commands the operator authored,
// so an extra pass before writeFile is cheap insurance.
//
// Severity model:
//   "block" — refuse to proceed unless the operator explicitly
//             autoApprove=true AND the scanner can be told to ignore
//             a given pattern. The default plan-only path surfaces
//             these to the dashboard for review.
//   "warn"  — logged + surfaced in the plan; doesn't gate execution.
//
// The patterns here are intentionally conservative. False positives
// just push something to manual review; false negatives could ship
// rm -rf or eval to disk + the deploy bridge.

import type { FileChange, SecurityFinding } from './SdkTypes.js';

interface PatternDef {
  name: string;
  re: RegExp;
  severity: SecurityFinding['severity'];
  message: string;
}

/** Patterns that always block — these are unsafe regardless of
 *  context. Mirror DESTRUCTIVE_PATTERNS in the crystallization
 *  module's safety set, but tightened for code paths (we look for
 *  the literal token in source, not in a runtime command string). */
const BLOCK_PATTERNS: PatternDef[] = [
  { name: 'eval()',                re: /\beval\s*\(/,
    severity: 'block', message: 'eval() is forbidden in generated code' },
  { name: 'Function constructor',  re: /\bnew\s+Function\s*\(/,
    severity: 'block', message: 'new Function() is forbidden in generated code' },
  { name: 'rm -rf',                re: /\brm\s+-[a-z]*r[a-z]*[fF]?\b/,
    severity: 'block', message: 'recursive force-delete is forbidden' },
  { name: 'dd to disk',             re: /\bdd\s+[^|]*?\bof\s*=\s*\/dev\/(sd|nvme|hd|vd|xvd)/,
    severity: 'block', message: 'dd writes to a block device are forbidden' },
  { name: 'mkfs',                   re: /\bmkfs(\.|\s)/,
    severity: 'block', message: 'mkfs is forbidden in generated code' },
  { name: 'shutdown',               re: /\b(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/,
    severity: 'block', message: 'host shutdown commands are forbidden' },
  { name: 'sql DROP',               re: /\bDROP\s+(DATABASE|TABLE|SCHEMA|USER)\b/i,
    severity: 'block', message: 'DROP statements are forbidden' },
  { name: 'curl|sh',                re: /\bcurl\s+[^|;]+\|\s*(sh|bash|zsh)\b/,
    severity: 'block', message: 'pipe-to-shell network installs are forbidden' },
  { name: 'wget|sh',                re: /\bwget\s+[^|;]+\|\s*(sh|bash|zsh)\b/,
    severity: 'block', message: 'pipe-to-shell network installs are forbidden' },
  { name: 'process.exit',           re: /\bprocess\.exit\s*\(/,
    severity: 'block', message: 'generated code must not terminate the host process' },
  { name: 'fs.rm recursive',        re: /\bfs\.rm(?:Sync)?\s*\([^,]+,\s*\{[^}]*recursive\s*:\s*true/,
    severity: 'block', message: 'recursive filesystem removals are forbidden' },
];

/** require() of an unapproved module. The approved list is the
 *  packages already in package.json that we trust the SDK to import
 *  from generated code. child_process is included because every
 *  generated skill needs it to run shell — the BLOCK_PATTERNS above
 *  still reject the dangerous *invocations* (rm -rf, eval, etc.). */
const APPROVED_REQUIRES = new Set<string>([
  'crypto', 'path', 'url', 'os', 'util', 'events',
  'fs', 'fs/promises',
  'child_process', 'worker_threads', 'stream', 'buffer',
  // Project-internal imports always go through the relative-path or
  // module-barrel route; npm-bare specifiers below.
  'better-sqlite3', 'pg', 'ioredis', 'express', 'node-cron',
  '@xyflow/react', '@monaco-editor/react',
]);

/** Strip the optional "node:" prefix so `node:child_process` resolves
 *  to the same allowlist key as `child_process`. */
function normaliseSpecifier(spec: string): string {
  return spec.startsWith('node:') ? spec.slice(5) : spec;
}

const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const IMPORT_BARE_RE = /^\s*import\s+(?:[^'"]+\s+from\s+)?['"]([^./'"][^'"]*)['"]/gm;

/** Patterns that warn but don't block. Anything an operator might
 *  reasonably want, but we want flagged for review. */
const WARN_PATTERNS: PatternDef[] = [
  { name: 'sudo',           re: /\bsudo\s+/,
    severity: 'warn', message: 'sudo invocation — confirm the deploy host has the right NOPASSWD config' },
  { name: 'kubectl delete', re: /\bkubectl\s+delete\b/,
    severity: 'warn', message: 'kubectl delete — destructive cluster op, double-check the namespace' },
  { name: 'TODO / FIXME',   re: /\b(TODO|FIXME)\b/i,
    severity: 'warn', message: 'TODO/FIXME marker in generated code' },
  { name: 'hard-coded ip',  re: /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/,
    severity: 'warn', message: 'hard-coded IPv4 — consider a parameter' },
];

/** Run the scanner over a single source string. Returns every
 *  finding with line + snippet so the dashboard can highlight. */
export function scanSource(file: string, contents: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = contents.split('\n');

  // Pattern-based block + warn rules.
  for (const def of [...BLOCK_PATTERNS, ...WARN_PATTERNS]) {
    let m: RegExpExecArray | null;
    const re = new RegExp(def.re.source, def.re.flags.includes('g') ? def.re.flags : def.re.flags + 'g');
    while ((m = re.exec(contents))) {
      const line = lineNumberAt(contents, m.index);
      findings.push({
        severity: def.severity,
        pattern: def.name,
        message: def.message,
        file,
        line,
        snippet: lines[line - 1]?.trim().slice(0, 200),
      });
      // Avoid infinite loop on zero-length matches.
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  // require() / import of unapproved modules. Both forms are checked
  // because the SDK can emit either depending on the file template.
  for (const re of [REQUIRE_RE, IMPORT_BARE_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(contents))) {
      const rawSpec = m[1];
      const spec = normaliseSpecifier(rawSpec);
      // Allow scoped + bare specifiers when the *root* package is in
      // the approved list. `@xyflow/react/dist/foo` → "@xyflow/react".
      const root = spec.startsWith('@')
        ? spec.split('/').slice(0, 2).join('/')
        : spec.split('/')[0];
      if (APPROVED_REQUIRES.has(root)) continue;
      const line = lineNumberAt(contents, m.index);
      findings.push({
        severity: 'block',
        pattern: 'unapproved-import',
        message: `import of unapproved module "${rawSpec}" — extend APPROVED_REQUIRES if intentional`,
        file,
        line,
        snippet: lines[line - 1]?.trim().slice(0, 200),
      });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  return findings;
}

/** Convenience: scan a whole FileChange[] and roll the findings up. */
export function scanFiles(changes: FileChange[]): SecurityFinding[] {
  return changes.flatMap(c => scanSource(c.path, c.contents));
}

/** Utility for callers — true when no `severity: 'block'` finding
 *  appears. */
export function hasBlockingFindings(findings: SecurityFinding[]): boolean {
  return findings.some(f => f.severity === 'block');
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
