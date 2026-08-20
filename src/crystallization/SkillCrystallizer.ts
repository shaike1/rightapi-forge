// Turn a successful resolution + reflection into a generalized
// WorkflowDef + parameter spec ready for the operator to review.
//
// The flow:
//   1. collectCommands(resolution + reflection) — pull out the shell
//      commands or skill calls the agent actually executed.
//   2. extractParameters(command) — find host-shaped tokens (IPs,
//      hostnames), file paths, service names, and replace them with
//      ${param.<slot>} markers, deduping repeated values to one slot.
//   3. buildWorkflowDef(...) — wrap the generalized commands in a
//      sequential WorkflowDef matching the existing schema.
//
// Three things this module deliberately doesn't do:
//   - Decide whether a resolution is *worth* crystallizing — that's
//     ResolutionAnalyzer's job.
//   - Persist the result — CrystallizedSkillStore owns storage.
//   - Run any LLM. Generalization is heuristic; an LLM-assisted
//     polish pass is on the roadmap but the deterministic path is
//     what ships first.

import { randomUUID } from 'crypto';
import { createLogger } from '../observability/Logger.js';
import type { WorkflowDef } from '../workflows/index.js';
import {
  detectDestructive,
  looksLikeSecret,
  maskSecrets,
  type CrystallizedParameter,
} from './CrystallizedSkillTypes.js';

const log = createLogger({ component: 'crystallizer' });

/** What we extract from a resolution before generalization. Each
 *  entry is one shell command (typed=='shell') or one skill call
 *  (typed=='skill'). The crystallizer rewrites the textual fields
 *  in-place to inject ${param.*} markers. */
export interface ExtractedCommand {
  type: 'shell' | 'skill';
  /** For shell: the raw command. For skill: dotted skill name. */
  text: string;
  /** Free-form note pulled from the source step (thought / observation
   *  preview). Used for the workflow step description. */
  note?: string;
}

export interface CrystallizationInput {
  /** Pre-shape from ResolutionAnalyzer — already filtered to the
   *  commands worth keeping (errors / probes typically dropped). */
  commands: ExtractedCommand[];
  /** Surface from ResolutionAnalyzer.score() — used as the seed for
   *  the skill description + tags. */
  context: {
    /** Source resolution title, e.g. "Restart redis after OOM". */
    title: string;
    /** Severity / category from the original incident. Optional. */
    category?: string;
    selfRating?: number;
    lessonsLearned?: string[];
  };
}

export interface CrystallizationResult {
  /** Generated workflow ready to feed into WorkflowRegistry. */
  workflow: WorkflowDef;
  /** Slot definitions referenced inside the workflow. Stored
   *  separately so the dashboard can render an input form without
   *  parsing the workflow body. */
  parameters: CrystallizedParameter[];
  /** Tag set inferred from the commands (networking, disk, …). */
  tags: string[];
  /** Human-readable name + description for the dashboard. */
  name: string;
  description: string;
  /** True when at least one command matched DESTRUCTIVE_PATTERNS.
   *  The orchestrator uses this to *force* draft + flag for review,
   *  bypassing the auto-promotion gate. */
  containsDestructive: boolean;
  /** Names of destructive patterns that matched, for audit. */
  destructiveReasons: string[];
}

