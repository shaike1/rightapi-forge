import crypto from 'crypto';

export interface WebhookValidation {
  valid: boolean;
  error?: string;
}

/**
 * Validate Slack webhook signatures
 * https://api.slack.com/authentication/verifying-requests-from-slack
 * Requires SLACK_SIGNING_SECRET env var to be set on the receiving endpoint.
 */
export function validateSlackWebhook(
  body: Buffer,
  signature: string,
  timestamp: string,
  signingSecret: string
): WebhookValidation {
  // Reject requests older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    return { valid: false, error: 'Request timestamp too old' };
  }
  const sigBasestring = `v0:${timestamp}:${body.toString()}`;
  const mySignature = 'v0=' + crypto
    .createHmac('sha256', signingSecret)
    .update(sigBasestring)
    .digest('hex');
  const valid = crypto.timingSafeEqual(
    Buffer.from(mySignature), Buffer.from(signature)
  );
  return { valid };
}

/**
 * Validate Discord webhook signatures (Ed25519)
 * For Discord Interactions endpoint (not outbound webhooks)
 */
export function validateDiscordInteraction(
  body: Buffer,
  signature: string,
  timestamp: string,
  publicKey: string
): WebhookValidation {
  try {
    const isValid = crypto.verify(
      'ed25519',
      Buffer.from(timestamp + body.toString()),
      Buffer.from(publicKey, 'hex'),
      Buffer.from(signature, 'hex')
    );
    return { valid: isValid };
  } catch {
    return { valid: false, error: 'Invalid signature format' };
  }
}

/**
 * Generic HMAC-SHA256 webhook validator (for custom integrations)
 */
export function validateHmacWebhook(
  body: Buffer,
  signature: string,
  secret: string,
  prefix = 'sha256='
): WebhookValidation {
  if (!signature.startsWith(prefix)) {
    return { valid: false, error: `Signature must start with ${prefix}` };
  }
  const expected = prefix + crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  try {
    const valid = crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature)
    );
    return { valid };
  } catch {
    return { valid: false, error: 'Signature length mismatch' };
  }
}
