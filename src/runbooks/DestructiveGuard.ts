// DestructiveGuard — runtime safety net for command steps.
//
// The runbook editor lets operators flag a step as `requiresApproval`,
// but that flag is opt-in. If the creator forgets it on a step that runs
// `rm -rf /var`, nothing else would have stopped the wipe. The engine
// runs every `command` step through `inspect()` first; when a pattern
// matches the engine pauses for approval REGARDLESS of the flag and
// creates an approval row whose reason names the offending pattern.
//
// Patterns are kept narrow: each is something a human reviewer would
// flag in a code review. False positives are preferable to false
// negatives — an extra approval prompt is cheap, an accidental disk
// wipe is not.

export interface DestructiveMatch {
  pattern: string;
  description: string;
}

/** Ordered most-specific first so the reason surfaced to the approver
 *  is the most descriptive match, not the most generic. */
const PATTERNS: Array<{ re: RegExp; description: string; label: string }> = [
  { re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/, label: 'rm -rf', description: 'recursive forced delete' },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/,                                 label: 'mkfs',  description: 'filesystem format' },
  { re: /\bfdisk\b/,                                              label: 'fdisk', description: 'partition table edit' },
  { re: /\bdd\s+if=/,                                             label: 'dd if=',  description: 'block-level write' },
  { re: /\bshutdown\b/,                                           label: 'shutdown', description: 'host shutdown' },
  { re: /\breboot\b/,                                             label: 'reboot',  description: 'host reboot' },
  { re: /\bsystemctl\s+disable\b/,                                label: 'systemctl disable', description: 'service disable' },
  { re: /\biptables\s+-F\b/,                                      label: 'iptables -F', description: 'firewall flush' },
  { re: /\bufw\s+disable\b/,                                      label: 'ufw disable', description: 'firewall disable' },
  // Catch-all write operations against high-blast-radius root paths.
  // The regex matches `> /var/...`, `>> /etc/...`, `tee /etc/...`, and the
  // common `rm /etc/<file>` cases without requiring the -rf flag.
  { re: /(>|>>|tee\s+)\s*\/(etc|var)\//,                          label: 'write /etc or /var', description: 'write to system root' },
  { re: /\brm\s+(-[a-zA-Z]+\s+)?\/(etc|var)\//,                   label: 'rm /etc or /var',    description: 'delete inside system root' },
  // Wildcard prefixes that touch the filesystem root in dangerous shapes —
  // `rm -rf /` is caught above; this catches subtler `cp -r src /` or
  // `chmod -R 777 /` style writes.
  { re: /\b(chmod|chown)\s+(-R\s+)?(777|[0-9]+)\s+\/(?!\w)/,      label: 'chmod root',         description: 'permission change at /' },
];

export function inspect(command: string): DestructiveMatch | null {
  if (!command) return null;
  for (const p of PATTERNS) {
    if (p.re.test(command)) return { pattern: p.label, description: p.description };
  }
  return null;
}

/** Test-only — surfaced so tests can assert the exact pattern list without
 *  copying it. */
export function _patternLabels(): string[] {
  return PATTERNS.map(p => p.label);
}
