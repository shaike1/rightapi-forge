import { z } from 'zod';
import { parseAppSpec, type AppSpec } from './AppSpec.js';

const metadataEdit = z.object({
  target: z.literal('metadata'),
  property: z.enum(['name', 'description']),
  value: z.string(),
}).strict();

const deploymentEdit = z.object({
  target: z.literal('deployment'),
  property: z.literal('visibility'),
  value: z.enum(['private', 'tenant', 'public']),
}).strict();

const pageEdit = z.object({
  target: z.literal('page'),
  id: z.string().min(1),
  property: z.enum(['name', 'path', 'layout']),
  value: z.unknown(),
}).strict();

const componentEdit = z.object({
  target: z.literal('component'),
  pageId: z.string().min(1),
  id: z.string().min(1),
  property: z.enum(['title', 'config']),
  value: z.unknown(),
}).strict();

export const visualEditSchema = z.discriminatedUnion('target', [metadataEdit, deploymentEdit, pageEdit, componentEdit]);
export type VisualEdit = z.infer<typeof visualEditSchema>;

export function applyVisualEdit(current: AppSpec, input: unknown): AppSpec {
  const edit = visualEditSchema.parse(input);
  const next = structuredClone(current);
  if (edit.target === 'metadata') {
    next.metadata[edit.property] = edit.value;
  } else if (edit.target === 'deployment') {
    next.deploymentTarget.visibility = edit.value;
  } else if (edit.target === 'page') {
    const page = next.pages.find(item => item.id === edit.id);
    if (!page) throw new Error(`page not found: ${edit.id}`);
    if (edit.property === 'name' || edit.property === 'path') page[edit.property] = String(edit.value);
    else page.layout = String(edit.value) as typeof page.layout;
  } else {
    const page = next.pages.find(item => item.id === edit.pageId);
    const component = page?.components.find(item => item.id === edit.id);
    if (!component) throw new Error(`component not found: ${edit.pageId}/${edit.id}`);
    if (edit.property === 'title') component.title = String(edit.value);
    else component.config = z.record(z.string(), z.unknown()).parse(edit.value);
  }
  return parseAppSpec(next);
}

export function applyChatEdit(current: AppSpec, message: string): AppSpec {
  const clean = message.trim();
  let match = clean.match(/^(?:rename (?:the )?tool|change (?:the )?tool name) to\s+["']?(.+?)["']?\.?$/i);
  if (match) return applyVisualEdit(current, { target: 'metadata', property: 'name', value: match[1].trim() });

  match = clean.match(/^(?:set|change|update) (?:the )?description to\s+["']?(.+?)["']?\.?$/i);
  if (match) return applyVisualEdit(current, { target: 'metadata', property: 'description', value: match[1].trim() });

  match = clean.match(/^(?:set|change) (?:the )?visibility to\s+(private|tenant|public)\.?$/i);
  if (match) return applyVisualEdit(current, { target: 'deployment', property: 'visibility', value: match[1].toLowerCase() });

  match = clean.match(/^add (?:a )?page(?: named| called)?\s+["']?(.+?)["']?\.?$/i);
  if (match) {
    const next = structuredClone(current);
    const name = match[1].trim();
    const id = identifier(name);
    if (next.pages.some(page => page.id === id)) throw new Error(`page already exists: ${id}`);
    next.pages.push({ id, name, path: `/${id}`, layout: 'custom', components: [] });
    return parseAppSpec(next);
  }

  match = clean.match(/^remove (?:the )?page\s+["']?(.+?)["']?\.?$/i);
  if (match) {
    if (current.pages.length === 1) throw new Error('a tool must keep at least one page');
    const requested = match[1].trim().toLowerCase();
    const next = structuredClone(current);
    const before = next.pages.length;
    next.pages = next.pages.filter(page => page.id.toLowerCase() !== requested && page.name.toLowerCase() !== requested);
    if (next.pages.length === before) throw new Error(`page not found: ${match[1].trim()}`);
    return parseAppSpec(next);
  }

  throw new Error('message could not be translated into a safe structured edit');
}

function identifier(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  return (normalized || 'page').replace(/^[^a-z]+/, 'page-');
}
