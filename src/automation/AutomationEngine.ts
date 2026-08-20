import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger.js';

export interface AutomationRule {
  id: string;
  name: string;
  trigger: {
    type: 'task_completed' | 'agent_offline' | 'threshold_exceeded' | 'keyword_detected';
    condition: string;
  };
  action: {
    type: 'notify' | 'run_task' | 'restart_service' | 'alert';
    target: string;
  };
  enabled: boolean;
  createdAt: Date;
}

export interface AgentMemory {
  agentId: string;
  interactions: {
    timestamp: Date;
    type: 'task' | 'chat' | 'command';
    summary: string;
    success: boolean;
  }[];
  preferences: Record<string, any>;
  lastActive: Date;
}

export class AutomationEngine {
  private static instance: AutomationEngine;
  private rules: Map<string, AutomationRule> = new Map();
  private memory: Map<string, AgentMemory> = new Map();
  private dataPath: string;

  private constructor() {
    this.dataPath = path.join(process.cwd(), 'data');
    this.loadRules();
    this.loadMemory();
  }

  static getInstance(): AutomationEngine {
    if (!AutomationEngine.instance) {
      AutomationEngine.instance = new AutomationEngine();
    }
    return AutomationEngine.instance;
  }

  addRule(rule: AutomationRule): void {
    this.rules.set(rule.id, rule);
    this.saveRules();
  }

  removeRule(id: string): void {
    this.rules.delete(id);
    this.saveRules();
  }

  getRules(): AutomationRule[] {
    return Array.from(this.rules.values());
  }

  enableRule(id: string, enabled: boolean): void {
    const rule = this.rules.get(id);
    if (rule) {
      rule.enabled = enabled;
      this.saveRules();
    }
  }

  recordInteraction(agentId: string, interaction: AgentMemory['interactions'][0]): void {
    let mem = this.memory.get(agentId);
    if (!mem) {
      mem = { agentId, interactions: [], preferences: {}, lastActive: new Date() };
      this.memory.set(agentId, mem);
    }
    mem.interactions.push(interaction);
    mem.lastActive = new Date();
    if (mem.interactions.length > 100) {
      mem.interactions = mem.interactions.slice(-100);
    }
    this.saveMemory();
  }

  getMemory(agentId: string): AgentMemory | undefined {
    return this.memory.get(agentId);
  }

  getRecentInteractions(agentId: string, limit: number = 10): AgentMemory['interactions'] {
    const mem = this.memory.get(agentId);
    if (!mem) return [];
    return mem.interactions.slice(-limit);
  }

  setPreference(agentId: string, key: string, value: any): void {
    const mem = this.memory.get(agentId);
    if (mem) {
      mem.preferences[key] = value;
      this.saveMemory();
    }
  }

  getPreference(agentId: string, key: string): any {
    return this.memory.get(agentId)?.preferences[key];
  }

  private loadRules(): void {
    try {
      const rulesPath = path.join(this.dataPath, 'automation-rules.json');
      if (fs.existsSync(rulesPath)) {
        const data = fs.readFileSync(rulesPath, 'utf-8');
        const rules = JSON.parse(data) as AutomationRule[];
        rules.forEach(r => this.rules.set(r.id, r));
      }
    } catch (error) {
      logger.error('Failed to load rules:', { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    }
  }

  private saveRules(): void {
    try {
      if (!fs.existsSync(this.dataPath)) {
        fs.mkdirSync(this.dataPath, { recursive: true });
      }
      const rulesPath = path.join(this.dataPath, 'automation-rules.json');
      fs.writeFileSync(rulesPath, JSON.stringify(Array.from(this.rules.values()), null, 2));
    } catch (error) {
      logger.error('Failed to save rules:', { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    }
  }

  private loadMemory(): void {
    try {
      const memoryPath = path.join(this.dataPath, 'automation-memory.json');
      if (fs.existsSync(memoryPath)) {
        const data = fs.readFileSync(memoryPath, 'utf-8');
        const memories = JSON.parse(data) as AgentMemory[];
        memories.forEach(m => this.memory.set(m.agentId, m));
      }
    } catch (error) {
      logger.error('Failed to load memory:', { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    }
  }

  private saveMemory(): void {
    try {
      if (!fs.existsSync(this.dataPath)) {
        fs.mkdirSync(this.dataPath, { recursive: true });
      }
      const memoryPath = path.join(this.dataPath, 'automation-memory.json');
      fs.writeFileSync(memoryPath, JSON.stringify(Array.from(this.memory.values()), null, 2));
    } catch (error) {
      logger.error('Failed to save memory:', { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    }
  }
}
