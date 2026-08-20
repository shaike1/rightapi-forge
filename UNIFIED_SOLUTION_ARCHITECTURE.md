# Unified Solution Architecture

Last updated: 2026-02-16

## Goal
Merge RightAPI Forge and DevClaw-style orchestration patterns into one production-ready solution.

## Architecture Layers

## 1) Control Plane
Owns policy, trust, and governance.
- RBAC, auth sessions, approval tokens
- credential vault and scope model
- tool policy registry (risk, sandbox, duration, approvals)
- policy revision/audit and signed export/import
- backup/restore governance

## 2) Workflow Orchestrator
Owns deterministic progress logic (not chat-only triggering).
- heartbeat scheduling loop
- per-project queues and state transitions
- routing/delegation rules (director -> agents)
- retry/escalation and timeout handling
- stuck/zombie task detection and recovery actions

## 3) Execution Plane
Owns isolated command execution.
- sandboxed workers and launch profiles
- command guards (policy + scope checks)
- execution concurrency controls
- rollback checkpoints + task snapshots
- operation-level audit records

## 4) Visibility Plane
Owns operator and agent observability.
- running operations board
- agent capability + performance views
- task/delegation graph and timeline
- SLA trends and snapshots
- backup/restore health and alerts

## 5) Persistence Plane
Owns durable state and recovery.
- task/delegation stores
- policy stores and audit ledgers
- execution and approval ledgers
- backup bundles and retention artifacts

## Core Runtime Flow
1. Intake: task/event enters project queue.
2. Orchestrator: computes next transition and assignee.
3. Control Plane: validates permissions/approval/scope.
4. Execution Plane: runs sandboxed tool actions.
5. Persistence: writes status + operation + audit.
6. Visibility: broadcasts updates and KPIs.
7. Recovery logic: schedules retries/escalations/rollback when needed.

## Project Isolation Model
- Every task must have `projectId`.
- Queues, limits, SLA windows, and credentials are project-scoped.
- Cross-project delegation requires explicit policy and audit note.

## Required Orchestrator State Machine (MVP)
- `todo -> triage -> in_progress -> review -> done`
- terminal alternatives: `blocked`, `failed`, `cancelled`, `rolled_back`
- rework loop: `review -> in_progress`
- transition rules are policy-driven and auditable.

## API Contract Additions (Proposed)
- `GET /api/orchestrator/status`
- `POST /api/orchestrator/tick` (manual trigger for ops/testing)
- `GET /api/tasks/:taskId/graph` (delegation + parent/child graph)
- `GET /api/projects/:projectId/queue`
- `POST /api/projects/:projectId/queue/reconcile`
- `GET /api/tasks/:taskId/graph` (delegation/subtask/execution graph)
- `GET /api/backups/health` (freshness, verify status, failures)

## UI Additions (Proposed)
- Orchestrator health panel (loop lag, queue depth, stuck count)
- Project queue view with deterministic state transitions
- Task graph panel (parent/child/delegation/execution edges)
- Backup health widget with age + last verify outcome
- Orchestrator queue widget with heartbeat/tick control plus in-dashboard task graph view tied to `/api/tasks/:taskId/graph`.

## Migration Plan

### Phase 1: Orchestrator Skeleton
- add heartbeat worker
- add project queue abstraction
- add orchestration status endpoint

### Phase 2: Deterministic Task Loop
- implement state machine + transition policy
- connect task/delegation dispatch into orchestrator
- add stale task detection and escalation hooks

### Phase 3: Graph Visibility
- add task graph API + UI panel
- enrich running operations with project-aware grouping

### Phase 4: Resilience Completion
- backup scheduler + retention pruning
- backup health endpoint + alerting
- restore events in operations timeline

### Phase 5: Hardening
- external secret manager integration
- advanced command allowlists and anomaly flags
- chaos-style recovery drills in CI/staging

## Definition of Done Per Increment
- implementation complete and documented
- no regression in existing APIs unless explicitly planned
- validation passed:
  - `npm run build`
  - `npm test`
  - `npm run test:e2e:rollback`
- deployment + smoke checks recorded

## Suggested Agent Split
1. Orchestrator Agent: queue + heartbeat + transitions
2. Execution Agent: sandbox/execution lifecycle integration
3. Visibility Agent: graph APIs + dashboard panels
4. Resilience Agent: backup automation + health alerts
