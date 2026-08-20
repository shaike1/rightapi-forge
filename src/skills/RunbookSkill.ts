// Runbook management skill — lets agents list templates, trigger runs, check status, cancel, and approve steps

import type { Skill } from '../types/index.js';
import { RunbookEngine } from '../runbooks/RunbookEngine.js';
import { encode, ok, fail } from './SkillResult.js';

function engineFail(action: string, e: any): string {
  return encode(fail(`${action}: ${e?.message ?? String(e)}`, action));
}

export class RunbookSkill {
  private engine: RunbookEngine;

  constructor(engine?: RunbookEngine) {
    this.engine = engine ?? RunbookEngine.getInstance();
  }

  getSkill(): Skill {
    return {
      id: 'runbook',
      name: 'Runbook Management',
      description: 'Manage IT ops runbook executions — list templates, trigger runs, inspect status, cancel active runs, and approve waiting steps',
      category: 'service-management',
      enabled: true,
      commands: [
        { name: 'runbook.list',     description: 'List all available runbook templates with their id, name, description, category, and step count.',                                                  handler: 'runbookList',    parameters: {} },
        { name: 'runbook.run',      description: 'Trigger execution of a runbook template by its id. Optionally specify who triggered it.',                                                          handler: 'runbookRun',     parameters: { templateId: 'string', triggeredBy: 'string?' } },
        { name: 'runbook.status',   description: 'Get the current status of a runbook run including step-level results.',                                                                            handler: 'runbookStatus',  parameters: { runId: 'string' } },
        { name: 'runbook.cancel',   description: 'Cancel an active runbook run. Optionally provide a cancellation reason.',                                                                          handler: 'runbookCancel',  parameters: { runId: 'string', reason: 'string?' } },
        { name: 'runbook.approve',  description: 'Approve a step that is waiting for human approval to proceed.',                                                                                    handler: 'runbookApprove', parameters: { runId: 'string', approverId: 'string?' } },
        { name: 'runbook.import',   description: 'Convert a markdown or YAML runbook document into an executable runbook template. Destructive operations are wrapped with approval gates automatically.', handler: 'runbookImport',  parameters: { source: 'string', format: 'string?', id: 'string?', category: 'string?' } },
      ]
    };
  }

  async runbookList(_params?: Record<string, unknown>): Promise<string> {
    try {
      const templates = this.engine.listTemplates().map(t => ({
        id: t.id,
        name: t.name,
        description: t.description,
        category: t.category,
        steps: t.steps.length,
      }));
      return encode(ok({ templates, count: templates.length }, `${templates.length} template(s)`));
    } catch (e) {
      return engineFail('listing runbook templates', e);
    }
  }

  async runbookRun(params: { templateId?: string; triggeredBy?: string }): Promise<string> {
    if (!params?.templateId) return encode(fail('runbook.run requires { templateId }'));
    try {
      const run = await this.engine.executeRun(params.templateId, params.triggeredBy ?? 'agent');
      return encode(ok(
        { runId: run.id, templateName: run.templateName, stepCount: run.stepResults.length, status: run.status },
        `run ${run.id} started (${run.templateName})`
      ));
    } catch (e) {
      return engineFail(`starting runbook ${params.templateId}`, e);
    }
  }

  async runbookStatus(params: { runId?: string }): Promise<string> {
    if (!params?.runId) return encode(fail('runbook.status requires { runId }'));
    try {
      const run = this.engine.getRun(params.runId);
      if (!run) return encode(fail(`run not found: ${params.runId}`));
      return encode(ok(
        {
          id: run.id,
          status: run.status,
          currentStepIndex: run.currentStepIndex,
          stepCount: run.stepResults.length,
          steps: run.stepResults.map(s => ({ stepId: s.stepId, description: s.description, status: s.status })),
        },
        `run ${run.id} is ${run.status}`
      ));
    } catch (e) {
      return engineFail(`getting status for ${params.runId}`, e);
    }
  }

  async runbookCancel(params: { runId?: string; reason?: string }): Promise<string> {
    if (!params?.runId) return encode(fail('runbook.cancel requires { runId }'));
    try {
      this.engine.cancelRun(params.runId, params.reason);
      return encode(ok({ runId: params.runId, reason: params.reason ?? null }, `cancelled ${params.runId}`));
    } catch (e) {
      return engineFail(`cancelling ${params.runId}`, e);
    }
  }

  async runbookApprove(params: { runId?: string; approverId?: string }): Promise<string> {
    if (!params?.runId) return encode(fail('runbook.approve requires { runId }'));
    try {
      this.engine.approveStep(params.runId, params.approverId ?? 'agent');
      return encode(ok({ runId: params.runId, approverId: params.approverId ?? 'agent' }, `approved step in ${params.runId}`));
    } catch (e) {
      return engineFail(`approving step in ${params.runId}`, e);
    }
  }

  async runbookImport(params: {
    source?: string;
    format?: 'markdown' | 'yaml' | 'auto';
    id?: string;
    category?: string;
  }): Promise<string> {
    if (!params?.source) return encode(fail('runbook.import requires { source }'));
    try {
      const format = params.format ?? 'auto';
      const result = this.engine.importFromText(params.source, format, {
        id: params.id,
        category: params.category,
      });
      return encode(ok(
        {
          id: result.template.id,
          name: result.template.name,
          steps: result.template.steps.length,
          approvalGates: result.template.steps.filter(s => s.type === 'approval').length,
          warnings: result.warnings,
        },
        `imported "${result.template.name}" (${result.template.steps.length} steps)`
      ));
    } catch (e) {
      return engineFail('importing runbook', e);
    }
  }
}
