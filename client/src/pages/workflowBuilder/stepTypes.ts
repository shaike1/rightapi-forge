// Step-type catalogue for the visual workflow builder.
//
// Single source of truth for: palette entries, default values seeded
// when a node is dropped, the colour each step renders with, and the
// short identifier used inside generated WorkflowDef JSON. Adding a
// new step type is one entry here + a render branch in the property
// editor.

export const STEP_TYPES = [
  {
    type: 'bash',
    label: 'Bash',
    color: '#6ee7b7',
    desc: 'Run a shell command via bash.exec',
    defaults: () => ({ command: 'echo hello' }),
  },
  {
    type: 'skill',
    label: 'Skill',
    color: '#7cc4ff',
    desc: 'Invoke any registered skill',
    defaults: () => ({ skill: 'monitor.systemHealth', params: {} }),
  },
  {
    type: 'api_call',
    label: 'API Call',
    color: '#f5a62a',
    desc: 'HTTP request to a URL',
    defaults: () => ({ url: 'https://example.test/health', method: 'GET' as const }),
  },
  {
    type: 'delegation',
    label: 'Delegate',
    color: '#c084fc',
    desc: 'Hand the task to another agent',
    defaults: () => ({ toAgentId: 'specialist-1', objective: '' }),
  },
  {
    type: 'approval_gate',
    label: 'Approval',
    color: '#fb7185',
    desc: 'Pause until an approval token is provided',
    defaults: () => ({ command: 'deploy.prod' }),
  },
  {
    type: 'conditional',
    label: 'Conditional',
    color: '#facc15',
    desc: 'Branch on a runtime expression',
    defaults: () => ({ when: '${steps.previous.ok}', then: '', else: '' }),
  },
] as const;

export type StepType = (typeof STEP_TYPES)[number]['type'];

export function colorFor(type: string): string {
  return STEP_TYPES.find(t => t.type === type)?.color ?? '#9CA3AF';
}
export function defaultsFor(type: StepType): Record<string, unknown> {
  return STEP_TYPES.find(t => t.type === type)!.defaults();
}

/** What goes inside the small body preview of a node. Pure function so
 *  the node component can render without state. */
export function nodePreview(data: Record<string, unknown>): string {
  switch (data.type) {
    case 'bash':          return String(data.command ?? '');
    case 'skill':         return String(data.skill ?? '');
    case 'api_call':      return `${data.method ?? 'GET'} ${String(data.url ?? '')}`;
    case 'delegation':    return `→ ${String(data.toAgentId ?? '')}\n${String(data.objective ?? '')}`;
    case 'approval_gate': return `approve: ${String(data.command ?? '')}`;
    case 'conditional':   return `if ${String(data.when ?? '')}`;
    default:              return '';
  }
}
