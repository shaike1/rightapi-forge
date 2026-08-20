// Runbook-to-Agent converter — turns markdown or YAML runbook documents into
// executable RunbookTemplate step lists, automatically inserting approval gates
// before destructive operations.
//
// Supported markdown shape (a deliberate subset; unrecognised prose is skipped):
//   # Runbook Title              ← becomes `name`
//   Optional intro paragraph     ← becomes `description`
//   ## Some Section              ← passed through as a notification step
//   1. Do thing                  ← inline numbered steps become notifications
//   ```bash                      ← fenced shell block; each line is one action
//   curl -fsS https://...
//   rm -rf /tmp/cache            ← preceded by an approval gate (destructive)
//   ```
//
// Supported YAML shape (line-oriented, no external dependency):
//   name: My Runbook
//   description: ...
//   category: monitoring
//   tags: [foo, bar]
//   steps:
//     - description: do X
//       command: bash.exec
//       params: { command: 'echo hi' }
//     - approval: Confirm restart?
//     - description: notify
//       notification: alert.send
//       params: { message: 'done' }
//
// Both forms produce the same RunbookTemplate shape consumed by RunbookEngine.

import type {
  RunbookTemplate,
  RunbookStep,
  ActionStep,
  ApprovalStep,
  NotificationStep,
} from './RunbookTypes';

export interface ConvertOptions {
  /** Skill command to invoke for raw shell lines pulled out of code blocks. */
  shellCommand?: string;       // default: 'bash.exec'
  /** Param name the shell command expects to receive the command string under. */
  shellParamName?: string;     // default: 'command'
  /** Wrap destructive operations with an approval step. Default true. */
  approvalForDestructive?: boolean;
  /** Override the destructive-pattern detection list. */
  destructivePatterns?: RegExp[];
  /** Force category on the output template. */
  category?: string;
  /** Tags to merge with any tags found in the source. */
  tags?: string[];
  /** Fallback id if the markdown has no title we can slug. */
  fallbackId?: string;
  /** Force a specific id (overrides slug-from-title). */
  id?: string;
}

export interface ConvertResult {
  template: RunbookTemplate;
  warnings: string[];
}

/**
 * Default list of patterns that indicate a destructive operation requiring
 * human approval before execution. Override with `opts.destructivePatterns`.
 */
export const DEFAULT_DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+-[rR]?[fF]?[rR]?\b/,
  /\bdd\s+if=/,
  /\bmkfs(\.|\s)/,
  /\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX)\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bTRUNCATE\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\bpoweroff\b/i,
  /\bkill\s+-9\b/,
  /\bkillall\b/,
  /\bpkill\b/,
  /\bsystemctl\s+(stop|restart|disable|mask)\b/i,
  /\bservice\s+\S+\s+(stop|restart)\b/i,
  /\brotate\b/i,
  /\brestore\b/i,
  /--force\b/,
  /\s-f(\s|$)/,
  /docker\s+(rm|kill|stop|prune|system\s+prune)/i,
  /kubectl\s+(delete|drain|cordon|uncordon|scale)/i,
  /helm\s+(delete|uninstall|rollback)/i,
  /\bcurl\b[^|;]*-X\s+(DELETE|PUT|PATCH|POST)/i,
  /\bchmod\s+(0?[0-7]{0,2}777|-R)/,
  /\bchown\s+-R/,
  /\bgit\s+push\s+(-f|--force)/,
  /\bgit\s+reset\s+--hard/,
];

const DEFAULTS: Required<Pick<ConvertOptions, 'shellCommand' | 'shellParamName' | 'approvalForDestructive'>> = {
  shellCommand: 'bash.exec',
  shellParamName: 'command',
  approvalForDestructive: true,
};

export class RunbookConverter {
  /** Auto-detect markdown vs YAML based on a leading `name:` / `steps:` heuristic. */
  static fromText(source: string, opts: ConvertOptions = {}): ConvertResult {
    const trimmed = source.trim();
    const looksYaml =
      /^(name|description|category|tags|steps)\s*:/m.test(trimmed.split('\n').slice(0, 8).join('\n')) &&
      !/^#\s/m.test(trimmed.split('\n').slice(0, 8).join('\n'));
    return looksYaml ? RunbookConverter.fromYaml(source, opts) : RunbookConverter.fromMarkdown(source, opts);
  }

  // ─── Markdown ─────────────────────────────────────────────────────────────

