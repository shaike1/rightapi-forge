import axios from 'axios';
import { logger } from '../utils/logger.js';

export interface PagerDutyIncident {
  title: string;
  severity: 'critical' | 'error' | 'warning' | 'info';
  source: string;
  summary?: string;
  dedupeKey?: string;
  customDetails?: Record<string, unknown>;
}

export interface PagerDutyConfig {
  integrationKey: string; // Events API v2 routing key
  enabled?: boolean;
}

export class PagerDutyService {
  private config: PagerDutyConfig;
  private static readonly EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue';

  constructor(config: PagerDutyConfig) {
    this.config = config;
  }

  async triggerIncident(incident: PagerDutyIncident): Promise<{ dedupKey: string } | null> {
    if (!this.config.enabled || !this.config.integrationKey) {
      logger.warn('[PagerDuty] disabled or no key configured');
      return null;
    }
    const payload = {
      routing_key: this.config.integrationKey,
      event_action: 'trigger',
      dedup_key: incident.dedupeKey ?? `itops-${Date.now()}`,
      payload: {
        summary: incident.title,
        severity: incident.severity,
        source: incident.source,
        custom_details: {
          summary: incident.summary,
          ...incident.customDetails,
        },
      },
    };
    try {
      const resp = await axios.post(PagerDutyService.EVENTS_URL, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 8000,
      });
      logger.info('[PagerDuty] incident triggered', { status: resp.status, dedup: payload.dedup_key });
      return { dedupKey: payload.dedup_key };
    } catch (e: any) {
      logger.error('[PagerDuty] trigger failed', { message: e.message });
      return null;
    }
  }

  async resolveIncident(dedupeKey: string): Promise<boolean> {
    if (!this.config.enabled || !this.config.integrationKey) return false;
    try {
      await axios.post(PagerDutyService.EVENTS_URL, {
        routing_key: this.config.integrationKey,
        event_action: 'resolve',
        dedup_key: dedupeKey,
      }, { timeout: 8000 });
      logger.info('[PagerDuty] incident resolved', { dedupeKey });
      return true;
    } catch (e: any) {
      logger.error('[PagerDuty] resolve failed', { message: e.message });
      return false;
    }
  }
}
