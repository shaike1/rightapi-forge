import { parseAppSpec, type AppSpec } from './AppSpec.js';
import { applyChatEdit } from './EditOperations.js';

export type AppSpecCompletion = (system: string, prompt: string) => Promise<string>;

export class AppSpecEditor {
  constructor(private completion?: AppSpecCompletion) {}

  async edit(current: AppSpec, message: string): Promise<AppSpec> {
    try { return applyChatEdit(current, message); }
    catch (error) {
      if (!this.completion) throw error;
    }
    const system = `You edit a typed application specification. Return one complete JSON object only, with no markdown or explanation.
Preserve every existing value unless the user explicitly requests a change. Never add source code, dependencies, credentials, URLs containing secrets, shell commands, or unrequested integrations.
The output must retain schemaVersion "1" and the same strict shape as the supplied specification. IDs must start with a lowercase letter and contain only lowercase letters, digits, and hyphens. Page paths must begin with /. Existing managed integration connectionRef values may be reused but never invented.`;
    const contract = `Allowed shapes (all objects are strict; do not add keys):
metadata: {name, slug, description}
page: {id, name, path, layout, components}; layout is dashboard|list|detail|form|custom
component: {id, type, title?, modelId?, actionId?, config}; type is table|form|chart|stat|text|button
dataModel: {id, name, description, fields}
field: {id, label, type, required, unique, options?, relationModelId?}; type is text|long-text|number|boolean|date|datetime|email|url|select|relation
action: {id, name, kind, modelId?, integrationId?, requiresApproval}; kind is create|update|delete|query|workflow|webhook
integration: {id, name, provider, connectionRef, capabilities}; provider is http|postgres|mysql|github|slack|custom
role: {id, name, permissions}
deploymentTarget: {runtime:"container", visibility, region?}; visibility is private|tenant|public
Every component modelId/actionId, action modelId/integrationId, and relationModelId must reference an ID present in the same output.`;
    const raw = await this.completion(`${system}\n${contract}`, `Current specification:\n${JSON.stringify(current)}\n\nRequested change:\n${message.trim()}`);
    return parseAppSpec(parseObject(raw));
  }
}

function parseObject(raw: string): unknown {
  const clean = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!clean.startsWith('{') || !clean.endsWith('}')) throw new Error('AI editor did not return a complete JSON specification');
  try { return JSON.parse(clean); }
  catch { throw new Error('AI editor returned invalid JSON'); }
}
