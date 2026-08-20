// Base AI provider interface

import type { AIResponse, ExecutionContext, AIPlatform } from '../types/index.js';

export interface AIProvider {
  name: string;
  initialize(): Promise<void>;
  chat(params: ChatParams): Promise<AIResponse>;
  streamChat(params: ChatParams, onChunk: (chunk: string) => void): Promise<AIResponse>;
  isAvailable(): boolean;
}

export interface ChatParams {
  messages: Array<{role: 'user' | 'assistant' | 'system'; content: string}>;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  context?: ExecutionContext;
}

export type { AIResponse, AIPlatform };
