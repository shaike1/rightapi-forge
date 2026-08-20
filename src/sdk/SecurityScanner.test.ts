// Tests for the static SDK security scanner.
//
// We exercise:
//   - every BLOCK_PATTERN flags a representative example
//   - approved imports pass; unapproved imports block
//   - WARN findings don't trip hasBlockingFindings()
//   - line + snippet metadata is populated
//
// The scanner runs over plain strings, so tests don't need fs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scanSource,
  scanFiles,
  hasBlockingFindings,
} from './SecurityScanner.js';

test('eval() is flagged as block', () => {
  const findings = scanSource('x.ts', 'const r = eval("1+1");');
  assert.ok(findings.some(f => f.severity === 'block' && /eval/.test(f.pattern)));
});

test('new Function() is flagged as block', () => {
  const findings = scanSource('x.ts', 'const f = new Function("return 1");');
  assert.ok(findings.some(f => f.severity === 'block' && /Function/.test(f.pattern)));
});

test('rm -rf is flagged as block', () => {
  const findings = scanSource('cmd.sh', 'rm -rf /tmp/scratch');
  assert.ok(findings.some(f => f.severity === 'block' && /rm/.test(f.pattern)));
});

test('shutdown / reboot / halt commands are blocked', () => {
  const f1 = scanSource('a', 'shutdown -h now');
  const f2 = scanSource('b', 'reboot');
  const f3 = scanSource('c', 'halt');
  assert.ok(hasBlockingFindings(f1));
  assert.ok(hasBlockingFindings(f2));
  assert.ok(hasBlockingFindings(f3));
});

test('curl | sh and wget | sh blocked', () => {
  const f1 = scanSource('a', 'curl https://example.com/install | sh');
  const f2 = scanSource('b', 'wget -qO- example.com | bash');
  assert.ok(hasBlockingFindings(f1));
  assert.ok(hasBlockingFindings(f2));
});

test('process.exit is blocked in generated code', () => {
  const findings = scanSource('x.ts', 'if (bad) process.exit(1);');
  assert.ok(hasBlockingFindings(findings));
});

test('SQL DROP statements are blocked', () => {
  const f = scanSource('x.ts', 'await db.exec("DROP TABLE users");');
  assert.ok(hasBlockingFindings(f));
});

test('mkfs and dd to disk blocked', () => {
  assert.ok(hasBlockingFindings(scanSource('a', 'mkfs.ext4 /dev/sdb1')));
  assert.ok(hasBlockingFindings(scanSource('b', 'dd if=/dev/zero of=/dev/sda bs=1M')));
});

test('fs.rm with recursive:true is blocked', () => {
  const findings = scanSource('x.ts', 'await fs.rm(dir, { recursive: true, force: true });');
  assert.ok(hasBlockingFindings(findings));
});

test('approved npm imports are not flagged', () => {
  const src = `import express from 'express';\nimport { Pool } from 'pg';\n`;
  const findings = scanSource('x.ts', src);
  assert.equal(findings.filter(f => f.pattern === 'unapproved-import').length, 0);
});

test('scoped approved import passes (deep path)', () => {
  const src = `import { ReactFlow } from '@xyflow/react/dist/esm/index.js';\n`;
  const findings = scanSource('x.ts', src);
  assert.equal(findings.filter(f => f.pattern === 'unapproved-import').length, 0);
});

test('unapproved bare import is blocked', () => {
  const src = `import { ssh } from 'ssh2';\n`;
  const findings = scanSource('x.ts', src);
  assert.ok(findings.some(f => f.severity === 'block' && f.pattern === 'unapproved-import'));
});

test('relative imports are not import-checked', () => {
  const src = `import { foo } from './foo.js';\nimport bar from '../bar.js';\n`;
  const findings = scanSource('x.ts', src);
  assert.equal(findings.filter(f => f.pattern === 'unapproved-import').length, 0);
});

test('require() of unapproved module is blocked', () => {
  const src = `const ssh = require('ssh2');\n`;
  const findings = scanSource('x.js', src);
  assert.ok(findings.some(f => f.severity === 'block' && f.pattern === 'unapproved-import'));
});

test('warn-only patterns do NOT trip hasBlockingFindings', () => {
  // sudo + TODO are warn-only.
  const findings = scanSource('x.sh', 'sudo apt-get install -y curl # TODO: parameterise');
  assert.ok(findings.some(f => f.severity === 'warn'));
  assert.equal(hasBlockingFindings(findings), false);
});

test('hard-coded IPv4 warns but does not block', () => {
  const findings = scanSource('cfg', 'host = 10.0.0.5');
  assert.ok(findings.some(f => f.severity === 'warn' && /ip/i.test(f.pattern)));
  assert.equal(hasBlockingFindings(findings), false);
});

test('line numbers + snippets are populated', () => {
  const src = `// header\n// comment\neval("oops");\n`;
  const findings = scanSource('x.ts', src);
  const evalFinding = findings.find(f => f.pattern === 'eval()');
  assert.ok(evalFinding);
  assert.equal(evalFinding!.line, 3);
  assert.match(evalFinding!.snippet ?? '', /eval/);
});

test('scanFiles aggregates per-file findings', () => {
  const findings = scanFiles([
    { path: 'a.ts', mode: 'add',       contents: 'eval("x");' },
    { path: 'b.sh', mode: 'overwrite', contents: 'echo ok' },
  ]);
  assert.ok(findings.some(f => f.file === 'a.ts'));
  assert.ok(!findings.some(f => f.file === 'b.sh'));
});

test('hasBlockingFindings is false for empty input', () => {
  assert.equal(hasBlockingFindings([]), false);
});

test('node: prefix on built-in imports is treated as approved', () => {
  const src = `import { exec } from 'node:child_process';\nimport { promisify } from 'node:util';\n`;
  const findings = scanSource('x.ts', src);
  assert.equal(findings.filter(f => f.pattern === 'unapproved-import').length, 0);
});

test('child_process import is approved (SDK emits it from every skill)', () => {
  const findings = scanSource('x.ts', `import { exec } from 'child_process';`);
  assert.equal(findings.filter(f => f.pattern === 'unapproved-import').length, 0);
});
