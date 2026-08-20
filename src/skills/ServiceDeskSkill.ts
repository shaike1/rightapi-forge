// Service Desk / Incident Management skill — backed by IncidentManager

import type { Skill } from '../types/index.js';
import { IncidentManager } from '../incidents/IncidentManager.js';
import { encode, ok, fail } from './SkillResult.js';

function managerFail(action: string, e: any): string {
  return encode(fail(`${action}: ${e?.message ?? String(e)}`, action));
}

export class ServiceDeskSkill {
  constructor(private incidentManager: IncidentManager) {}

  getSkill(): Skill {
    return {
      id: 'servicedesk',
      name: 'Service Desk & Incidents',
      description: 'Incident management via IT service desk — create, escalate, resolve, and list incidents',
      category: 'service-management',
      enabled: true,
      commands: [
        { name: 'incident.create',   description: 'Create a new incident',                handler: 'incidentCreate',   parameters: { title: 'string', severity: 'string', description: 'string?', assignedTo: 'string?' } },
        { name: 'incident.list',     description: 'List incidents with optional filters', handler: 'incidentList',     parameters: { status: 'string?', severity: 'string?', limit: 'number?' } },
        { name: 'incident.get',      description: 'Get a single incident by ID',          handler: 'incidentGet',      parameters: { id: 'string' } },
        { name: 'incident.escalate', description: 'Escalate an incident',                 handler: 'incidentEscalate', parameters: { id: 'string', reason: 'string?' } },
        { name: 'incident.resolve',  description: 'Resolve an incident',                  handler: 'incidentResolve',  parameters: { id: 'string', resolution: 'string?' } },
        { name: 'incident.note',     description: 'Add a note to incident timeline',      handler: 'incidentNote',     parameters: { id: 'string', actor: 'string', message: 'string' } },
      ]
    };
  }

  async incidentCreate(params: { title: string; severity?: string; description?: string; assignedTo?: string }): Promise<string> {
    if (!params?.title) return encode(fail('incident.create requires { title }'));
    try {
      const inc = this.incidentManager.create({
        title: params.title,
        severity: (params.severity || 'medium') as any,
        description: params.description,
        assignedTo: params.assignedTo,
        source: 'manual',
      });
      return encode(ok({ incident: inc }, `created ${inc.id} [${inc.severity}]`));
    } catch (e) {
      return managerFail('creating incident', e);
    }
  }

  async incidentList(params: { status?: string; severity?: string; assignedTo?: string; limit?: number } = {}): Promise<string> {
    try {
      const incidents = this.incidentManager.list({
        status: params.status,
        severity: params.severity,
        assignedTo: params.assignedTo,
      });
      const limited = params.limit ? incidents.slice(0, params.limit) : incidents;
      return encode(ok({ incidents: limited, total: incidents.length, returned: limited.length }, `${limited.length} of ${incidents.length} incident(s)`));
    } catch (e) {
      return managerFail('listing incidents', e);
    }
  }

  async incidentGet(params: { id: string }): Promise<string> {
    if (!params?.id) return encode(fail('incident.get requires { id }'));
    try {
      const inc = this.incidentManager.get(params.id);
      if (!inc) return encode(fail(`incident not found: ${params.id}`));
      return encode(ok({ incident: inc }, `${inc.id} [${inc.severity}/${inc.status}]`));
    } catch (e) {
      return managerFail(`getting incident ${params.id}`, e);
    }
  }

  async incidentEscalate(params: { id: string; reason?: string }): Promise<string> {
    if (!params?.id) return encode(fail('incident.escalate requires { id }'));
    try {
      const inc = this.incidentManager.escalate(params.id, params.reason || 'Manual escalation');
      if (!inc) return encode(fail(`incident not found: ${params.id}`));
      return encode(ok({ incident: inc }, `escalated ${params.id} → ${inc.severity}`));
    } catch (e) {
      return managerFail(`escalating ${params.id}`, e);
    }
  }

  async incidentResolve(params: { id: string; resolution?: string }): Promise<string> {
    if (!params?.id) return encode(fail('incident.resolve requires { id }'));
    try {
      const inc = this.incidentManager.resolve(params.id, params.resolution || 'Resolved');
      if (!inc) return encode(fail(`incident not found: ${params.id}`));
      return encode(ok({ incident: inc }, `resolved ${params.id}`));
    } catch (e) {
      return managerFail(`resolving ${params.id}`, e);
    }
  }

  async incidentNote(params: { id: string; actor: string; message: string }): Promise<string> {
    if (!params?.id || !params?.actor || !params?.message) {
      return encode(fail('incident.note requires { id, actor, message }'));
    }
    try {
      const entry = this.incidentManager.addNote(params.id, params.actor, params.message);
      if (!entry) return encode(fail(`incident not found: ${params.id}`));
      return encode(ok({ entry }, `note added to ${params.id}`));
    } catch (e) {
      return managerFail(`adding note to ${params.id}`, e);
    }
  }
}
