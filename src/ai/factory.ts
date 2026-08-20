// AI Provider Factory for multi-platform support

import type { AIPlatform } from './base.js';
import type { AIProvider } from './base.js';
import { ClaudeProvider } from './claude.js';
import { OpenAIProvider } from './openai.js';
import type { OpenAIRouteHealth } from './openai.js';
import { OllamaProvider } from './ollama.js';
import { MoonshotProvider } from './moonshot.js';
import { GLMProvider } from './glm.js';
import { MiniMaxProvider } from './minimax.js';
import { RateLimiter, wrapWithRateLimit, type RateLimitConfig } from './RateLimiter.js';

export interface AIFactoryOptions {
  /** Pass an existing RateLimiter to share across multiple factories.
   *  Defaults to a fresh instance with platform-tuned caps. */
  rateLimiter?: RateLimiter;
  rateLimit?: Partial<RateLimitConfig>;
  preferredPlatform?: AIPlatform;
}

export class AIProviderFactory {
  private providers: Map<AIPlatform, AIProvider> = new Map();
  private readonly limiter: RateLimiter;
  private readonly preferredPlatform?: AIPlatform;
  private openaiProvider?: OpenAIProvider;

  constructor(credentials: {
    anthropicApiKey?: string;
    /** Optional Anthropic API base URL — set for proxies like cliproxy
     *  that expose /v1/messages. Default: SDK uses api.anthropic.com. */
    anthropicBaseUrl?: string;
    /** Optional Anthropic model override. Default: claude-sonnet-4-6. */
    anthropicModel?: string;
    openaiApiKey?: string;
    /** Optional OpenAI-compatible base URL, such as an internal router. */
    openaiBaseUrl?: string;
    /** Optional OpenAI model override. Default: gpt-4o. */
    openaiModel?: string;
    openaiExpectedModel?: string;
    openaiFallbackBaseUrl?: string;
    openaiFallbackModel?: string;
    openaiFallbackExpectedModel?: string;
    openaiFailureThreshold?: number;
    openaiBreakerOpenMs?: number;
    openaiLatencyBudgetMs?: number;
    openaiErrorRateBudget?: number;
    ollamaBaseUrl?: string;
    ollamaModel?: string;
    moonshotApiKey?: string;
    moonshotBaseUrl?: string;
    glmApiKey?: string;
    glmBaseUrl?: string;
    minimaxApiKey?: string;
    minimaxGroupId?: string;
    minimaxBaseUrl?: string;
  }, opts: AIFactoryOptions = {}) {
    this.limiter = opts.rateLimiter ?? new RateLimiter(opts.rateLimit);
    this.preferredPlatform = opts.preferredPlatform;

    // Each provider is wrapped so every chat / streamChat goes through the
    // limiter. Callers (Agent, SelfReflector) consume the same AIProvider
    // interface and don't need to know the limiter exists.
    const register = (platform: AIPlatform, provider: AIProvider) => {
      this.providers.set(platform, wrapWithRateLimit(provider, this.limiter, platform));
    };

    if (credentials.anthropicApiKey) register('claude',   new ClaudeProvider(credentials.anthropicApiKey, {
      baseURL: credentials.anthropicBaseUrl,
      model:   credentials.anthropicModel,
    }));
    if (credentials.openaiApiKey) {
      this.openaiProvider = new OpenAIProvider(credentials.openaiApiKey, {
        baseURL: credentials.openaiBaseUrl,
        model: credentials.openaiModel,
        expectedModel: credentials.openaiExpectedModel,
        fallbackBaseURL: credentials.openaiFallbackBaseUrl,
        fallbackModel: credentials.openaiFallbackModel,
        fallbackExpectedModel: credentials.openaiFallbackExpectedModel,
        failureThreshold: credentials.openaiFailureThreshold,
        breakerOpenMs: credentials.openaiBreakerOpenMs,
        latencyBudgetMs: credentials.openaiLatencyBudgetMs,
        errorRateBudget: credentials.openaiErrorRateBudget,
      });
      register('openai', this.openaiProvider);
    }
    if (credentials.ollamaBaseUrl)   register('ollama',   new OllamaProvider(credentials.ollamaBaseUrl, credentials.ollamaModel));
    if (credentials.moonshotApiKey)  register('moonshot', new MoonshotProvider(credentials.moonshotApiKey, credentials.moonshotBaseUrl));
    if (credentials.glmApiKey)       register('glm',      new GLMProvider(credentials.glmApiKey, credentials.glmBaseUrl));
    if (credentials.minimaxApiKey)   register('minimax',  new MiniMaxProvider(credentials.minimaxApiKey, credentials.minimaxGroupId, credentials.minimaxBaseUrl));
  }

  /** Read-only view of the limiter state — used by /api/health and the
   *  Settings dashboard so operators can see queue depth at a glance. */
  getRateLimiterStats() { return this.limiter.stats(); }
  /** Runtime override for a platform's concurrency cap. */
  setRateLimit(platform: string, cap: number): void { this.limiter.setCap(platform, cap); }

  async getProvider(platform: AIPlatform): Promise<AIProvider> {
    const provider = this.providers.get(platform);
    if (!provider) {
      throw new Error(`AI provider '${platform}' is not configured`);
    }
    await provider.initialize();
    return provider;
  }

  getAvailablePlatforms(): AIPlatform[] {
    return Array.from(this.providers.keys());
  }

  isPlatformAvailable(platform: AIPlatform): boolean {
    const provider = this.providers.get(platform);
    return provider?.isAvailable() ?? false;
  }

  async getDefaultProvider(): Promise<AIProvider> {
    const defaults: AIPlatform[] = ['claude', 'moonshot', 'glm', 'minimax', 'openai', 'ollama'];
    const priority = this.preferredPlatform
      ? [this.preferredPlatform, ...defaults.filter(platform => platform !== this.preferredPlatform)]
      : defaults;
    for (const platform of priority) {
      if (this.isPlatformAvailable(platform)) {
        return this.getProvider(platform);
      }
    }
    throw new Error('No AI provider is available');
  }

  async probeOpenAIRoutes(marker?: string): Promise<OpenAIRouteHealth[]> {
    if (!this.openaiProvider) return [];
    await this.openaiProvider.initialize();
    return this.openaiProvider.probeRoutes(marker);
  }

  getOpenAIRouteHealth(): OpenAIRouteHealth[] {
    return this.openaiProvider?.getRouteHealth() || [];
  }

  getActiveOpenAIRoute(): 'primary' | 'fallback' | null {
    return this.openaiProvider?.getActiveRoute() || null;
  }

  resetOpenAIRoute(route?: 'primary' | 'fallback'): void {
    this.openaiProvider?.resetRoute(route);
  }
}