export class SkillCrystallizer {
  /** Build a WorkflowDef + parameter set from extracted commands.
   *  Pure function — no IO, no LLM. */
  crystallize(input: CrystallizationInput): CrystallizationResult {
    const params = new Map<string, CrystallizedParameter>();
    const destructiveReasons: string[] = [];
    const seen = new Map<string, string>(); // raw value → slot name

    const generalizedSteps: WorkflowDef['steps'] = [];
    let stepIdx = 1;

    for (const cmd of input.commands) {
      // Mask any literal secret BEFORE generalization so a leaked
      // token can't end up as an example value on a parameter.
      const maskedText = maskSecrets(cmd.text);

      if (cmd.type === 'shell') {
        const dest = detectDestructive(maskedText);
        if (dest) destructiveReasons.push(dest.name);
        const generalized = this.generalize(maskedText, params, seen);
        generalizedSteps.push({
          id: `step_${stepIdx++}`,
          type: 'bash',
          description: cmd.note ? truncate(cmd.note, 160) : undefined,
          command: generalized,
        });
      } else {
        // Skill calls don't go through generalization (the params
        // were already structured); still emit a skill step.
        generalizedSteps.push({
          id: `step_${stepIdx++}`,
          type: 'skill',
          description: cmd.note ? truncate(cmd.note, 160) : undefined,
          skill: maskedText,
        });
      }
    }

    const tags = inferTags(input.commands.map(c => c.text).join(' '));
    const name = nameFromTitle(input.context.title);
    const description = buildDescription(input);
    const skillId = `crystal.${slugify(name)}.${randomUUID().slice(0, 8)}`;

    const inputs = Array.from(params.values()).map(p => ({
      name: p.name,
      type: p.type,
      description: p.description,
    }));

    const workflow: WorkflowDef = {
      schemaVersion: 1,
      id: skillId,
      name,
      description,
      version: '1.0.0',
      tags,
      inputs,
      onError: 'fail',
      steps: generalizedSteps,
    };

    log.info('skill crystallized', {
      id: skillId,
      params: inputs.length,
      steps: generalizedSteps.length,
      destructive: destructiveReasons.length > 0,
    });

    return {
      workflow,
      parameters: Array.from(params.values()),
      tags,
      name,
      description,
      containsDestructive: destructiveReasons.length > 0,
      destructiveReasons: Array.from(new Set(destructiveReasons)),
    };
  }

  /** Replace concrete tokens in a command with ${param.<slot>} markers.
   *  Side-effect: mutates `params` + `seen` so cross-step values keep
   *  the same slot name (one host across five commands → one parameter,
   *  not five). */
  private generalize(
    raw: string,
    params: Map<string, CrystallizedParameter>,
    seen: Map<string, string>,
  ): string {
    let text = raw;

    // 1. IP addresses (v4 only — v6 syntax is too noisy to reliably
    //    distinguish from path components).
    text = text.replace(IPV4_RE, m => this.slotFor(m, 'hostname', 'string',
      'IP address or hostname', params, seen));

    // 2. Hostname-shaped tokens (FQDN). Must contain a TLD-style dot
    //    suffix so we don't grab "node_modules" or "config.json".
    text = text.replace(FQDN_RE, m => {
      // Skip if already replaced (the IP rule produced ${param.hostname}).
      if (m.startsWith('${param.')) return m;
      return this.slotFor(m, 'hostname', 'string', 'IP address or hostname', params, seen);
    });

    // 3. Absolute file/directory paths. We capture /var/log/foo,
    //    /etc/nginx, /home/<user>/x — not the bare "/".
    text = text.replace(PATH_RE, m => {
      if (m.startsWith('${param.')) return m;
      return this.slotFor(m, 'path', 'string', 'Filesystem path', params, seen);
    });

    // 4. systemctl / service commands → service-name parameter.
    text = text.replace(/\bsystemctl\s+(start|stop|restart|status|reload|enable|disable)\s+([a-z0-9._@-]+)/gi,
      (_full, verb: string, svc: string) => {
        const slot = this.slotFor(svc, 'serviceName', 'string', 'systemd service name', params, seen);
        return `systemctl ${verb} ${slot}`;
      });

    return text;
  }

