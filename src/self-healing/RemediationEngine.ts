// Remediation Engine
// Executes automated remediation actions in response to anomalies and failures

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Allow-list of services this engine may restart. Add to this list
 * deliberately — anything outside it is rejected at execute time so a
 * hallucinating caller can't `systemctl restart sshd` or similar.
 *
 * Override per-deploy via env REMEDIATION_RESTART_ALLOWLIST (comma-separated).
 */
const RESTART_ALLOWLIST: ReadonlySet<string> = new Set(
  (process.env.REMEDIATION_RESTART_ALLOWLIST || 'itops-agents,itops-factory-dashboard')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

export interface RemediationRule {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  
  // Trigger conditions
  trigger: {
    type: 'anomaly' | 'task-failure' | 'alert' | 'manual';
    metric?: string;
    minSeverity?: 'info' | 'warning' | 'critical';
    taskPattern?: string; // regex for task title
    alertPattern?: string; // regex for alert message
  };
  
  // Actions to execute
  actions: RemediationAction[];
  
  // Safety controls
  maxRetries: number;
  cooldownMinutes: number;
  requireApproval: boolean;
  rollbackOnFailure: boolean;
  
  // Metadata
  createdAt: Date;
  updatedAt: Date;
  lastTriggered?: Date;
  successCount: number;
  failureCount: number;
}

export interface RemediationAction {
  type: 'restart-service' | 'scale-up' | 'scale-down' | 'clear-cache' | 'run-script' | 'create-task' | 'send-alert';
  params: Record<string, any>;
  timeoutSeconds?: number;
}

export interface RemediationExecution {
  id: string;
  ruleId: string;
  ruleName: string;
  trigger: {
    type: string;
    data: any;
  };
  status: 'pending' | 'approved' | 'running' | 'success' | 'failed' | 'rolled-back';
  actions: {
    action: RemediationAction;
    status: 'pending' | 'running' | 'success' | 'failed';
    startedAt?: Date;
    completedAt?: Date;
    error?: string;
    result?: any;
  }[];
  checkpoint?: any; // state snapshot for rollback
  startedAt: Date;
  completedAt?: Date;
  error?: string;
}

export class RemediationEngine extends EventEmitter {
  private rules: Map<string, RemediationRule> = new Map();
  private executions: Map<string, RemediationExecution> = new Map();
  private cooldowns: Map<string, Date> = new Map();
  private dataPath: string;
  
  constructor(dataPath: string = '/data/itops-agents/remediation-rules.json') {
    super();
    this.dataPath = dataPath;
    this.load();
  }
  
  addRule(rule: Omit<RemediationRule, 'id' | 'createdAt' | 'updatedAt' | 'successCount' | 'failureCount'>): RemediationRule {
    const id = uuidv4();
    const now = new Date();
    
    const newRule: RemediationRule = {
      ...rule,
      id,
      createdAt: now,
      updatedAt: now,
      successCount: 0,
      failureCount: 0
    };
    
    this.rules.set(id, newRule);
    this.save();
    
    return newRule;
  }
  
  updateRule(id: string, updates: Partial<RemediationRule>): RemediationRule | null {
    const rule = this.rules.get(id);
    if (!rule) return null;
    
    Object.assign(rule, updates);
    rule.updatedAt = new Date();
    
    this.save();
    return rule;
  }
  
  deleteRule(id: string): boolean {
    const deleted = this.rules.delete(id);
    if (deleted) {
      this.save();
    }
    return deleted;
  }
  
  getRule(id: string): RemediationRule | undefined {
    return this.rules.get(id);
  }
  
  getAllRules(): RemediationRule[] {
    return Array.from(this.rules.values());
  }
  
  async triggerRemediation(
    trigger: { type: string; data: any },
    checkpoint?: any
  ): Promise<RemediationExecution | null> {
    // Find matching rules
    const matchingRules = Array.from(this.rules.values()).filter(rule => {
      if (!rule.enabled) return false;
      
      // Check cooldown
      const lastCooldown = this.cooldowns.get(rule.id);
      if (lastCooldown) {
        const cooldownEndTime = new Date(lastCooldown.getTime() + rule.cooldownMinutes * 60000);
        if (new Date() < cooldownEndTime) {
          return false;
        }
      }
      
      // Check trigger match
      if (rule.trigger.type !== trigger.type) return false;
      
      if (trigger.type === 'anomaly' && rule.trigger.metric) {
        if (trigger.data.metric !== rule.trigger.metric) return false;
        if (rule.trigger.minSeverity) {
          const severityOrder = { info: 0, warning: 1, critical: 2 };
          const triggerSev = severityOrder[trigger.data.severity as keyof typeof severityOrder] || 0;
          const minSev = severityOrder[rule.trigger.minSeverity];
          if (triggerSev < minSev) return false;
        }
      }
      
      return true;
    });
    
    if (matchingRules.length === 0) {
      return null;
    }
    
    // Use first matching rule (could be enhanced to prioritize)
    const rule = matchingRules[0];
    
    // Create execution
    const execution: RemediationExecution = {
      id: uuidv4(),
      ruleId: rule.id,
      ruleName: rule.name,
      trigger,
      status: rule.requireApproval ? 'pending' : 'running',
      actions: rule.actions.map(action => ({
        action,
        status: 'pending'
      })),
      checkpoint,
      startedAt: new Date()
    };
    
    this.executions.set(execution.id, execution);
    
    // Emit event
    this.emit('remediation-triggered', execution);
    
    // Execute if no approval required
    if (!rule.requireApproval) {
      await this.executeRemediation(execution.id);
    }
    
    return execution;
  }
  
  async approveRemediation(executionId: string): Promise<boolean> {
    const execution = this.executions.get(executionId);
    if (!execution || execution.status !== 'pending') return false;
    
    execution.status = 'running';
    await this.executeRemediation(executionId);
    
    return true;
  }
  
  private async executeRemediation(executionId: string): Promise<void> {
    const execution = this.executions.get(executionId);
    if (!execution) return;
    
    const rule = this.rules.get(execution.ruleId);
    if (!rule) {
      execution.status = 'failed';
      execution.error = 'Rule not found';
      return;
    }
    
    try {
      // Execute actions sequentially
      for (const actionExec of execution.actions) {
        actionExec.status = 'running';
        actionExec.startedAt = new Date();
        
        try {
          const result = await this.executeAction(actionExec.action);
          actionExec.status = 'success';
          actionExec.result = result;
        } catch (error) {
          actionExec.status = 'failed';
          actionExec.error = (error as Error).message;
          
          // If rollback enabled, attempt rollback
          if (rule.rollbackOnFailure && execution.checkpoint) {
            execution.status = 'rolled-back';
            this.emit('remediation-rollback', { execution, error });
            return;
          }
          
          throw error;
        } finally {
          actionExec.completedAt = new Date();
        }
      }
      
      // Success
      execution.status = 'success';
      execution.completedAt = new Date();
      
      rule.successCount++;
      rule.lastTriggered = new Date();
      this.cooldowns.set(rule.id, new Date());
      
      this.save();
      this.emit('remediation-success', execution);
      
    } catch (error) {
      execution.status = 'failed';
      execution.error = (error as Error).message;
      execution.completedAt = new Date();
      
      rule.failureCount++;
      
      this.save();
      this.emit('remediation-failure', { execution, error });
    }
  }
  
  private async executeAction(action: RemediationAction): Promise<any> {
    switch (action.type) {
      case 'restart-service': {
        // Real implementation: invoke systemctl on the local host.
        // Allow-list gates which services may be touched. Anything else
        // throws so callers can't escape the safety boundary.
        const serviceName = String(action.params.serviceName || '').trim();
        if (!serviceName) {
          throw new Error('restart-service requires params.serviceName');
        }
        if (!RESTART_ALLOWLIST.has(serviceName)) {
          throw new Error(
            `restart-service: "${serviceName}" not in REMEDIATION_RESTART_ALLOWLIST ` +
            `(current allow-list: ${Array.from(RESTART_ALLOWLIST).join(', ') || '<empty>'})`
          );
        }
        console.log(`[Remediation] Restarting service: ${serviceName}`);
        // execFile (not exec) so we never interpolate user data into a shell.
        const { stdout, stderr } = await execFileAsync(
          'systemctl', ['restart', serviceName],
          { timeout: 30_000 }
        );
        return { success: true, service: serviceName, stdout, stderr };
      }

      // The following types remain unimplemented. They previously returned
      // {success: true} after a console.log + sleep, which let callers
      // believe remediation had succeeded when nothing happened. Now they
      // throw so a missing implementation surfaces as an explicit failure.
      case 'scale-up':
      case 'scale-down':
      case 'clear-cache':
      case 'run-script':
        throw new Error(
          `RemediationEngine action "${action.type}" is not yet implemented. ` +
          `Wire a real handler before enabling rules that use it.`
        );

      // These two are pure event emitters — fine as-is, they were never
      // mocks: another subsystem listens and does the work.
      case 'create-task':
        console.log(`[Remediation] Creating task: ${action.params.title}`);
        this.emit('create-task', action.params);
        return { success: true, task: action.params.title };

      case 'send-alert':
        console.log(`[Remediation] Sending alert: ${action.params.message}`);
        this.emit('send-alert', action.params);
        return { success: true, alert: action.params.message };

      default:
        throw new Error(`Unknown action type: ${(action as any).type}`);
    }
  }
  
  getExecution(id: string): RemediationExecution | undefined {
    return this.executions.get(id);
  }
  
  getExecutions(limit: number = 50): RemediationExecution[] {
    return Array.from(this.executions.values())
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit);
  }
  
  private save(): void {
    try {
      const dir = path.dirname(this.dataPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      const data = {
        rules: Array.from(this.rules.entries())
      };
      
      fs.writeFileSync(this.dataPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
      console.error('[RemediationEngine] Failed to save:', error);
    }
  }
  
  private load(): void {
    try {
      if (!fs.existsSync(this.dataPath)) return;
      
      const content = fs.readFileSync(this.dataPath, 'utf8');
      const data = JSON.parse(content);
      
      this.rules = new Map(data.rules || []);
      
      console.log(`[RemediationEngine] Loaded ${this.rules.size} rule(s)`);
    } catch (error) {
      console.error('[RemediationEngine] Failed to load:', error);
    }
  }
}
