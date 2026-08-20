import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const publishMode = args.includes('--publish');
const outputArg = valueAfter('--output') ?? 'release-evidence.json';
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const output = path.resolve(root, outputArg);
const npmCli = process.env.npm_execpath;

if (!npmCli) fail('run this command through npm run release:evidence');
assertSafeOutput();
if (trackedChanges().length > 0) fail('tracked files must be clean before release evidence is generated');

const startedAt = new Date().toISOString();
const checks = [];
checks.push(runNpm('server-build', ['run', 'build']));
checks.push(runNpm('client-build', ['--prefix', 'client', 'run', 'build']));
const testFiles = listFiles(path.join(root, 'dist')).filter(file => file.endsWith('.test.js'));
if (testFiles.length === 0) fail('server build emitted no test files');
const testCheck = run('tests', process.execPath, ['--test', 'dist/**/*.test.js'], parseTests, { NODE_ENV: 'test' });
testCheck.summary.files = testFiles.length;
checks.push(testCheck);
checks.push(runNpm('module-boundaries', ['run', 'check:boundaries']));
checks.push(runNpm('server-dependency-audit', ['audit', '--audit-level=low', '--json'], parseAudit));
checks.push(runNpm('client-dependency-audit', ['--prefix', 'client', 'audit', '--audit-level=low', '--json'], parseAudit));
checks.push(runNpm('third-party-license-inventory', ['run', 'licenses:check']));
checks.push(runNpm('public-release-audit', [
  'run',
  'release:audit',
  ...(publishMode ? ['--', '--publish'] : []),
]));

const finalChanges = trackedChanges();
checks.push({
  id: 'reproducible-working-tree',
  passed: finalChanges.length === 0,
  exitCode: finalChanges.length === 0 ? 0 : 1,
  durationMs: 0,
  summary: { trackedChanges: finalChanges.length },
});

const evidence = {
  schemaVersion: 1,
  product: 'RightAPI Forge',
  generatedAt: new Date().toISOString(),
  startedAt,
  releaseMode: publishMode ? 'publish' : 'candidate',
  source: {
    commit: git(['rev-parse', 'HEAD']),
    tree: git(['rev-parse', 'HEAD^{tree}']),
    tag: exactTag(),
  },
  runtime: {
    node: process.version,
    npm: commandVersion(),
    platform: process.platform,
    architecture: process.arch,
  },
  materials: hashFiles([
    'package-lock.json',
    'client/package-lock.json',
    'Dockerfile',
    'docker-compose.yml',
    'THIRD_PARTY_NOTICES.md',
  ]),
  outputs: hashFiles(listFiles(path.join(root, 'public', 'app')).map(file => path.relative(root, file).replaceAll('\\', '/'))),
  checks,
  passed: checks.every(check => check.passed),
};

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
console.log(`Release evidence written to ${path.relative(root, output) || path.basename(output)} (${evidence.passed ? 'passed' : 'failed'}).`);
if (!evidence.passed) process.exitCode = 1;

function run(id, command, commandArgs, parse = () => ({}), extraEnv = {}) {
  const started = Date.now();
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...extraEnv },
    maxBuffer: 128 * 1024 * 1024,
  });
  const outputText = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const exitCode = result.status ?? 1;
  const summary = parse(outputText);
  const summaryValid = summary._valid !== false;
  delete summary._valid;
  const record = {
    id,
    passed: exitCode === 0 && !result.error && summaryValid,
    exitCode,
    durationMs: Date.now() - started,
    summary,
  };
  console.log(`[release:evidence] ${record.passed ? 'PASS' : 'FAIL'} ${id} (${record.durationMs} ms)`);
  if (!record.passed) {
    if (result.error) console.error(result.error.message);
    process.stderr.write(outputText);
  }
  return record;
}

function runNpm(id, npmArgs, parse) {
  return run(id, process.execPath, [npmCli, ...npmArgs], parse);
}

function parseTests(outputText) {
  const summary = {
    total: numberAfter(outputText, 'tests'),
    passed: numberAfter(outputText, 'pass'),
    failed: numberAfter(outputText, 'fail'),
    skipped: numberAfter(outputText, 'skipped'),
    cancelled: numberAfter(outputText, 'cancelled'),
    todo: numberAfter(outputText, 'todo'),
  };
  const values = Object.values(summary);
  return {
    ...summary,
    _valid: values.every(value => value !== null)
      && summary.total === summary.passed + summary.failed + summary.skipped + summary.cancelled + summary.todo,
  };
}

function parseAudit(outputText) {
  try {
    const parsed = JSON.parse(outputText.trim());
    const vulnerabilities = parsed.metadata?.vulnerabilities;
    return { vulnerabilities: vulnerabilities ?? null, _valid: Boolean(vulnerabilities) };
  } catch {
    return { vulnerabilities: null, _valid: false };
  }
}

function numberAfter(outputText, label) {
  const normalized = outputText.replace(/\u001b\[[0-9;]*m/g, '');
  const match = normalized.match(new RegExp(`(?:^|\\n)(?:#|ℹ)?\\s*${label}\\s+(\\d+)`, 'm'));
  return match ? Number(match[1]) : null;
}

function hashFiles(files) {
  return files.sort().map(file => {
    const absolute = path.join(root, file);
    return {
      path: file,
      bytes: fs.statSync(absolute).size,
      sha256: createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),
    };
  });
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(absolute) : [absolute];
  });
}

function trackedChanges() {
  return git(['status', '--porcelain', '--untracked-files=no']).split(/\r?\n/).filter(Boolean);
}

function assertSafeOutput() {
  const relative = path.relative(root, output);
  const insideRoot = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  if (!insideRoot) return;
  const ignored = spawnSync('git', ['check-ignore', '--quiet', '--', relative], { cwd: root });
  if (ignored.status !== 0) fail('--output inside the repository must resolve to a gitignored path');
}

function exactTag() {
  try {
    return git(['describe', '--tags', '--exact-match', 'HEAD']);
  } catch {
    return null;
  }
}

function commandVersion() {
  return execFileSync(process.execPath, [npmCli, '--version'], { cwd: root, encoding: 'utf8' }).trim();
}

function git(gitArgs) {
  return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function valueAfter(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
