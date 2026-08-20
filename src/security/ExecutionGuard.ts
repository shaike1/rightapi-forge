import type { AgentRole } from '../types/index.js';
import { getToolLaunchSpec, getToolPolicy } from './ToolingPolicy.js';

export interface ExecutionDecision {
  allowed: boolean;
  outcome: 'allow' | 'deny' | 'approval_required' | 'rollback_required' | 'blocked';
  reason?: string;
  sandbox?: string;
  risk?: string;
  requiresApproval?: boolean;
  requiresRollback?: boolean;
  launchRunner?: string;
  requiredCredentialScopes?: string[];
  missingCredentialScopes?: string[];
  maxDurationMs?: number;
}

export function evaluateToolExecution(params: {
  command: string;
  agentRole: AgentRole;
  approved?: boolean;
  rollbackReady?: boolean;
  destructiveOverride?: boolean;
  providedCredentialScopes?: string[];
}): ExecutionDecision {
  const policy = getToolPolicy(params.command);
  if (!policy) {
    return { allowed: false, outcome: 'deny', reason: `No tool policy defined for command '${params.command}'` };
  }
  const launchSpec = getToolLaunchSpec(params.command);

  if (!policy.allowedRoles.includes(params.agentRole)) {
    return {
      allowed: false,
      outcome: 'deny',
      reason: `Role '${params.agentRole}' is not allowed to run '${params.command}'`,
      sandbox: policy.sandbox,
      risk: policy.risk,
      requiresApproval: policy.requiresApproval,
      requiresRollback: policy.requiresRollback,
      launchRunner: launchSpec?.runner,
      requiredCredentialScopes: policy.requiredCredentialScopes,
      maxDurationMs: policy.maxDurationMs
    };
  }

  if (policy.risk === 'destructive' && !params.destructiveOverride) {
    return {
      allowed: false,
      outcome: 'blocked',
      reason: `Destructive command '${params.command}' requires an explicit destructive override`,
      sandbox: policy.sandbox,
      risk: policy.risk,
      requiresApproval: true,
      requiresRollback: policy.requiresRollback,
      launchRunner: launchSpec?.runner,
      requiredCredentialScopes: policy.requiredCredentialScopes,
      maxDurationMs: policy.maxDurationMs
    };
  }

  if (policy.requiresApproval && !params.approved) {
    return {
      allowed: false,
      outcome: 'approval_required',
      reason: `Command '${params.command}' requires explicit approval`,
      sandbox: policy.sandbox,
      risk: policy.risk,
      requiresApproval: policy.requiresApproval,
      requiresRollback: policy.requiresRollback,
      launchRunner: launchSpec?.runner,
      requiredCredentialScopes: policy.requiredCredentialScopes,
      maxDurationMs: policy.maxDurationMs
    };
  }

  if (policy.requiresRollback && !params.rollbackReady) {
    return {
      allowed: false,
      outcome: 'rollback_required',
      reason: `Command '${params.command}' requires a verified rollback plan`,
      sandbox: policy.sandbox,
      risk: policy.risk,
      requiresApproval: policy.requiresApproval,
      requiresRollback: true,
      launchRunner: launchSpec?.runner,
      requiredCredentialScopes: policy.requiredCredentialScopes,
      maxDurationMs: policy.maxDurationMs
    };
  }

  const requiredScopes = policy.requiredCredentialScopes || [];
  const providedScopes = new Set(params.providedCredentialScopes || []);
  const missingScopes = requiredScopes.filter(scope => !providedScopes.has(scope));
  if (missingScopes.length > 0) {
    return {
      allowed: false,
      outcome: 'deny',
      reason: `Missing required credential scopes for '${params.command}': ${missingScopes.join(', ')}`,
      sandbox: policy.sandbox,
      risk: policy.risk,
      requiresApproval: policy.requiresApproval,
      requiresRollback: policy.requiresRollback,
      launchRunner: launchSpec?.runner,
      requiredCredentialScopes: requiredScopes,
      missingCredentialScopes: missingScopes,
      maxDurationMs: policy.maxDurationMs
    };
  }

  return {
    allowed: true,
    outcome: 'allow',
    sandbox: policy.sandbox,
    risk: policy.risk,
    requiresApproval: policy.requiresApproval,
    requiresRollback: policy.requiresRollback,
    launchRunner: launchSpec?.runner,
    requiredCredentialScopes: requiredScopes,
    maxDurationMs: policy.maxDurationMs
  };
}
