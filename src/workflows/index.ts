// Public API barrel for the workflows module.

export {
  type WorkflowDef,
  type WorkflowStep,
  type WorkflowStepType,
  type WorkflowOnError,
  type BashStep,
  type SkillStep,
  type ApiCallStep,
  type DelegationStep,
  type ApprovalGateStep,
  type ConditionalStep,
  type WorkflowInputDef,
  type ValidationError,
  type ValidationResult,
  WORKFLOW_SCHEMA,
  validateWorkflowDef,
} from './WorkflowDef.js';

export {
  WorkflowJsonExecutor,
  type WorkflowRunRecord,
  type StepResult,
  type StepStatus,
  type ExecuteOptions,
  type WorkflowExecutorDeps,
} from './WorkflowJsonExecutor.js';

export {
  WorkflowRegistry,
  type RegisteredWorkflow,
  type LoadFailure,
  type WorkflowRegistryOptions,
} from './WorkflowRegistry.js';
