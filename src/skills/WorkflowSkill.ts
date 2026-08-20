// Workflow management skill — lets agents list, inspect, advance, and annotate workflow runs

import type { Skill } from '../types/index.js';
import { WorkflowEngine } from '../workflows/WorkflowEngine.js';
import { encode, ok, fail } from './SkillResult.js';

function engineFail(action: string, e: any): string {
  return encode(fail(`${action}: ${e?.message ?? String(e)}`, action));
}

export class WorkflowSkill {
  private engine: WorkflowEngine;

  constructor(engine?: WorkflowEngine) {
    this.engine = engine ?? WorkflowEngine.getInstance();
  }

  getSkill(): Skill {
    return {
      id: 'workflow',
      name: 'Workflow Management',
      description: 'Manage IT ops workflow runs — list active runs, inspect stages, advance stages to done, add notes, and assign owners',
      category: 'service-management',
      enabled: true,
      commands: [
        { name: 'workflow.list',    description: 'List workflow runs. Optional filter by agentId (owner) or status.', handler: 'workflowList',    parameters: { agentId: 'string?', status: 'string?' } },
        { name: 'workflow.get',     description: 'Get full details of a single workflow run including all stages.',  handler: 'workflowGet',     parameters: { runId: 'string' } },
        { name: 'workflow.advance', description: 'Mark the current stage of a run as done, auto-advancing.',         handler: 'workflowAdvance', parameters: { runId: 'string', stageName: 'string', notes: 'string?' } },
        { name: 'workflow.note',    description: 'Add a note to a specific stage without changing its status.',      handler: 'workflowNote',    parameters: { runId: 'string', stageName: 'string', notes: 'string' } },
        { name: 'workflow.assign',  description: 'Assign an owner to a workflow stage.',                              handler: 'workflowAssign',  parameters: { runId: 'string', stageName: 'string', owner: 'string' } },
      ]
    };
  }

  async workflowList(params: { agentId?: string; status?: string } = {}): Promise<string> {
    try {
      let runs = this.engine.listRuns();
      if (params.status) runs = runs.filter(r => r.status === params.status);
      if (params.agentId) runs = runs.filter(r => r.stages.some(s => s.owner === params.agentId));
      const summary = runs.slice(0, 20).map(r => {
        const activeStage = r.stages.find(s => s.status === 'in_progress') ?? r.stages[r.currentStageIndex];
        return {
          id: r.id, status: r.status, title: r.title,
          activeStage: activeStage?.name ?? null,
          owner: activeStage?.owner ?? null
        };
      });
      return encode(ok({ runs: summary, total: runs.length, returned: summary.length }, `${summary.length} workflow run(s)`));
    } catch (e) {
      return engineFail('listing workflow runs', e);
    }
  }

  async workflowGet(params: { runId: string }): Promise<string> {
    if (!params?.runId) return encode(fail('workflow.get requires { runId }'));
    try {
      const run = this.engine.getRun(params.runId);
      if (!run) return encode(fail(`run not found: ${params.runId}`));
      return encode(ok({ run }, `${run.id} [${run.status}] "${run.title}"`));
    } catch (e) {
      return engineFail(`getting run ${params.runId}`, e);
    }
  }

  async workflowAdvance(params: { runId: string; stageName: string; notes?: string }): Promise<string> {
    if (!params?.runId || !params?.stageName) return encode(fail('workflow.advance requires { runId, stageName }'));
    try {
      const run = this.engine.getRun(params.runId);
      if (!run) return encode(fail(`run not found: ${params.runId}`));
      const stage = run.stages.find(s => s.name === params.stageName);
      if (!stage) return encode(fail(`stage "${params.stageName}" not found in run ${params.runId}`));
      if (stage.status === 'done') return encode(ok({ runId: params.runId, stageName: params.stageName, alreadyDone: true }, 'already done'));

      const updated = this.engine.updateStage(params.runId, params.stageName, {
        status: 'done',
        notes: params.notes,
      });
      const nextStage = updated.stages.find(s => s.status === 'in_progress');
      return encode(ok({
        runId: params.runId,
        completedStage: params.stageName,
        nextStage: nextStage?.name ?? null,
        runStatus: updated.status,
      }, nextStage ? `advanced; next: ${nextStage.name}` : updated.status === 'completed' ? 'workflow completed' : 'no further stages'));
    } catch (e) {
      return engineFail(`advancing ${params.runId}`, e);
    }
  }

  async workflowNote(params: { runId: string; stageName: string; notes: string }): Promise<string> {
    if (!params?.runId || !params?.stageName || !params?.notes) {
      return encode(fail('workflow.note requires { runId, stageName, notes }'));
    }
    try {
      const run = this.engine.getRun(params.runId);
      if (!run) return encode(fail(`run not found: ${params.runId}`));
      const stage = run.stages.find(s => s.name === params.stageName);
      if (!stage) return encode(fail(`stage "${params.stageName}" not found in run ${params.runId}`));
      this.engine.updateStage(params.runId, params.stageName, { status: stage.status, notes: params.notes });
      return encode(ok({ runId: params.runId, stageName: params.stageName }, `note added to "${params.stageName}"`));
    } catch (e) {
      return engineFail(`adding note to ${params.runId}`, e);
    }
  }

  async workflowAssign(params: { runId: string; stageName: string; owner: string }): Promise<string> {
    if (!params?.runId || !params?.stageName || !params?.owner) {
      return encode(fail('workflow.assign requires { runId, stageName, owner }'));
    }
    try {
      const run = this.engine.getRun(params.runId);
      if (!run) return encode(fail(`run not found: ${params.runId}`));
      const stage = run.stages.find(s => s.name === params.stageName);
      if (!stage) return encode(fail(`stage "${params.stageName}" not found in run ${params.runId}`));
      this.engine.updateStage(params.runId, params.stageName, { status: stage.status, owner: params.owner });
      return encode(ok({ runId: params.runId, stageName: params.stageName, owner: params.owner }, `assigned "${params.stageName}" to ${params.owner}`));
    } catch (e) {
      return engineFail(`assigning ${params.runId}`, e);
    }
  }
}
