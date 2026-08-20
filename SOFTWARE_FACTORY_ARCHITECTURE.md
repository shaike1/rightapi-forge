# Software Factory Architecture (Agent-Built Product)

Last updated: 2026-02-17

## Current F1 Status
- `FactoryBoardService` implemented with markdown-backed board snapshot parsing.
- Read-only APIs implemented:
  - `GET /api/factory/status`
  - `GET /api/factory/board`
- Remaining F1 work:
  - separate factory dashboard UI consuming these endpoints.

## Purpose
Define a separate agent-driven system that builds, tests, reviews, and releases this software safely.

## System Split

## 1) Product Runtime (existing)
- RightAPI Forge used by operators and end users.
- Keeps execution, security, policy, backup, and visibility APIs.

## 2) Software Factory (new)
- Agent-first engineering system that evolves Product Runtime.
- Owns planning, coding, review, QA, release, and rollback governance.

## Factory Agent Roles
- `architect`: turns goals into technical specs and task trees.
- `builder`: implements scoped changes.
- `reviewer`: performs code/risk review and enforces quality bars.
- `qa`: validates via test pipelines and scenario checks.
- `release`: handles deploy/rollback with approvals.
- `scribe`: updates roadmap/kanban/handoff docs.

## Required Factory Workflow
1. Intake: feature/bug/security request captured.
2. Spec: architect creates scope + acceptance criteria.
3. Breakdown: task graph generated with dependencies.
4. Build: builder agents implement in parallel where safe.
5. Review: reviewer validates logic, regressions, and policy impact.
6. QA Gate: build/test/e2e/security checks must pass.
7. Release Gate: approval token + deploy checks + smoke checks.
8. Documentation Gate: roadmap/kanban/handoff updated.
9. Closeout: release notes + rollback path validated.

## State Machine (Factory Tasks)
- `proposed -> specified -> ready -> in_progress -> in_review -> in_qa -> releasable -> released`
- fallback states:
  - `blocked`
  - `failed`
  - `rolled_back`
  - `cancelled`

## Safety Gates (Non-Negotiable)
- Build gate: `npm run build`
- Unit gate: `npm test`
- E2E gate: `npm run test:e2e:rollback`
- Security gate: policy/approval/scope constraints unchanged unless approved
- Deploy gate: health + smoke pass before close

## Factory Data Model (MVP)
- `FactoryProject`: id, name, repoPath, defaultBranch, owners
- `FactoryTask`: id, projectId, title, phase, state, ownerAgentId, dependencies
- `FactoryRun`: id, taskId, agentId, startedAt, endedAt, outcome, logsRef
- `FactoryGateResult`: taskId, gate, status, evidenceRef
- `FactoryRelease`: id, buildRef, deployedAt, smokeStatus, rollbackRef

## API Surface (MVP)
- `GET /api/factory/status`
- `GET /api/factory/board`
- `POST /api/factory/intake`
- `POST /api/factory/tasks/:taskId/start`
- `POST /api/factory/tasks/:taskId/review`
- `POST /api/factory/tasks/:taskId/qa`
- `POST /api/factory/tasks/:taskId/release`
- `POST /api/factory/tasks/:taskId/rollback`

## UI Surface (MVP)
- Separate dashboard app:
  - pipeline overview (phase throughput, blocked queue)
  - live kanban by state and phase
  - gate status cards (build/test/e2e/security/deploy)
  - release timeline with rollback controls

## Implementation Phases

### Phase F1: Factory Control Plane
- create factory task model + status endpoints
- build read-only board from markdown/source-of-truth

### Phase F2: Gate Automation
- automate build/test/e2e gate runs and evidence storage
- block transitions until gates pass

### Phase F3: Multi-Agent Workflow
- add role-specific assignment and parallel execution lanes
- dependency-aware scheduling

### Phase F4: Release Governance
- integrate deployment approvals and smoke checks
- standard rollback manifests and closeout reports

### Phase F5: Scale and Reliability
- queue retries, stuck-run detection, and recovery
- metrics: lead time, failure rate, rollback rate, gate pass rate

## Immediate Next Actions
1. Approve factory MVP scope (F1 only).
2. Create `factory` module and `/api/factory/status` + `/api/factory/board`.
3. Build initial separate dashboard view (read-only kanban + phase snapshot).
4. Wire documentation sync requirement into every factory closeout.
