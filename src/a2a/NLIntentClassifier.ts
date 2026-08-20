/**
 * NLIntentClassifier — uses an LLM to classify a natural-language message
 * into the most relevant A2A skill IDs.
 *
 * Used as an enhancement layer on top of A2APeerRouter's keyword scoring:
 * when the keyword scorer returns no results (or low-confidence results),
 * NL classification is attempted to surface the right agent.
 *
 * Gracefully falls back to null when no LLM is available or the call fails.
 */
import type { AIProviderFactory } from '../ai/factory.js';
import type { A2ASkillCard } from './A2ATypes.js';

export interface NLClassifyResult {
  skillId: string;
  agentId: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

interface CacheEntry {
  result: NLClassifyResult[];
  expiresAt: number;
}

export class NLIntentClassifier {
  /** In-memory cache to avoid repeated LLM calls for the same message */
  private cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs = 60_000; // 1 minute

  constructor(private readonly aiFactory: AIProviderFactory) {}

  /**
   * Classify a natural-language message against a catalogue of skills.
   * Returns ordered matches (best first), or an empty array on failure.
   *
   * @param message  The user's natural language task description
   * @param skills   Flat list of { agentId, skill } pairs to match against
   */
  async classify(
    message: string,
    skills: Array<{ agentId: string; agentName: string; skill: A2ASkillCard }>
  ): Promise<NLClassifyResult[]> {
    if (!skills.length) return [];

    const cacheKey = message.toLowerCase().trim() + '::' + skills.length;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    try {
      const provider = await this.aiFactory.getDefaultProvider();

      // Build a compact skill catalogue for the prompt
      const catalogue = skills
        .map((s, i) => {
          const tags = s.skill.tags?.join(', ') || '';
          const examples = s.skill.examples?.slice(0, 2).join(' / ') || '';
          return `[${i}] id="${s.skill.id}" agent="${s.agentName}" name="${s.skill.name}"${tags ? ` tags="${tags}"` : ''}${examples ? ` examples="${examples}"` : ''}`;
        })
        .join('\n');

      const systemPrompt = `You are an IT operations skill router. Given a user task message and a list of available agent skills, identify the best matching skills.

Rules:
- Return a JSON array of up to 3 matches, best first
- Each match: { "index": <number>, "confidence": "high"|"medium"|"low", "reasoning": "<one sentence>" }
- Only include skills that are genuinely relevant (confidence >= medium)
- If nothing matches, return []
- Return ONLY valid JSON, no markdown, no explanation outside the JSON`;

      const userPrompt = `User task: "${message}"

Available skills:
${catalogue}

Return JSON array of matches:`;

      const response = await provider.chat({
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: 512,
        temperature: 0.1,
      });

      const raw = response.content.trim();
      // Strip markdown code fences if present
      const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      const parsed = JSON.parse(jsonText) as Array<{
        index: number;
        confidence: 'high' | 'medium' | 'low';
        reasoning: string;
      }>;

      const results: NLClassifyResult[] = parsed
        .filter(m => typeof m.index === 'number' && m.index >= 0 && m.index < skills.length)
        .map(m => ({
          skillId: skills[m.index].skill.id,
          agentId: skills[m.index].agentId,
          confidence: m.confidence,
          reasoning: m.reasoning,
        }));

      this.cache.set(cacheKey, { result: results, expiresAt: Date.now() + this.cacheTtlMs });
      return results;
    } catch {
      // LLM unavailable or parse failed — graceful degradation
      return [];
    }
  }

  clearCache(): void {
    this.cache.clear();
  }
}
