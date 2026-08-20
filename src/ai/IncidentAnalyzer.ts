import { AIProviderFactory } from './factory.js';

export interface IncidentAnalysis {
  rootCauseLikely: string;
  confidence: 'high' | 'medium' | 'low';
  remediationSteps: string[];
  preventionTips: string[];
  estimatedImpact: string;
  relatedSystems: string[];
  priority: 'immediate' | 'soon' | 'monitor';
}

export class IncidentAnalyzer {
  constructor(private factory: AIProviderFactory) {}

  async analyze(incident: any, similarIncidents: any[]): Promise<IncidentAnalysis> {
    const provider = await this.factory.getDefaultProvider();

    const prompt = `You are an IT operations expert. Analyze this incident and provide actionable insights.

INCIDENT:
Title: ${incident.title}
Severity: ${incident.severity}
Status: ${incident.status}
Description: ${incident.description || 'N/A'}
Created: ${incident.createdAt}

SIMILAR PAST INCIDENTS (last 10):
${similarIncidents.map(i => `- [${i.severity}] ${i.title} → resolved: ${i.resolution || i.description || 'N/A'}`).join('\n') || 'None found'}

Provide a JSON response with:
{
  "rootCauseLikely": "string — most likely root cause",
  "confidence": "high|medium|low",
  "remediationSteps": ["step1", "step2", ...],
  "preventionTips": ["tip1", "tip2"],
  "estimatedImpact": "string",
  "relatedSystems": ["system1", ...],
  "priority": "immediate|soon|monitor"
}`;

    const response = await provider.chat({
      messages: [{ role: 'user', content: prompt }],
      system: 'You are an expert IT operations analyst. Always respond with valid JSON only, no markdown.',
      maxTokens: 1024,
    });

    try {
      // Strip markdown code fences if present
      const clean = response.content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      return JSON.parse(clean) as IncidentAnalysis;
    } catch {
      return {
        rootCauseLikely: response.content,
        confidence: 'low',
        remediationSteps: [],
        preventionTips: [],
        estimatedImpact: 'Unknown',
        relatedSystems: [],
        priority: 'monitor',
      };
    }
  }
}
