// Memory System for Agents

export interface MemoryEntry {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'fact';
  content: string;
  metadata?: Record<string, any>;
  timestamp: number;
}

export interface MemoryOptions {
  maxEntries?: number;
  maxTokens?: number;
  importanceThreshold?: number;
}

export class AgentMemory {
  private entries: MemoryEntry[] = [];
  private options: Required<MemoryOptions>;
  
  constructor(options: MemoryOptions = {}) {
    this.options = {
      maxEntries: options.maxEntries || 100,
      maxTokens: options.maxTokens || 8000,
      importanceThreshold: options.importanceThreshold || 0.5
    };
  }

  add(entry: Omit<MemoryEntry, 'id' | 'timestamp'>): void {
    const newEntry: MemoryEntry = {
      ...entry,
      id: 'mem-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9),
      timestamp: Date.now()
    };

    this.entries.push(newEntry);
    this.prune();
  }

  // Add important fact that persists
  addFact(content: string, metadata?: Record<string, any>): void {
    this.add({
      role: 'fact',
      content,
      metadata: { ...metadata, important: true }
    });
  }

  // Get recent messages for context
  getRecentMessages(limit: number = 10): MemoryEntry[] {
    const messages = this.entries
      .filter(e => e.role === 'user' || e.role === 'assistant')
      .slice(-limit);
    return messages;
  }

  // Get important facts
  getFacts(): MemoryEntry[] {
    return this.entries
      .filter(e => e.metadata?.important || e.role === 'fact');
  }

  // Search memory
  search(query: string): MemoryEntry[] {
    const lowerQuery = query.toLowerCase();
    return this.entries
      .filter(e => e.content.toLowerCase().includes(lowerQuery));
  }

  // Get all entries for context
  getContext(maxTokens?: number): string {
    const facts = this.getFacts();
    const recent = this.getRecentMessages(10);
    
    let context = '';
    
    if (facts.length > 0) {
      context += '## Important Facts\n';
      for (const fact of facts.slice(-5)) {
        context += '- ' + fact.content + '\n';
      }
      context += '\n';
    }
    
    context += '## Recent Conversation\n';
    for (const msg of recent) {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      context += role + ': ' + msg.content + '\n';
    }
    
    return context;
  }

  // Clear old entries
  prune(): void {
    if (this.entries.length > this.options.maxEntries) {
      // Keep important facts, remove oldest non-facts
      const important = this.entries.filter(e => e.metadata?.important || e.role === 'fact');
      const regular = this.entries
        .filter(e => !e.metadata?.important && e.role !== 'fact')
        .sort((a, b) => b.timestamp - a.timestamp);
      
      const toKeep = [...important, ...regular.slice(0, this.options.maxEntries - important.length)];
      this.entries = toKeep.sort((a, b) => a.timestamp - b.timestamp);
    }
  }

  // Clear all
  clear(): void {
    this.entries = [];
  }

  // Get stats
  stats(): { total: number; facts: number; messages: number } {
    return {
      total: this.entries.length,
      facts: this.entries.filter(e => e.role === 'fact').length,
      messages: this.entries.filter(e => e.role === 'user' || e.role === 'assistant').length
    };
  }
}
