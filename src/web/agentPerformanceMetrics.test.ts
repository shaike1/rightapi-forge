import assert from 'node:assert/strict';
import test from 'node:test';
import { taskDurationMinutes } from './agentPerformanceMetrics.js';

test('taskDurationMinutes accepts in-memory Date values', () => {
  const created = new Date('2026-08-04T10:00:00.000Z');
  const completed = new Date('2026-08-04T10:45:00.000Z');

  assert.equal(taskDurationMinutes(created, completed), 45);
});

test('taskDurationMinutes accepts timestamps restored from persistence', () => {
  assert.equal(
    taskDurationMinutes('2026-08-04T10:00:00.000Z', '2026-08-04T11:30:00.000Z'),
    90
  );
});

test('taskDurationMinutes ignores invalid persisted timestamps', () => {
  assert.equal(taskDurationMinutes('not-a-date', '2026-08-04T11:30:00.000Z'), null);
});
