import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecurringDetector } from './RecurringDetector.js';
import { ProblemStore } from './ProblemStore.js';
import { IncidentManager } from './IncidentManager.js';
import { SqliteIncidentStore } from '../persistence/SqliteStore.js';
import { AutoRunbookGenerator } from '../ai/AutoRunbookGenerator.js';

test('Acceptance: 3 repeated incidents produce a proposed runbook', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recur-accept-'));
  
  // 1. Setup minimal stack
  const incidents = new IncidentManager(new SqliteIncidentStore(join(dir, 'incidents.db')));
  const problems = new ProblemStore(join(dir, 'problems.db'));
  
  const generatedDrafts: any[] = [];
  const generator = new AutoRunbookGenerator({
    aiFactory: {} as any, // not used due to override
    decisionStore: { insert: () => {} } as any, // mock
  }, {
    modelOverride: async (input) => ({
      id: 'rb-prevent-disk',
      name: 'Prevent Disk Full',
      description: 'Auto-generated from problem',
      category: 'infrastructure',
      tags: ['disk'],
      triggerType: 'manual',
      steps: [{ id: 's1', type: 'command', description: 'Clean disk', params: { command: 'rm -rf /tmp/*' } }],
      enabled: false,
      reasoning: 'Generated from test override',
      confidence: 0.9,
    })
  });

  // Wire the detector with the same logic as server.ts
  const detector = new RecurringDetector({
    incidents,
    problems,
    config: { minCount: 3, windowDays: 7 },
    onProblemCreated: async (problem, linked) => {
      if (linked.length >= 3) {
        const draft = await generator.fromPrompt({
          prompt: 'Create permanent fix for ' + problem.title,
          actor: 'recurring-detector'
        });
        generatedDrafts.push(draft);
      }
    }
  });

  // 2. Fire 3 repeated incidents
  for (let i = 0; i < 3; i++) {
    const inc = incidents.create({
      title: 'Disk full on web-01',
      severity: 'high',
      source: 'manual',
      sourceRef: 'disk:/data', // Same pattern
      dedup: false,
    });
    await detector.checkIncident(incidents.get(inc.id)!);
  }

  // 3. Assert outcome
  // A problem was created
  const list = problems.list();
  assert.equal(list.length, 1, 'Exactly 1 problem should be created');
  assert.equal(list[0].sourceRefPattern, 'disk:%');
  
  // A runbook draft was generated and passed out
  assert.equal(generatedDrafts.length, 1, 'Exactly 1 runbook draft should be proposed');
  assert.equal(generatedDrafts[0].name, 'Prevent Disk Full');
  assert.equal(generatedDrafts[0].enabled, false, 'Drafts must be disabled by default');

  // Cleanup
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});
