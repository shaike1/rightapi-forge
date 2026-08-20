// Public API barrel for the agents module.

export { Agent } from './Agent.js';
export { AgentMessageBus, type AgentBusMessage, type DelegationRecord, type DelegationState } from './AgentMessageBus.js';
export { AgentRouter, type AgentRouterOptions } from './AgentRouter.js';
export {
  AgentWorkloadTracker,
  type AgentAssignment,
  type AgentWorkloadStatus,
  type AgentWorkloadSnapshot,
} from './AgentWorkloadTracker.js';
export { pickAgentForIncident, type IncidentRoutingInput } from './IncidentRouter.js';
export { OrganizationManager } from './Organization.js';
export { GuardrailRunner, type GuardrailConfig, type GuardrailVerdict } from './Guardrails.js';
export { RollbackRegistry } from './RollbackRegistry.js';
export { SelfReflector, type ReflectionResult } from './SelfReflection.js';
export { UsageTracker } from './UsageTracker.js';

export {
  PersonalityEngine,
  type AdjustmentRecord,
  type ResolutionSignal,
  type ReflectionSignal,
} from './personality/PersonalityEngine.js';
// PersonalityStore lives in the persistence module (it's pure storage);
// re-exported through persistence/index.ts.
export {
  type PersonalityProfile, type CommunicationStyle, type DecisionPreferences,
  defaultProfile, clampProfile, buildSystemPromptFragment,
  PROFILE_DELTA_PER_UPDATE, PROFILE_DRIFT_LIMIT,
} from './personality/PersonalityProfile.js';
