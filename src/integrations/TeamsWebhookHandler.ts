/**
 * TeamsWebhookHandler — processes inbound messages from MS Teams Outgoing Webhooks
 *
 * Teams sends a POST with:
 *   - Header: Authorization: HMAC <base64-signature>
 *   - Body: { text, from: { name }, channelData, ... }
 *
 * We verify the HMAC-SHA256 signature, strip the @mention prefix,
 * route the message through the A2A task runner, and return the response
 * as a Teams message JSON within 30 seconds.
 */

import crypto from 'crypto';

export interface TeamsIncomingMessage {
  type: string;
  text: string;
  from?: { name?: string; aadObjectId?: string };
  channelData?: { teamsChannelId?: string };
  serviceUrl?: string;
  id?: string;
}

export interface TeamsOutgoingResponse {
  type: 'message';
  text: string;
}

export type AgentRunner = (message: string, userId: string) => Promise<string>;

export class TeamsWebhookHandler {
  private hmacKey: Buffer;

  constructor(
    private outgoingWebhookSecret: string,
    private agentRunner: AgentRunner,
    private timeoutMs = 25_000,
  ) {
    // Teams secret is base64-encoded — decode to raw bytes for HMAC
    this.hmacKey = Buffer.from(outgoingWebhookSecret, 'base64');
  }

  /** Verify the Teams HMAC-SHA256 Authorization header */
  verifySignature(rawBody: Buffer, authHeader: string): boolean {
    if (!authHeader?.startsWith('HMAC ')) return false;
    const provided = authHeader.slice(5); // strip "HMAC "
    const expected = crypto
      .createHmac('sha256', this.hmacKey)
      .update(rawBody)
      .digest('base64');
    try {
      return crypto.timingSafeEqual(
        Buffer.from(provided, 'base64'),
        Buffer.from(expected, 'base64'),
      );
    } catch {
      return false;
    }
  }

  /** Strip Teams @mention markup: <at>BotName</at> → '' */
  private stripMention(text: string): string {
    return text
      .replace(/<at>[^<]*<\/at>/gi, '')
      .replace(/&nbsp;/g, ' ')
      .trim();
  }

  /** Handle a verified inbound Teams message — returns Teams response JSON */
  async handle(msg: TeamsIncomingMessage): Promise<TeamsOutgoingResponse> {
    const rawText = msg.text ?? '';
    const userText = this.stripMention(rawText).trim();
    const userId = msg.from?.name ?? 'Teams User';

    if (!userText) {
      return { type: 'message', text: '👋 Hi! Ask me anything about your IT infrastructure.' };
    }

    try {
      const reply = await Promise.race([
        this.agentRunner(userText, userId),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), this.timeoutMs),
        ),
      ]);
      return { type: 'message', text: reply };
    } catch (err: any) {
      if (err?.message === 'timeout') {
        return { type: 'message', text: '⏳ The agent is taking longer than expected. Please try again shortly.' };
      }
      return { type: 'message', text: `❌ Error: ${err?.message ?? 'Unknown error'}` };
    }
  }
}
