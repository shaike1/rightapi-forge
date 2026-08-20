// Tool Registry with Zod Validation

import { z } from 'zod';
import { logger } from './utils/logger.js';

export interface Tool<TInput = any, TOutput = any> {
  name: string;
  description: string;
  parameters: z.ZodType<TInput>;
  execute: (input: TInput) => Promise<TOutput>;
  guardrails?: ToolGuardrail[];
}

export interface ToolGuardrail {
  name: string;
  check: (input: any) => Promise<{ allowed: boolean; message?: string }>;
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  private middleware: Array<(tool: string, input: any) => Promise<any>> = [];

  register<TInput, TOutput>(name: string, tool: Tool<TInput, TOutput>): void {
    if (this.tools.has(name)) {
      logger.warn('Tool already registered:', { name });
    }
    this.tools.set(name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Array<{ name: string; description: string }> {
    return Array.from(this.tools.values()).map(t => ({
      name: t.name,
      description: t.description
    }));
  }

  addMiddleware(fn: (tool: string, input: any) => Promise<any>): void {
    this.middleware.push(fn);
  }

  async execute<TInput>(toolName: string, input: TInput): Promise<{ success: boolean; result?: any; error?: string }> {
    const tool = this.tools.get(toolName);
    
    if (!tool) {
      return { success: false, error: 'Tool not found: ' + toolName };
    }

    try {
      const validatedInput = tool.parameters.parse(input);

      if (tool.guardrails) {
        for (const guardrail of tool.guardrails) {
          const check = await guardrail.check(validatedInput);
          if (!check.allowed) {
            return { 
              success: false, 
              error: 'Guardrail blocked: ' + check.message 
            };
          }
        }
      }

      let finalInput = validatedInput;
      for (const mw of this.middleware) {
        finalInput = await mw(toolName, finalInput);
      }

      const result = await tool.execute(finalInput);
      return { success: true, result };

    } catch (error: any) {
      if (error instanceof z.ZodError) {
        const messages = error.errors.map((e: any) => e.message).join(', ');
        return { 
          success: false, 
          error: 'Validation error: ' + messages
        };
      }
      return { success: false, error: error.message };
    }
  }
}

// Example: Deploy Tool with Guardrails
const productionGuardrail: ToolGuardrail = {
  name: 'production-block',
  check: async (input: any) => {
    if (input.environment === 'production') {
      return {
        allowed: false,
        message: 'Production deployments require approval'
      };
    }
    return { allowed: true };
  }
};

export const deployTool = {
  name: 'deploy.start',
  description: 'Start a deployment',
  parameters: z.object({
    service: z.string().min(1),
    environment: z.enum(['dev', 'staging', 'production']),
    version: z.string()
  }),
  guardrails: [productionGuardrail],
  execute: async (input: any) => {
    return { 
      deploymentId: 'deploy-' + Date.now(),
      status: 'started',
      ...input 
    };
  }
};
