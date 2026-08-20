// Ollama AI provider implementation for local models

import type { AIProvider, ChatParams, AIResponse } from './base.js';

interface OllamaMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface OllamaResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
}

interface OllamaStreamChunk {
  model: string;
  done: boolean;
  message?: { role: string; content: string };
}

export class OllamaProvider implements AIProvider {
  name = 'ollama';
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string = 'http://localhost:11434', model: string = 'llama3') {
    this.baseUrl = baseUrl;
    this.model = model;
  }

  async initialize(): Promise<void> {
    // Check if Ollama is running
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        throw new Error('Ollama is not responding');
      }
    } catch (error) {
      throw new Error(`Failed to connect to Ollama at ${this.baseUrl}: ${error}`);
    }
  }

  async chat(params: ChatParams): Promise<AIResponse> {
    const messages = params.system
      ? [{ role: 'system' as const, content: params.system }, ...params.messages]
      : params.messages;

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: messages as OllamaMessage[],
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.statusText}`);
    }

    const data = (await response.json()) as OllamaResponse;

    return {
      content: data.message.content,
      model: data.model,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0
      }
    };
  }

  async streamChat(
    params: ChatParams,
    onChunk: (chunk: string) => void
  ): Promise<AIResponse> {
    const messages = params.system
      ? [{ role: 'system' as const, content: params.system }, ...params.messages]
      : params.messages;

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: messages as OllamaMessage[],
        stream: true
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama stream request failed: ${response.statusText}`);
    }

    let fullContent = '';
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    if (!reader) {
      throw new Error('Failed to get response reader');
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const data = JSON.parse(line) as OllamaStreamChunk;
          if (data.message?.content) {
            fullContent += data.message.content;
            onChunk(data.message.content);
          }
        } catch {
          // Skip invalid JSON lines
        }
      }
    }

    return {
      content: fullContent,
      model: this.model,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0
      }
    };
  }

  isAvailable(): boolean {
    return true;
  }

  setModel(model: string): void {
    this.model = model;
  }
}
