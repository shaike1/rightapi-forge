// Zhipu AI (GLM) Provider - OpenAI compatible API

import OpenAI from 'openai';
import type { AIProvider, ChatParams, AIResponse } from './base.js';

export class GLMProvider implements AIProvider {
  name = 'glm';
  private client: OpenAI | null = null;
  private apiKey: string;
  private baseURL: string;

  constructor(apiKey: string, baseURL: string = 'https://open.bigmodel.cn/api/paas/v4') {
    this.apiKey = apiKey;
    this.baseURL = baseURL;
  }

  async initialize(): Promise<void> {
    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseURL
    });
  }

  isAvailable(): boolean {
    return !!this.client;
  }

  async chat(params: ChatParams): Promise<AIResponse> {
    if (!this.client) {
      throw new Error('GLM provider not initialized');
    }

    const allMessages = [];
    if (params.system) {
      allMessages.push({ role: 'system', content: params.system });
    }
    allMessages.push(...params.messages);

    const model = (params as any).model || 'glm-4';

    try {
      const response = await this.client.chat.completions.create({
        model,
        messages: allMessages as any,
        temperature: params.temperature || 0.7,
        max_tokens: params.maxTokens || 4096
      });

      return {
        content: response.choices[0]?.message?.content || '',
        model: response.model,
        usage: response.usage ? {
          promptTokens: response.usage.prompt_tokens || 0,
          completionTokens: response.usage.completion_tokens || 0,
          totalTokens: response.usage.total_tokens || 0
        } : undefined
      };
    } catch (error: any) {
      throw new Error('GLM API error: ' + error.message);
    }
  }

  async streamChat(
    params: ChatParams,
    onChunk: (chunk: string) => void
  ): Promise<AIResponse> {
    if (!this.client) {
      throw new Error('GLM provider not initialized');
    }

    const allMessages = [];
    if (params.system) {
      allMessages.push({ role: 'system', content: params.system });
    }
    allMessages.push(...params.messages);

    const model = (params as any).model || 'glm-4';

    const stream = await this.client.chat.completions.create({
      model,
      messages: allMessages as any,
      temperature: params.temperature || 0.7,
      max_tokens: params.maxTokens || 4096,
      stream: true
    });

    let fullContent = '';
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        fullContent += content;
        onChunk(content);
      }
    }
    
    return { content: fullContent, model: model };
  }
}
