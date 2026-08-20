// OpenAI AI provider implementation

import OpenAI from 'openai';
import type { AIProvider, ChatParams, AIResponse } from './base.js';
import { AIProxyGuard, type BreakerState } from './AIProxyGuard.js';

const DEFAULT_MODEL = 'gpt-4o';

export interface OpenAIProviderOptions {
  /** OpenAI-compatible API base URL. Leave unset for api.openai.com. */
  baseURL?: string;
  /** Model name sent to the configured endpoint. */
  model?: string;
  /** Optional ITOPS-only fallback route. It is tried after the primary
   *  route fails or its breaker is open. */
  fallbackBaseURL?: string;
  fallbackModel?: string;
  /** Expected route identities. A mismatch fails closed before inference. */
  expectedModel?: string;
  fallbackExpectedModel?: string;
  failureThreshold?: number;
  breakerOpenMs?: number;
  latencyBudgetMs?: number;
  errorRateBudget?: number;
}

export interface OpenAIRouteHealth {
  route: 'primary' | 'fallback';
  configured: boolean;
  baseURL: string | null;
  model: string | null;
  expectedModel: string | null;
  modelAligned: boolean;
  breaker: { state: BreakerState; failureCount: number; openedAt: number; resetMs: number };
  attempts: number;
  successes: number;
  failures: number;
  errorRate: number;
  averageLatencyMs: number | null;
  p95LatencyMs: number | null;
  lastLatencyMs: number | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  lastResponseModel: string | null;
  latencyBudgetMs: number;
  errorRateBudget: number;
  budgetExceeded: boolean;
}

interface RouteStats {
  attempts: number;
  successes: number;
  failures: number;
  outcomes: boolean[];
  latencies: number[];
  lastLatencyMs: number | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  lastResponseModel: string | null;
}

interface OpenAIRoute {
  route: 'primary' | 'fallback';
  baseURL?: string;
  model: string;
  expectedModel?: string;
  client: OpenAI | null;
  guard: AIProxyGuard;
  stats: RouteStats;
}

export class OpenAIProvider implements AIProvider {
  name = 'openai';
  private apiKey: string;
  private routes: OpenAIRoute[];
  private latencyBudgetMs: number;
  private errorRateBudget: number;
  private activeRoute: 'primary' | 'fallback' | null = null;

  constructor(apiKey: string, opts: OpenAIProviderOptions = {}) {
    this.apiKey = apiKey;
    this.latencyBudgetMs = Math.max(1, opts.latencyBudgetMs ?? 30_000);
    this.errorRateBudget = Math.min(1, Math.max(0, opts.errorRateBudget ?? 0.2));
    const guardOpts = {
      failureThreshold: Math.max(1, opts.failureThreshold ?? 3),
      openMs: Math.max(1, opts.breakerOpenMs ?? 60_000),
      maxRetries: 0,
    };
    this.routes = [{
      route: 'primary', baseURL: opts.baseURL, model: opts.model || DEFAULT_MODEL,
      expectedModel: opts.expectedModel, client: null, guard: new AIProxyGuard(guardOpts), stats: emptyStats(),
    }];
    if (opts.fallbackModel || opts.fallbackBaseURL) {
      this.routes.push({
        route: 'fallback', baseURL: opts.fallbackBaseURL || opts.baseURL,
        model: opts.fallbackModel || opts.model || DEFAULT_MODEL,
        expectedModel: opts.fallbackExpectedModel,
        client: null, guard: new AIProxyGuard(guardOpts), stats: emptyStats(),
      });
    }
  }

  async initialize(): Promise<void> {
    if (!this.apiKey) {
      throw new Error('OpenAI API key is required');
    }
    for (const route of this.routes) {
      route.client = new OpenAI({ apiKey: this.apiKey, ...(route.baseURL ? { baseURL: route.baseURL } : {}) });
    }
  }

  async chat(params: ChatParams): Promise<AIResponse> {
    const messages = params.system
      ? [{ role: 'system' as const, content: params.system }, ...params.messages]
      : params.messages;
    return this.withFailover('chat', async route => {
      const response = await route.client!.chat.completions.create({
        model: route.model,
        messages: messages as Array<{role: 'system' | 'user' | 'assistant'; content: string}>,
        max_tokens: params.maxTokens ?? 8192,
        temperature: params.temperature ?? 0.7,
      });
      return responseToAI(response);
    });
  }

