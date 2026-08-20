// Claude AI provider implementation

import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider, ChatParams, AIResponse } from './base.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

export interface ClaudeProviderOptions {
  /** Override the Anthropic API base URL — required when routing through
   *  a proxy like cliproxy that exposes /v1/messages. Default: the SDK's
   *  built-in api.anthropic.com. */
  baseURL?: string;
  /** Override the model id. Default: claude-sonnet-4-6. */
  model?: string;
}

export class ClaudeProvider implements AIProvider {
  name = 'claude';
  private client: Anthropic | null = null;
  private apiKey: string;
  private baseURL?: string;
  private model: string;

  constructor(apiKey: string, opts: ClaudeProviderOptions = {}) {
    this.apiKey = apiKey;
    this.baseURL = opts.baseURL;
    this.model   = opts.model || DEFAULT_MODEL;
  }

  async initialize(): Promise<void> {
    if (!this.apiKey) {
      throw new Error('Anthropic API key is required');
    }
    // baseURL undefined → SDK uses api.anthropic.com. Set, e.g.,
    // http://172.17.0.1:8317 to route via cliproxy.
    this.client = new Anthropic({
      apiKey: this.apiKey,
      ...(this.baseURL ? { baseURL: this.baseURL } : {}),
    });
  }

  async chat(params: ChatParams): Promise<AIResponse> {
    if (!this.client) {
      throw new Error('Claude provider not initialized');
    }

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: params.maxTokens || 8192,
      temperature: params.temperature || 0.7,
      system: params.system,
      messages: params.messages.map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content
      }))
    });

    const content = response.content
      .filter(block => block.type === 'text')
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('\n');

    return {
      content,
      model: response.model,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens
      }
    };
  }

  async streamChat(
    params: ChatParams,
    onChunk: (chunk: string) => void
  ): Promise<AIResponse> {
    if (!this.client) {
      throw new Error('Claude provider not initialized');
    }

    const stream = await this.client.messages.create({
      model: this.model,
      max_tokens: params.maxTokens || 8192,
      temperature: params.temperature || 0.7,
      system: params.system,
      messages: params.messages.map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content
      })),
      stream: true
    });

    let fullContent = '';
    let inputTokens = 0;

    for await (const event of stream) {
      if (event.type === 'message_start') {
        inputTokens = event.message.usage.input_tokens;
      }
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const chunk = event.delta.text;
        fullContent += chunk;
        onChunk(chunk);
      }
    }

    return {
      content: fullContent,
      model: this.model,
      usage: {
        promptTokens: inputTokens,
        completionTokens: fullContent.length / 4,
        totalTokens: inputTokens + fullContent.length / 4
      }
    };
  }

  isAvailable(): boolean {
    // "Configured to be usable", NOT "already initialised". The factory's
    // getDefaultProvider() consults isAvailable() during the priority
    // walk, then calls getProvider() which lazy-initialises. Gating on
    // this.client !== null caused the priority walk to skip past
    // Claude/OpenAI to the first always-available provider (Ollama),
    // even when the API key was set.
    return !!this.apiKey;
  }
}
