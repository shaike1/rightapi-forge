// Tests for the deterministic code generator.
//
// We exercise:
//   - skill source + plugin shim are emitted with the expected paths
//     and shapes (class name, handler name, command id, file extension)
//   - {{paramName}} is shell-escaped in the rendered command literal
//   - workflow JSON includes schemaVersion: 1, onError: fail, the
//     supplied steps, and lands under runbooks/library/
//   - validation rejects bad ids / empty commands / duplicate params

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSkillFiles,
  generateWorkflowFile,
  defaultSkillTests,
} from './CodeGenerator.js';
import type { SkillSpec, WorkflowSpec } from './SdkTypes.js';

function diskSpec(): SkillSpec {
  return {
    id: 'monitor.diskCheck',
    name: 'Disk Check',
    description: 'Reports filesystem usage for one mount.',
    category: 'monitoring',
    tags: ['filesystem'],
    parameters: [
      { name: 'mount', type: 'string', required: true, example: '/' },
    ],
    commands: ['df -h {{mount}}'],
  };
}

test('skill generation emits a .ts source + a .plugin.js shim', () => {
  const files = generateSkillFiles(diskSpec());
  assert.equal(files.length, 2);
  const src = files.find(f => f.path.endsWith('.ts'));
  const plugin = files.find(f => f.path.endsWith('.plugin.js'));
  assert.ok(src);
  assert.ok(plugin);
  assert.equal(src!.mode, 'add');
  assert.equal(plugin!.mode, 'add');
  assert.match(src!.path, /^src\/skills\/generated\/.+\.ts$/);
  assert.match(plugin!.path, /^src\/skills\/generated\/plugins\/.+\.plugin\.js$/);
});

test('skill source contains the expected class name + command id', () => {
  const [src] = generateSkillFiles(diskSpec());
  assert.match(src.contents, /class MonitorDiskCheckSkill\b/);
  assert.match(src.contents, /id:\s*'monitor\.diskCheck'/);
  assert.match(src.contents, /name:\s*'monitor\.diskCheck\.run'/);
});

test('plugin shim default-exports skill + executor and references handler', () => {
  const [, plugin] = generateSkillFiles(diskSpec());
  assert.match(plugin.contents, /export default \{/);
  assert.match(plugin.contents, /skill:\s*\{/);
  assert.match(plugin.contents, /executor:\s*\{/);
  // handler name is camelCase(spec.id) + 'Run'
  assert.match(plugin.contents, /async monitorDiskCheckRun\s*\(\s*params\s*\)/);
});

test('command template wraps {{mount}} with shellEscape(String(...))', () => {
  const [src] = generateSkillFiles(diskSpec());
  // The rendered command becomes a backtick template literal:
  //   `df -h ${shellEscape(String(mount))}`
  assert.match(src.contents, /\$\{shellEscape\(String\(mount\)\)\}/);
});

test('unknown {{name}} placeholders are kept as literal strings', () => {
  const spec: SkillSpec = {
    id: 'svc.poke',
    name: 'Poke service',
    description: 'Pokes a host',
    parameters: [],
    commands: ['echo {{HOSTNAME}}'],
  };
  const [src] = generateSkillFiles(spec);
  // Not in params → embedded as a quoted string literal substitution.
  assert.match(src.contents, /\$\{"\{\{HOSTNAME\}\}"\}/);
});

test('required parameter validation appears in both source + plugin', () => {
  const [src, plugin] = generateSkillFiles(diskSpec());
  assert.match(src.contents, /mount is required/);
  assert.match(plugin.contents, /mount is required/);
});

test('defaultSkillTests builds one smoke test per command, with example params', () => {
  const tests = defaultSkillTests(diskSpec());
  assert.equal(tests.length, 1);
  assert.equal(tests[0].command, 'monitor.diskCheck.run');
  assert.deepEqual(tests[0].params, { mount: '/' });
  assert.equal(tests[0].expect?.ok, true);
});

test('workflow generation produces schemaVersion=1 JSON under runbooks/library', () => {
  const spec: WorkflowSpec = {
    id: 'restart.api',
    name: 'Restart API',
    description: 'Restart the API tier',
    inputs: [],
    steps: [
      { id: 's1', type: 'bash', command: 'systemctl restart api' },
    ],
  };
  const file = generateWorkflowFile(spec);
  assert.match(file.path, /^src\/runbooks\/library\/.+\.workflow\.json$/);
  const parsed = JSON.parse(file.contents);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.id, 'restart.api');
  assert.equal(parsed.onError, 'fail');
  assert.equal(parsed.version, '1.0.0');
  assert.equal(parsed.steps.length, 1);
});

test('skill spec with bad id is rejected', () => {
  // Must start lowercase + must be dotted (multiple segments).
  for (const id of ['BadId', 'no-dot', '.leading-dot', 'trailing.', '1leading.digit']) {
    const bad: SkillSpec = {
      id,
      name: 'X', description: 'y', parameters: [], commands: ['echo'],
    };
    assert.throws(() => generateSkillFiles(bad), /dotted identifier/);
  }
});

test('skill spec with no commands is rejected', () => {
  const bad: SkillSpec = {
    id: 'svc.x', name: 'X', description: 'y', parameters: [], commands: [],
  };
  assert.throws(() => generateSkillFiles(bad), /at least one shell command/);
});

test('skill spec with duplicate param names is rejected', () => {
  const bad: SkillSpec = {
    id: 'svc.x', name: 'X', description: 'y',
    parameters: [
      { name: 'host', type: 'string' },
      { name: 'host', type: 'string' },
    ],
    commands: ['echo {{host}}'],
  };
  assert.throws(() => generateSkillFiles(bad), /duplicate parameter/);
});

test('workflow spec with empty steps is rejected', () => {
  const bad: WorkflowSpec = { id: 'x.y', name: 'X', steps: [] };
  assert.throws(() => generateWorkflowFile(bad), /at least one step/);
});

test('opts.sourceDir + opts.pluginDir override the defaults', () => {
  const files = generateSkillFiles(diskSpec(), {
    sourceDir: 'src/foo/bar',
    pluginDir: 'src/foo/plugins',
  });
  assert.match(files[0].path, /^src\/foo\/bar\//);
  assert.match(files[1].path, /^src\/foo\/plugins\//);
});
