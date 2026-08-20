// Shared event-type catalogue.
//
// Free-form strings would work but namespacing them here gives us:
//   - One grep target when a type rename happens.
//   - Editor autocompletion at every emit/subscribe site.
//   - A natural place to document semantics ("when is this event fired?")
//
// New event types: add a constant here, document the meaning in a comment,
// then emit it. Keep names dotted: <aggregate>.<verb>.

export const EventTypes = {
  // Tasks
  TASK_CREATED:       'task.created',
  TASK_ASSIGNED:      'task.assigned',
  TASK_STATUS_CHANGED:'task.status_changed',
  TASK_COMPLETED:     'task.completed',
  TASK_FAILED:        'task.failed',

  // Skills
  SKILL_EXECUTED:     'skill.executed',     // any successful skill call
  SKILL_FAILED:       'skill.failed',       // skill call returned ok:false or threw

  // Workflows
  WORKFLOW_RUN_STARTED:    'workflow.run.started',
  WORKFLOW_STEP_COMPLETED: 'workflow.step.completed',
  WORKFLOW_STEP_FAILED:    'workflow.step.failed',
  WORKFLOW_RUN_COMPLETED:  'workflow.run.completed',
  WORKFLOW_RUN_FAILED:     'workflow.run.failed',
  WORKFLOW_RUN_PAUSED:     'workflow.run.paused',  // approval gate

  // Delegations
  DELEGATION_REQUESTED:  'delegation.requested',
  DELEGATION_COMPLETED:  'delegation.completed',
  DELEGATION_FAILED:     'delegation.failed',

  // Credentials
  CREDENTIAL_CREATED:        'credential.created',
  CREDENTIAL_UPDATED:        'credential.updated',
  CREDENTIAL_DELETED:        'credential.deleted',
  CREDENTIAL_ROTATED:        'credential.rotated',
  CREDENTIAL_ROTATION_FAILED:'credential.rotation_failed',

  // Approvals
  APPROVAL_TOKEN_MINTED:   'approval.token_minted',
  APPROVAL_TOKEN_USED:     'approval.token_used',

  // System / lifecycle
  SYSTEM_STARTED: 'system.started',
  SYSTEM_STOPPING:'system.stopping',

  // Self-Development SDK pipeline. Emitted by SelfDevelopmentService
  // for every developFeature() invocation so the dashboard's history
  // panel and downstream tools see the full development trail.
  SDK_PLANNED:    'sdk.planned',     // plan-only call returned a plan
  SDK_REJECTED:   'sdk.rejected',    // blocking security findings halted
  SDK_COMPLETED:  'sdk.completed',   // write+test+commit (and maybe deploy) succeeded
  SDK_FAILED:     'sdk.failed',      // write or test or commit threw
} as const;

export type EventTypeName = typeof EventTypes[keyof typeof EventTypes];

/** Aggregate type strings — used as the partition key for event read filters. */
export const AggregateTypes = {
  TASK:        'task',
  SKILL:       'skill',
  WORKFLOW:    'workflow',
  DELEGATION:  'delegation',
  CREDENTIAL:  'credential',
  APPROVAL:    'approval',
  SYSTEM:      'system',
  SDK:         'sdk',
} as const;
