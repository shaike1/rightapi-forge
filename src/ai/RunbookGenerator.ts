import type { AIProvider } from './base.js';

export interface GeneratedRunbook {
  name: string;
  description: string;
  steps: any[];
  variables?: Record<string, string>;
  tags?: string[];
  [key: string]: unknown;
}

export class RunbookGenerator {
  async generate(description: string, provider: AIProvider): Promise<GeneratedRunbook> {
    const prompt = `Generate a complete IT ops runbook template as JSON for: "${description}"

The runbook must follow this exact schema:
{
  "name": "kebab-case-name",
  "description": "one line description",
  "steps": [
    {
      "id": "step-1",
      "name": "Step Name",
      "type": "action|condition|notification|approval",
      "command": "skill.method",
      "params": {},
      "expression": "...",
      "message": "...",
      "onSuccess": "step-2",
      "onFailure": "step-error",
      "onTrue": "step-2",
      "onFalse": "step-error"
    }
  ],
  "variables": {"KEY": "default_value"},
  "tags": ["tag1", "tag2"]
}

Available skill commands: bash.execute, ssh.execute, monitoring.checkMetrics,
infrastructure.restartService, alert.send, servicedesk.createIncident

Respond with ONLY valid JSON. No markdown, no explanation.`;

    const response = await provider.chat({
      messages: [{ role: 'user', content: prompt }],
      system: 'You are an IT automation expert. Generate precise, executable runbook JSON.',
      maxTokens: 2048,
    });

    // Strip markdown code fences if present
    const clean = response.content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    return JSON.parse(clean) as GeneratedRunbook;
  }
}
