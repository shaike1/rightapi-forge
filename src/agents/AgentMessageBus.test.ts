import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentMessageBus } from './AgentMessageBus.js';

function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-agent-bus-test-'));
  return path.join(dir, name);
}

test('agent bus groups room messages and preserves room metadata in thread view', () => {
  const filePath = tempFile('bus.json');
  const bus = new AgentMessageBus(filePath);
  const first = bus.send({
    fromAgentId: 'director',
    toAgentId: 'alice',
    content: 'standup start',
    roomId: 'standup-room-1',
    roomTopic: 'daily sync'
  });
  bus.send({
    threadId: first.threadId,
    fromAgentId: 'alice',
    toAgentId: 'director',
    content: 'update',
    roomId: 'standup-room-1',
    roomTopic: 'daily sync',
    kind: 'reply'
  });

  const threads = bus.listThreads({ limit: 5 });
  assert.equal(threads.length, 1);
  assert.equal(threads[0].roomId, 'standup-room-1');
  assert.equal(threads[0].roomTopic, 'daily sync');

  const rooms = bus.listRooms({ limit: 5 });
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].roomId, 'standup-room-1');
  assert.equal(rooms[0].roomTopic, 'daily sync');
  assert.equal(rooms[0].messageCount, 2);
  assert.deepEqual(rooms[0].threadIds, [first.threadId]);
});
