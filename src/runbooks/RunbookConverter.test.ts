import test from 'node:test';
import assert from 'node:assert/strict';
import { RunbookConverter } from './RunbookConverter.js';

test('markdown converter pulls title, description and shell steps', () => {
  const md = `# Restart API

Restart the API service when it becomes unresponsive.

## Triage

\`\`\`bash
curl -fsS https://api.example.com/health
echo "ok"
\`\`\`

## Remediate

\`\`\`bash
systemctl restart api
\`\`\`
`;
  const { template, warnings } = RunbookConverter.fromMarkdown(md);
  assert.equal(template.name, 'Restart API');
  assert.match(template.description, /Restart the API service/);

  const actions = template.steps.filter(s => s.type === 'action');
  assert.equal(actions.length, 3, 'expected 3 shell action steps');

  const approvals = template.steps.filter(s => s.type === 'approval');
  assert.ok(approvals.length >= 1, 'systemctl restart should be guarded by an approval gate');
  assert.deepEqual(warnings, []);
});

test('markdown converter inserts approval gate before destructive ops', () => {
  const md = `# Cleanup
\`\`\`bash
echo safe
rm -rf /tmp/cache
\`\`\`
`;
  const { template } = RunbookConverter.fromMarkdown(md);
  const approvalIdx = template.steps.findIndex(s => s.type === 'approval');
  const destructiveIdx = template.steps.findIndex(
    s => s.type === 'action' && (s as any).params?.command?.includes('rm -rf')
  );
  assert.ok(approvalIdx >= 0 && destructiveIdx > approvalIdx, 'approval must precede destructive action');

  // The safe `echo` line should not be guarded.
  const echoIdx = template.steps.findIndex(s => s.type === 'action' && (s as any).params?.command === 'echo safe');
  assert.ok(echoIdx >= 0);
  if (echoIdx > 0) {
    assert.notEqual(template.steps[echoIdx - 1].type, 'approval', 'safe command should not be gated');
  }
});

test('markdown converter can disable destructive approval gates', () => {
  const md = `# Cleanup
\`\`\`bash
rm -rf /tmp/cache
\`\`\`
`;
  const { template } = RunbookConverter.fromMarkdown(md, { approvalForDestructive: false });
  assert.equal(template.steps.filter(s => s.type === 'approval').length, 0);
});

test('YAML converter parses structured runbooks', () => {
  const yaml = `name: Provision DB
description: Provision a new database instance.
category: infrastructure
tags: [provision, db]
steps:
  - description: Create disk
    command: bash.exec
    params: { command: "echo creating disk" }
  - approval: Confirm before applying
  - description: Apply migration
    command: bash.exec
    params: { command: "rm -rf /var/lib/old-db" }
  - description: Notify
    notification: alert.send
    params: { message: "DB ready", severity: "info" }
`;
  const { template, warnings } = RunbookConverter.fromYaml(yaml);
  assert.equal(template.name, 'Provision DB');
  assert.equal(template.category, 'infrastructure');
  assert.ok(template.tags.includes('provision'));
  assert.deepEqual(warnings, []);

  const types = template.steps.map(s => s.type);
  // expected: action, approval (explicit), approval (auto for rm -rf), action, notification
  assert.equal(types.filter(t => t === 'approval').length, 2);
  assert.equal(types.filter(t => t === 'action').length, 2);
  assert.equal(types.filter(t => t === 'notification').length, 1);
});

test('auto-detect routes YAML and markdown correctly', () => {
  const yaml = 'name: x\nsteps:\n  - approval: ok\n';
  const md = '# x\n```bash\necho hi\n```\n';
  assert.ok(RunbookConverter.fromText(yaml).template.tags.includes('yaml'));
  assert.ok(RunbookConverter.fromText(md).template.tags.includes('markdown'));
});