  static fromMarkdown(source: string, opts: ConvertOptions = {}): ConvertResult {
    const cfg = { ...DEFAULTS, ...opts };
    const warnings: string[] = [];
    const lines = source.split(/\r?\n/);

    let title = '';
    let description = '';
    const steps: RunbookStep[] = [];
    let stepCounter = 0;
    const nextId = () => `s${++stepCounter}`;

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // Title
      if (!title && /^#\s+/.test(line)) {
        title = line.replace(/^#\s+/, '').trim();
        i++;
        continue;
      }

      // First paragraph after title becomes description
      if (title && !description && line.trim() && !line.startsWith('#') && !line.startsWith('```') && !line.startsWith('-') && !/^\d+\.\s/.test(line)) {
        const para: string[] = [];
        while (i < lines.length && lines[i].trim() && !lines[i].startsWith('#') && !lines[i].startsWith('```')) {
          para.push(lines[i].trim());
          i++;
        }
        description = para.join(' ').slice(0, 500);
        continue;
      }

      // Section header → notification
      if (/^##+\s+/.test(line)) {
        const heading = line.replace(/^##+\s+/, '').trim();
        if (/^approval(s)?$|^manual\s/i.test(heading)) {
          steps.push(makeApproval(nextId(), `Approval gate: ${heading}`, `Section "${heading}" requires manual approval before continuing.`));
        } else {
          steps.push(makeNotification(nextId(), `Section: ${heading}`, `Entering section "${heading}"`));
        }
        i++;
        continue;
      }

      // Fenced code block
      const fence = line.match(/^```(\w*)/);
      if (fence) {
        const lang = fence[1].toLowerCase();
        i++;
        const block: string[] = [];
        while (i < lines.length && !/^```/.test(lines[i])) {
          block.push(lines[i]);
          i++;
        }
        i++; // skip closing fence

        if (lang === 'bash' || lang === 'sh' || lang === 'shell' || lang === '' || lang === 'console') {
          for (const cmd of splitShellLines(block)) {
            const trimmedCmd = cmd.trim();
            if (!trimmedCmd) continue;
            if (cfg.approvalForDestructive && isDestructive(trimmedCmd, cfg.destructivePatterns)) {
              steps.push(makeApproval(nextId(), 'Approve destructive operation', `Approve before running: ${trimmedCmd.slice(0, 200)}`));
            }
            steps.push(makeShellAction(nextId(), trimmedCmd, cfg.shellCommand, cfg.shellParamName));
          }
        } else {
          // Non-shell fenced block → record as a notification so the operator can see it
          warnings.push(`Skipped non-shell code block (lang="${lang}")`);
          steps.push(makeNotification(nextId(), `Reference block (${lang || 'plain'})`, block.join('\n').slice(0, 500)));
        }
        continue;
      }

      // Numbered or bulleted list item
      const listMatch = line.match(/^\s*(?:\d+\.|[-*])\s+(.+)$/);
      if (listMatch) {
        const item = listMatch[1].trim();
        // Inline backtick-fenced shell command turns the item into an action step.
        const inlineCmd = item.match(/`([^`]+)`/);
        if (inlineCmd && /^[\w./-]+\s/.test(inlineCmd[1])) {
          const cmd = inlineCmd[1];
          if (cfg.approvalForDestructive && isDestructive(cmd, cfg.destructivePatterns)) {
            steps.push(makeApproval(nextId(), 'Approve destructive operation', `Approve before running: ${cmd.slice(0, 200)}`));
          }
          steps.push(makeShellAction(nextId(), cmd, cfg.shellCommand, cfg.shellParamName, item));
        } else {
          steps.push(makeNotification(nextId(), item.slice(0, 80), item));
        }
        i++;
        continue;
      }

      i++;
    }

    if (steps.length === 0) {
      warnings.push('No executable steps found in markdown source; produced an empty template.');
    }

    const id = opts.id ?? slugify(title) ?? opts.fallbackId ?? `runbook-${Date.now()}`;
    const now = new Date().toISOString();
    return {
      template: {
        id,
        name: title || id,
        description: description || `Converted from markdown runbook (${steps.length} steps)`,
        category: opts.category ?? 'service-management',
        tags: dedupe([...(opts.tags ?? []), 'converted', 'markdown']),
        steps,
        createdAt: now,
        updatedAt: now,
      },
      warnings,
    };
  }

  // ─── YAML ─────────────────────────────────────────────────────────────────

  static fromYaml(source: string, opts: ConvertOptions = {}): ConvertResult {
    const cfg = { ...DEFAULTS, ...opts };
    const warnings: string[] = [];
    const parsed = parseSimpleYaml(source);

    const title = String(parsed.name ?? '').trim();
    const description = String(parsed.description ?? '').trim();
    const category = opts.category ?? String(parsed.category ?? 'service-management');
    const sourceTags = Array.isArray(parsed.tags) ? parsed.tags.map(String) : [];
    const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];

    const steps: RunbookStep[] = [];
    let stepCounter = 0;
    const nextId = () => `s${++stepCounter}`;

    for (const raw of rawSteps as Array<Record<string, unknown>>) {
      // Approval shorthand: { approval: "message" }
      if (typeof raw.approval === 'string') {
        steps.push(makeApproval(nextId(), 'Approval gate', String(raw.approval)));
        continue;
      }

      const description = String(raw.description ?? raw.name ?? 'step').trim();
      const params = (raw.params && typeof raw.params === 'object') ? raw.params as Record<string, unknown> : {};

      if (typeof raw.notification === 'string') {
        steps.push({
          id: nextId(),
          type: 'notification',
          description,
          command: raw.notification,
          params,
        });
        continue;
      }

      if (typeof raw.command === 'string') {
        const cmd = raw.command;
        const shellArg = String((params as Record<string, unknown>)[cfg.shellParamName] ?? '');

        // Approval gate inserted automatically when the command — or its shell
        // payload — matches a destructive pattern.
        if (cfg.approvalForDestructive && (isDestructive(cmd, cfg.destructivePatterns) || isDestructive(shellArg, cfg.destructivePatterns))) {
          steps.push(makeApproval(nextId(), 'Approve destructive operation', `Approve before running: ${(shellArg || cmd).slice(0, 200)}`));
        }

        steps.push({
          id: nextId(),
          type: 'action',
          description,
          command: cmd,
          params,
        });
        continue;
      }

      warnings.push(`Skipped step "${description}" — no command/notification/approval recognised.`);
    }

    if (steps.length === 0) {
      warnings.push('No executable steps found in YAML source; produced an empty template.');
    }

    const id = opts.id ?? slugify(title) ?? opts.fallbackId ?? `runbook-${Date.now()}`;
    const now = new Date().toISOString();
    return {
      template: {
        id,
        name: title || id,
        description: description || `Converted from YAML runbook (${steps.length} steps)`,
        category,
        tags: dedupe([...(opts.tags ?? []), ...sourceTags, 'converted', 'yaml']),
        steps,
        createdAt: now,
        updatedAt: now,
      },
      warnings,
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeShellAction(
  id: string,
  shellLine: string,
  shellCommand: string,
  shellParamName: string,
  description?: string
): ActionStep {
  return {
    id,
    type: 'action',
    description: description ?? shellLine.slice(0, 80),
    command: shellCommand,
    params: { [shellParamName]: shellLine },
  };
}

function makeApproval(id: string, description: string, message: string): ApprovalStep {
  return { id, type: 'approval', description, message };
}

function makeNotification(id: string, description: string, message: string): NotificationStep {
  return {
    id,
    type: 'notification',
    description,
    command: 'alert.send',
    params: { message, severity: 'info' },
  };
}

function isDestructive(text: string, patterns?: RegExp[]): boolean {
  const list = patterns ?? DEFAULT_DESTRUCTIVE_PATTERNS;
  return list.some(re => re.test(text));
}

/**
 * Split a fenced code block into individual shell lines, joining lines that end
 * with a backslash continuation and preserving here-doc blocks intact.
 */
function splitShellLines(block: string[]): string[] {
  const out: string[] = [];
  let buffer = '';
  let hereDoc: string | null = null;

  for (const raw of block) {
    const line = raw.replace(/\r$/, '');
    if (hereDoc) {
      buffer += '\n' + line;
      if (line.trim() === hereDoc) {
        out.push(buffer);
        buffer = '';
        hereDoc = null;
      }
      continue;
    }

    // Skip blank lines and prompt lines like "$ cmd"
    const cleaned = line.replace(/^\s*\$\s+/, '');
    if (!cleaned.trim() || cleaned.trim().startsWith('#')) continue;

    // Backslash continuation
    if (/\\\s*$/.test(cleaned)) {
      buffer += (buffer ? ' ' : '') + cleaned.replace(/\\\s*$/, '').trim();
      continue;
    }

    // Here-doc start
    const here = cleaned.match(/<<-?\s*['"]?([A-Z_][A-Z0-9_]*)['"]?\s*$/);
    if (here) {
      buffer = (buffer ? buffer + ' ' : '') + cleaned;
      hereDoc = here[1];
      continue;
    }

    buffer += (buffer ? ' ' : '') + cleaned.trim();
    if (buffer.trim()) out.push(buffer.trim());
    buffer = '';
  }

  if (buffer.trim()) out.push(buffer.trim());
  return out;
}

function slugify(s: string): string | undefined {
  if (!s) return undefined;
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || undefined;
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

// ─── Tiny YAML subset parser ────────────────────────────────────────────────
//
// Handles the limited shape we accept for runbooks:
//   key: value
//   key: [a, b, c]              (flow sequence)
//   key:
//     - simple                  (block sequence of scalars)
//     - key: value              (block sequence of mappings)
//       key2: value2
//   key:
//     nested: value             (block mapping)
//
// Anything more exotic should be normalised by the caller; we surface a
// well-typed object rather than throw.

interface YamlValue {
  [k: string]: unknown;
}

function parseSimpleYaml(source: string): YamlValue {
  const lines = source.split(/\r?\n/).map(l => l.replace(/\t/g, '  '));
  let i = 0;

  function indentOf(line: string): number {
    const m = line.match(/^( *)/);
    return m ? m[1].length : 0;
  }

  function scalar(raw: string): unknown {
    const v = raw.trim();
    if (v === '') return '';
    if (v === 'null' || v === '~') return null;
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (/^-?\d+$/.test(v)) return Number(v);
    if (/^-?\d+\.\d+$/.test(v)) return Number(v);
    // Flow sequence: [a, b, c]
    if (/^\[.*\]$/.test(v)) {
      const inner = v.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(',').map(s => unquote(s.trim()));
    }
    // Inline mapping: { a: 1, b: 2 }
    if (/^\{.*\}$/.test(v)) {
      const inner = v.slice(1, -1).trim();
      const obj: YamlValue = {};
      if (inner) {
        for (const pair of splitTopLevel(inner, ',')) {
          const [k, ...rest] = pair.split(':');
          obj[k.trim()] = scalar(rest.join(':').trim());
        }
      }
      return obj;
    }
    return unquote(v);
  }

  function unquote(s: string): string {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
    return s;
  }

  function splitTopLevel(s: string, sep: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let buf = '';
    for (const ch of s) {
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
      if (ch === sep && depth === 0) { parts.push(buf); buf = ''; }
      else buf += ch;
    }
    if (buf) parts.push(buf);
    return parts;
  }

  function parseBlock(parentIndent: number): YamlValue | unknown[] {
    // Decide map vs list by peeking at the first non-blank line at deeper indent.
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) return {};
    const firstIndent = indentOf(lines[i]);
    if (firstIndent <= parentIndent) return {};

    const isList = lines[i].trim().startsWith('-');
    return isList ? parseList(firstIndent) : parseMap(firstIndent);
  }

  function parseMap(indent: number): YamlValue {
    const obj: YamlValue = {};
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }
      if (indentOf(line) < indent) break;
      if (indentOf(line) > indent) { i++; continue; } // safety
      const m = line.trim().match(/^([\w.\-]+)\s*:\s*(.*)$/);
      if (!m) { i++; continue; }
      const key = m[1];
      const valueRaw = m[2];
      i++;
      if (valueRaw === '') {
        obj[key] = parseBlock(indent);
      } else {
        obj[key] = scalar(valueRaw);
      }
    }
    return obj;
  }

  function parseList(indent: number): unknown[] {
    const arr: unknown[] = [];
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }
      if (indentOf(line) < indent) break;
      if (indentOf(line) > indent) { i++; continue; }
      const trimmed = line.trim();
      if (!trimmed.startsWith('-')) break;
      const remainder = trimmed.replace(/^-\s*/, '');

      // "- key: value" inline → start of a mapping list item
      const inlineMap = remainder.match(/^([\w.\-]+)\s*:\s*(.*)$/);
      if (inlineMap) {
        const item: YamlValue = {};
        item[inlineMap[1]] = inlineMap[2] === '' ? parseBlock(indent) : scalar(inlineMap[2]);
        i++;
        // Continuation lines at indent+2 belong to this map item
        const childIndent = indent + 2;
        while (i < lines.length) {
          const cont = lines[i];
          if (cont.trim() === '' || cont.trim().startsWith('#')) { i++; continue; }
          if (indentOf(cont) < childIndent) break;
          const cm = cont.trim().match(/^([\w.\-]+)\s*:\s*(.*)$/);
          if (!cm) { i++; continue; }
          i++;
          item[cm[1]] = cm[2] === '' ? parseBlock(childIndent) : scalar(cm[2]);
        }
        arr.push(item);
        continue;
      }

      // "- scalar"
      arr.push(scalar(remainder));
      i++;
    }
    return arr;
  }

  // Top level
  const root: YamlValue = {};
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }
    if (indentOf(line) > 0) { i++; continue; }
    const m = line.trim().match(/^([\w.\-]+)\s*:\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const valueRaw = m[2];
    i++;
    if (valueRaw === '') {
      root[key] = parseBlock(0);
    } else {
      root[key] = scalar(valueRaw);
    }
  }
  return root;
}
