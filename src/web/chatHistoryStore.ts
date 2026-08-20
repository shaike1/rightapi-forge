import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface ChatMessage {
  id: string;
  agentId: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

type HistoryStore = Record<string, ChatMessage[]>;

const MAX_PER_AGENT = 200;
const RETURN_LIMIT = 50;

export class ChatHistoryStore {
  private filePath: string;
  private store: HistoryStore = {};

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  getHistory(agentId: string): ChatMessage[] {
    const msgs = this.store[agentId] ?? [];
    return msgs.slice(-RETURN_LIMIT);
  }

  append(agentId: string, role: 'user' | 'assistant', text: string): ChatMessage {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      agentId,
      role,
      text,
      timestamp: new Date().toISOString(),
    };
    if (!this.store[agentId]) this.store[agentId] = [];
    this.store[agentId].push(msg);
    if (this.store[agentId].length > MAX_PER_AGENT) {
      this.store[agentId] = this.store[agentId].slice(-MAX_PER_AGENT);
    }
    this.save();
    return msg;
  }

  clear(agentId: string): void {
    delete this.store[agentId];
    this.save();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      this.store = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as HistoryStore;
    } catch {
      this.store = {};
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.store), 'utf8');
  }
}