  async streamChat(
    params: ChatParams,
    onChunk: (chunk: string) => void
  ): Promise<AIResponse> {
    const messages = params.system
      ? [{ role: 'system' as const, content: params.system }, ...params.messages]
      : params.messages;

    return this.withFailover('stream', async route => {
      const stream = await route.client!.chat.completions.create({
        model: route.model,
        messages: messages as Array<{role: 'system' | 'user' | 'assistant'; content: string}>,
        max_tokens: params.maxTokens ?? 8192,
        temperature: params.temperature ?? 0.7,
        stream: true,
      });
      const buffered: string[] = [];
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) buffered.push(content);
      }
      const fullContent = buffered.join('');
      buffered.forEach(onChunk);
      return {
        content: fullContent, model: route.model,
        usage: { promptTokens: 0, completionTokens: Math.ceil(fullContent.length / 4), totalTokens: Math.ceil(fullContent.length / 4) },
      };
    });
  }

  isAvailable(): boolean {
    // "Configured to be usable", NOT "already initialised". See the
    // matching comment in ClaudeProvider.isAvailable for why a
    // this.client-null gate breaks getDefaultProvider's priority walk.
    return !!this.apiKey;
  }

  async probeRoutes(marker = 'ITOPS_PROBE_OK'): Promise<OpenAIRouteHealth[]> {
    for (const route of this.routes) {
      try {
        const response = await this.runRoute(route, `probe.${route.route}`, async () => {
          const out = await route.client!.chat.completions.create({
            model: route.model,
            messages: [{ role: 'user', content: `Reply exactly ${marker}` }],
            max_tokens: 32,
            temperature: 0,
          });
          const parsed = responseToAI(out);
          if (!parsed.content.includes(marker)) throw new Error(`synthetic response missing marker ${marker}`);
          return parsed;
        });
        route.stats.lastResponseModel = response.model || null;
      } catch { /* state is captured by runRoute */ }
    }
    return this.getRouteHealth();
  }

  getRouteHealth(): OpenAIRouteHealth[] {
    return this.routes.map(route => {
      const recent = route.stats.outcomes;
      const failures = recent.filter(ok => !ok).length;
      const errorRate = recent.length ? failures / recent.length : 0;
      const sortedLatency = [...route.stats.latencies].sort((a, b) => a - b);
      const p95Index = Math.max(0, Math.ceil(sortedLatency.length * 0.95) - 1);
      const averageLatencyMs = sortedLatency.length
        ? sortedLatency.reduce((sum, value) => sum + value, 0) / sortedLatency.length : null;
      const p95LatencyMs = sortedLatency.length ? sortedLatency[p95Index] : null;
      const modelAligned = !route.expectedModel || route.model === route.expectedModel;
      return {
        route: route.route, configured: Boolean(route.client), baseURL: route.baseURL || null,
        model: route.model, expectedModel: route.expectedModel || null, modelAligned,
        breaker: route.guard.snapshot(), attempts: route.stats.attempts,
        successes: route.stats.successes, failures: route.stats.failures,
        errorRate, averageLatencyMs, p95LatencyMs, lastLatencyMs: route.stats.lastLatencyMs,
        lastAttemptAt: route.stats.lastAttemptAt, lastSuccessAt: route.stats.lastSuccessAt,
        lastFailureAt: route.stats.lastFailureAt, lastError: route.stats.lastError,
        lastResponseModel: route.stats.lastResponseModel,
        latencyBudgetMs: this.latencyBudgetMs, errorRateBudget: this.errorRateBudget,
        budgetExceeded: !modelAligned || errorRate > this.errorRateBudget || (p95LatencyMs !== null && p95LatencyMs > this.latencyBudgetMs),
      };
    });
  }

  getActiveRoute(): 'primary' | 'fallback' | null { return this.activeRoute; }

  resetRoute(routeName?: 'primary' | 'fallback'): void {
    for (const route of this.routes) {
      if (!routeName || route.route === routeName) route.guard.reset('operator reset');
    }
  }

  private async withFailover(label: string, operation: (route: OpenAIRoute) => Promise<AIResponse>): Promise<AIResponse> {
    let lastError: unknown;
    for (const route of this.routes) {
      try {
        const response = await this.runRoute(route, `${label}.${route.route}`, () => operation(route));
        this.activeRoute = route.route;
        return response;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('No OpenAI route is configured');
  }

  private async runRoute<T extends AIResponse>(route: OpenAIRoute, label: string, operation: () => Promise<T>): Promise<T> {
    if (!route.client) throw new Error('OpenAI provider not initialized');
    const started = Date.now();
    const at = new Date().toISOString();
    route.stats.attempts++;
    route.stats.lastAttemptAt = at;
    try {
      const response = await route.guard.run(label, async () => {
        if (route.expectedModel && route.model !== route.expectedModel) {
          throw new Error(`route/model mismatch: configured=${route.model} expected=${route.expectedModel}`);
        }
        return operation();
      });
      const latency = Date.now() - started;
      route.stats.successes++;
      route.stats.lastSuccessAt = new Date().toISOString();
      route.stats.lastLatencyMs = latency;
      route.stats.lastError = null;
      route.stats.lastResponseModel = response.model || null;
      pushWindow(route.stats.outcomes, true);
      pushWindow(route.stats.latencies, latency);
      return response;
    } catch (error) {
      route.stats.failures++;
      route.stats.lastFailureAt = new Date().toISOString();
      route.stats.lastLatencyMs = Date.now() - started;
      route.stats.lastError = error instanceof Error ? error.message : String(error);
      pushWindow(route.stats.outcomes, false);
      throw error;
    }
  }
}

function emptyStats(): RouteStats {
  return {
    attempts: 0, successes: 0, failures: 0, outcomes: [], latencies: [],
    lastLatencyMs: null, lastAttemptAt: null, lastSuccessAt: null,
    lastFailureAt: null, lastError: null, lastResponseModel: null,
  };
}

function pushWindow<T>(values: T[], value: T): void {
  values.push(value);
  if (values.length > 100) values.splice(0, values.length - 100);
}

function responseToAI(response: any): AIResponse {
  return {
    content: response.choices?.[0]?.message?.content || '',
    model: response.model,
    usage: {
      promptTokens: response.usage?.prompt_tokens || 0,
      completionTokens: response.usage?.completion_tokens || 0,
      totalTokens: response.usage?.total_tokens || 0,
    },
  };
}
