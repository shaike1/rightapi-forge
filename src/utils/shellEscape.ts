// Shell escaping helpers used by skills that pass user-supplied values to
// child_process.exec / execAsync. The default shell on Linux/macOS is /bin/sh,
// and on Windows for child_process the same single-quote convention is honoured
// when running through bash (which the skill layer assumes).
//
// The functions here are deliberately conservative: they single-quote the entire
// argument and escape any embedded single quotes via the standard `'\''` trick.
// That makes them safe to interpolate into a sh / bash command line without any
// further consideration of metacharacters, including spaces, $, `, !, ;, &&, |,
// > , < , newlines, etc.

/**
 * Quote a single argument for safe interpolation into a /bin/sh command line.
 * Always returns a string surrounded by single quotes. Returns "''" for empty.
 *
 *   shellEscape("simple")        => "'simple'"
 *   shellEscape("with space")    => "'with space'"
 *   shellEscape("don't")         => "'don'\\''t'"
 *   shellEscape("$(rm -rf /)")   => "'$(rm -rf /)'"  (literal, not executed)
 */
export function shellEscape(value: string | number | boolean | undefined | null): string {
  if (value === undefined || value === null) return "''";
  const s = String(value);
  if (s === '') return "''";
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Convenience: escape an array of arguments and join with spaces.
 *   shellJoin(['ls', '-la', '/tmp/with space']) => "'ls' '-la' '/tmp/with space'"
 */
export function shellJoin(args: Array<string | number | boolean | undefined | null>): string {
  return args.map(shellEscape).join(' ');
}

/**
 * Validate that a value contains only "safe" identifier characters — letters,
 * digits, dots, hyphens, underscores, slashes, colons. Throws if not. Useful
 * for params like container IDs, hostnames, file paths where you want to fail
 * loudly on suspicious input rather than just escape it.
 */
export function assertSafeIdentifier(value: string, paramName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${paramName} must be a non-empty string`);
  }
  if (!/^[A-Za-z0-9._\-/:@]+$/.test(value)) {
    throw new Error(`${paramName} contains unsafe characters; allowed: letters, digits, . _ - / : @`);
  }
  return value;
}