  /** Mint or reuse a parameter slot for a concrete value. The slot
   *  name comes from `hint`; collisions get a numeric suffix so two
   *  distinct values mapped to the same hint stay separate. */
  private slotFor(
    raw: string,
    hint: string,
    type: CrystallizedParameter['type'],
    description: string,
    params: Map<string, CrystallizedParameter>,
    seen: Map<string, string>,
  ): string {
    const cached = seen.get(raw);
    if (cached) return `\${param.${cached}}`;

    let name = hint;
    let i = 1;
    while (params.has(name)) {
      i++;
      name = `${hint}${i}`;
    }
    // Mask any secret-looking example before persisting.
    const safe = looksLikeSecret(raw) ? `[REDACTED:${looksLikeSecret(raw)!.name}]` : raw;
    params.set(name, { name, type, description, example: safe });
    seen.set(raw, name);
    return `\${param.${name}}`;
  }
}

// ─── helpers ───────────────────────────────────────────────────────────

const IPV4_RE = /\b(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)){3}\b/g;
// FQDN: at least two labels separated by dots, with the last label
// being 2+ alpha chars. Tolerates trailing port suffix (matched separately).
const FQDN_RE = /\b(?!\$\{)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+\.[A-Za-z]{2,}\b/g;
// Absolute path: starts with /, includes at least one segment of
// safe chars, and isn't immediately followed by a quote or shell op.
const PATH_RE = /(?<!\$\{)(?<![\w.])\/[A-Za-z0-9._-][A-Za-z0-9._/-]*[A-Za-z0-9._-]/g;

const COMMAND_TAGS: Array<{ tag: string; re: RegExp }> = [
  { tag: 'networking',   re: /\b(ping|nslookup|dig|curl|wget|netstat|ss|iptables|ip\s+route|tcpdump|nmap|telnet|nc)\b/i },
  { tag: 'disk',         re: /\b(df|du|find\s.*-size|fdisk|mkfs|mount|umount|smartctl)\b/i },
  { tag: 'service',      re: /\bsystemctl|service\s+\S+\s+(start|stop|restart|status)\b/i },
  { tag: 'security',     re: /\b(openssl|gpg|ssh-keygen|certbot|fail2ban|iptables)\b/i },
  { tag: 'logs',         re: /\b(journalctl|tail|grep|less|awk|sed)\b/i },
  { tag: 'docker',       re: /\bdocker\b|\bdocker compose\b/i },
  { tag: 'kubernetes',   re: /\bkubectl\b/i },
  { tag: 'database',     re: /\b(psql|mysql|sqlite3|mongosh|redis-cli)\b/i },
  { tag: 'package',      re: /\b(apt|apt-get|yum|dnf|brew|npm|pip|pnpm|yarn)\s+(install|update|upgrade)\b/i },
];

function inferTags(allText: string): string[] {
  const tags = new Set<string>(['crystallized']);
  for (const { tag, re } of COMMAND_TAGS) if (re.test(allText)) tags.add(tag);
  return Array.from(tags).sort();
}

function nameFromTitle(title: string): string {
  const cleaned = title.trim().replace(/\s+/g, ' ');
  if (cleaned.length === 0) return 'Crystallized Skill';
  // Truncate but keep a whole word.
  if (cleaned.length <= 60) return cleaned;
  return cleaned.slice(0, 57).replace(/\s+\S*$/, '') + '…';
}

function buildDescription(input: CrystallizationInput): string {
  const lines: string[] = [];
  lines.push(`Auto-generated from a successful resolution of "${truncate(input.context.title, 80)}".`);
  if (input.context.category) lines.push(`Category: ${input.context.category}`);
  if (typeof input.context.selfRating === 'number') {
    lines.push(`Source self-rating: ${input.context.selfRating}/5`);
  }
  if (input.context.lessonsLearned?.length) {
    lines.push(`Lessons learned: ${input.context.lessonsLearned.slice(0, 3).map(l => truncate(l, 80)).join('; ')}`);
  }
  return lines.join('\n');
}

function slugify(text: string): string {
  return text.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'skill';
}

function truncate(text: string, n: number): string {
  return text.length <= n ? text : text.slice(0, n - 1) + '…';
}
