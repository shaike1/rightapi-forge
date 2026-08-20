import { z } from 'zod';

const identifier = z.string().trim().min(1).max(80).regex(/^[a-z][a-z0-9-]*$/);
const label = z.string().trim().min(1).max(120);

export const appFieldSchema = z.object({
  id: identifier,
  label,
  type: z.enum(['text', 'long-text', 'number', 'boolean', 'date', 'datetime', 'email', 'url', 'select', 'relation']),
  required: z.boolean().default(false),
  unique: z.boolean().default(false),
  options: z.array(label).max(100).optional(),
  relationModelId: identifier.optional(),
}).strict();

export const appModelSchema = z.object({
  id: identifier,
  name: label,
  description: z.string().trim().max(500).default(''),
  fields: z.array(appFieldSchema).min(1).max(100),
}).strict();

export const appComponentSchema = z.object({
  id: identifier,
  type: z.enum(['table', 'form', 'chart', 'stat', 'text', 'button']),
  title: label.optional(),
  modelId: identifier.optional(),
  actionId: identifier.optional(),
  config: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const appPageSchema = z.object({
  id: identifier,
  name: label,
  path: z.string().trim().min(1).max(160).regex(/^\/[a-z0-9/_-]*$/),
  layout: z.enum(['dashboard', 'list', 'detail', 'form', 'custom']).default('custom'),
  components: z.array(appComponentSchema).max(100).default([]),
}).strict();

export const appActionSchema = z.object({
  id: identifier,
  name: label,
  kind: z.enum(['create', 'update', 'delete', 'query', 'workflow', 'webhook']),
  modelId: identifier.optional(),
  integrationId: identifier.optional(),
  requiresApproval: z.boolean().default(false),
}).strict();

export const appIntegrationSchema = z.object({
  id: identifier,
  name: label,
  provider: z.enum(['http', 'postgres', 'mysql', 'github', 'slack', 'custom']),
  connectionRef: z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9/_-]+$/),
  capabilities: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
}).strict();

export const appRoleSchema = z.object({
  id: identifier,
  name: label,
  permissions: z.array(z.string().trim().min(1).max(120)).max(200).default([]),
}).strict();

export const appSpecSchema = z.object({
  schemaVersion: z.literal('1'),
  metadata: z.object({
    name: label,
    slug: identifier,
    description: z.string().trim().max(1000).default(''),
  }).strict(),
  pages: z.array(appPageSchema).min(1).max(100),
  dataModels: z.array(appModelSchema).max(100).default([]),
  actions: z.array(appActionSchema).max(200).default([]),
  integrations: z.array(appIntegrationSchema).max(50).default([]),
  roles: z.array(appRoleSchema).min(1).max(50),
  deploymentTarget: z.object({
    runtime: z.literal('container'),
    visibility: z.enum(['private', 'tenant', 'public']).default('tenant'),
    region: z.string().trim().min(1).max(80).optional(),
  }).strict(),
}).strict().superRefine((spec, ctx) => {
  const unique = (values: string[], path: (string | number)[]) => {
    const seen = new Set<string>();
    for (const value of values) {
      if (seen.has(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate id: ${value}`, path });
      seen.add(value);
    }
  };
  unique(spec.pages.map(item => item.id), ['pages']);
  unique(spec.pages.map(item => item.path), ['pages']);
  unique(spec.dataModels.map(item => item.id), ['dataModels']);
  unique(spec.actions.map(item => item.id), ['actions']);
  unique(spec.integrations.map(item => item.id), ['integrations']);
  unique(spec.roles.map(item => item.id), ['roles']);

  const modelIds = new Set(spec.dataModels.map(item => item.id));
  const actionIds = new Set(spec.actions.map(item => item.id));
  const integrationIds = new Set(spec.integrations.map(item => item.id));
  for (const [pageIndex, page] of spec.pages.entries()) {
    for (const [componentIndex, component] of page.components.entries()) {
      if (component.modelId && !modelIds.has(component.modelId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown modelId: ${component.modelId}`, path: ['pages', pageIndex, 'components', componentIndex, 'modelId'] });
      }
      if (component.actionId && !actionIds.has(component.actionId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown actionId: ${component.actionId}`, path: ['pages', pageIndex, 'components', componentIndex, 'actionId'] });
      }
    }
  }
  for (const [index, action] of spec.actions.entries()) {
    if (action.modelId && !modelIds.has(action.modelId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown modelId: ${action.modelId}`, path: ['actions', index, 'modelId'] });
    }
    if (action.integrationId && !integrationIds.has(action.integrationId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown integrationId: ${action.integrationId}`, path: ['actions', index, 'integrationId'] });
    }
  }
});

export type AppSpec = z.infer<typeof appSpecSchema>;

export function parseAppSpec(input: unknown): AppSpec {
  return appSpecSchema.parse(input);
}

export function formatAppSpecError(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }));
}

export function draftAppSpecFromMessage(message: string): AppSpec {
  const clean = message.trim().replace(/\s+/g, ' ');
  if (!clean) throw new Error('message is required');
  const name = clean.slice(0, 80).replace(/[.!?].*$/, '').trim() || 'Untitled tool';
  const slug = (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'untitled-tool')
    .replace(/^[^a-z]+/, 'app-');
  return parseAppSpec({
    schemaVersion: '1',
    metadata: { name, slug, description: clean.slice(0, 1000) },
    pages: [{ id: 'overview', name: 'Overview', path: '/', layout: 'dashboard', components: [] }],
    dataModels: [],
    actions: [],
    integrations: [],
    roles: [{ id: 'admin', name: 'Administrator', permissions: ['*'] }],
    deploymentTarget: { runtime: 'container', visibility: 'tenant' },
  });
}
