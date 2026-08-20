import test from "node:test";
import assert from "node:assert/strict";
import { buildMissionControlActivityEvents } from "./missionControlApi.js";

test("buildMissionControlActivityEvents normalizes and filters events", () => {
  const events = buildMissionControlActivityEvents({
    tasks: [
      {
        id: "t-1",
        title: "Deploy update",
        status: "failed",
        ownerId: "alice",
        updatedAt: "2026-02-27T10:00:00.000Z",
        priority: "high"
      },
      {
        id: "t-2",
        title: "Health check",
        status: "completed",
        ownerId: "bob",
        updatedAt: "2026-02-27T09:59:00.000Z",
        priority: "low"
      }
    ],
    threads: [
      {
        threadId: "th-1",
        messageCount: 3,
        lastStatus: "processed",
        ownerAgentId: "alice",
        lastMessageAt: "2026-02-27T09:58:30.000Z"
      }
    ],
    agentsById: new Map([
      ["alice", "Alice"],
      ["bob", "Bob"]
    ]),
    options: {
      agentId: "alice",
      severity: "error",
      limit: 10
    }
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "task");
  assert.equal(events[0].severity, "error");
  assert.equal(events[0].agentId, "alice");
  assert.equal(events[0].agentName, "Alice");
  assert.ok(events[0].id.startsWith("task:t-1:"));
});
