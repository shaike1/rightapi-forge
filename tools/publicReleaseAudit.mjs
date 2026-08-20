import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const publishMode = process.argv.includes('--publish');
const root = process.cwd();
const issues = [];
const publicRepositoryPlaceholder = ['<public', 'repository-url>'].join('-');

function issue(kind, file, detail) {
  issues.push({ kind, file, detail });
}

const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split(/\r?\n/)
  .filter(Boolean);

const forbiddenPaths = [
  /^\.omx(?:\/|$)/,
  /^\.current-spec$/,
  /^\.mcp\.json$/,
  /^\.env(?:\.|$)/,
  /(?:^|\/)id_(?:rsa|ed25519)$/i,
  /\.bak(?:\.|$)/i,
  /\.(?:new|old|orig|rej|tmp)$/i,
  /\.(?:pem|p12|pfx|key)$/i,
];
const textPatterns = [
  { name: 'Tailscale/private CGNAT address', re: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}\b/g },
  { name: 'private key material', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'OpenAI-style API key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'Anthropic-style API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'known retired shared password', re: new RegExp(`\\b${['shait', '2026'].join('')}\\b`, 'gi') },
  { name: 'private deployment hostname', re: /\b(?:itops|[a-z0-9-]+-itops)\.right-api\.com\b/gi },
  {
    name: 'private installation path',
    re: new RegExp(`/root/(?:${['itops', 'agents'].join('-')}|${['openclaw', 'acp'].join('-')})`, 'gi'),
  },
  { name: 'retired marketplace identity', re: new RegExp(['Luky', 'Monitor'].join(''), 'gi') },
  {
    name: 'legacy product display name',
    re: new RegExp(['ITOps', 'IT Ops'].map(prefix => `${prefix} (?:Agents|Agent Factory|Platform)`).join('|'), 'gi'),
  },
];
const binaryExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.zip', '.gz', '.pdf']);
const documentedFixtures = new Map([
  ['AGENT_KICKOFF_TEMPLATE.md', new Set(['private installation path'])],
  ['docs/API_REFERENCE.md', new Set(['private key material'])],
  ['src/crystallization/SkillCrystallizer.test.ts', new Set(['private key material'])],
  ['src/observability/Redactor.test.ts', new Set(['OpenAI-style API key', 'Anthropic-style API key'])],
]);

for (const file of tracked) {
  if (file !== '.env.example' && forbiddenPaths.some(re => re.test(file))) {
    issue('forbidden-path', file, 'secret-bearing file type must not be tracked');
  }
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute) || binaryExtensions.has(path.extname(file).toLowerCase())) continue;
  const stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024) continue;
  const content = fs.readFileSync(absolute, 'utf8');
  for (const pattern of textPatterns) {
    pattern.re.lastIndex = 0;
    const fixtureAllowed = documentedFixtures.get(file)?.has(pattern.name)
      || (file.startsWith('specs/') && pattern.name === 'private installation path');
    if (pattern.re.test(content) && !fixtureAllowed) {
      issue('sensitive-content', file, pattern.name);
    }
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (publishMode && manifest.license !== 'AGPL-3.0-or-later') {
  issue('publication-policy', 'package.json', 'approved AGPL-3.0-or-later SPDX license is required before publication');
}
if (publishMode && !fs.existsSync(path.join(root, 'LICENSE'))) {
  issue('publication-policy', 'LICENSE', 'license file is required before publication');
}
if (publishMode) {
  for (const required of ['COMMERCIAL.md', 'NOTICE', 'PRIVACY.md', 'TRADEMARKS.md']) {
    if (!fs.existsSync(path.join(root, required))) {
      issue('publication-policy', required, 'approved public legal notice is required before publication');
    }
  }
}
for (const required of ['CONTRIBUTING.md', 'SECURITY.md', 'SUPPORT.md', 'THIRD_PARTY_NOTICES.md']) {
  if (!fs.existsSync(path.join(root, required))) issue('publication-policy', required, 'required release governance file is missing');
}
if (publishMode) {
  const repositoryIdentityPatterns = [
    { name: 'private repository identity', re: /github\.com\/shaike1\/itops-agents/gi },
    { name: 'unresolved public repository URL', re: new RegExp(publicRepositoryPlaceholder, 'g') },
  ];
  for (const file of tracked) {
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute) || binaryExtensions.has(path.extname(file).toLowerCase())) continue;
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) continue;
    const content = fs.readFileSync(absolute, 'utf8');
    for (const pattern of repositoryIdentityPatterns) {
      pattern.re.lastIndex = 0;
      if (pattern.re.test(content)) issue('publication-identity', file, pattern.name);
    }
  }
}

if (issues.length > 0) {
  console.error(`Public release audit failed with ${issues.length} issue(s):`);
  for (const item of issues) console.error(`- [${item.kind}] ${item.file}: ${item.detail}`);
  process.exitCode = 1;
} else {
  console.log(`Public release audit passed (${tracked.length} tracked files${publishMode ? ', publish mode' : ''}).`);
}
