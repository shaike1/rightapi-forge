import crypto from 'crypto';

interface ApprovalTokenPayload {
  tokenId: string;
  command: string;
  agentId: string;
  approver: string;
  reason?: string;
  issuedAt: string;
  expiresAt: string;
}

export interface MintApprovalParams {
  command: string;
  agentId: string;
  approver: string;
  reason?: string;
  ttlSeconds?: number;
}

export interface MintedApprovalToken {
  token: string;
  tokenId: string;
  command: string;
  agentId: string;
  approver: string;
  issuedAt: string;
  expiresAt: string;
}

export interface ApprovalValidationResult {
  valid: boolean;
  reason?: string;
  payload?: ApprovalTokenPayload;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function fromBase64Url(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/')
    + '==='.slice((input.length + 3) % 4);
  return Buffer.from(padded, 'base64');
}

export class ApprovalTokenService {
  private secret: string;

  constructor(secret: string) {
    this.secret = secret;
  }

  mint(params: MintApprovalParams): MintedApprovalToken {
    const issuedAt = new Date();
    const ttl = Math.min(Math.max(params.ttlSeconds || 600, 30), 3600);
    const expiresAt = new Date(issuedAt.getTime() + ttl * 1000);
    const payload: ApprovalTokenPayload = {
      tokenId: crypto.randomUUID(),
      command: params.command,
      agentId: params.agentId,
      approver: params.approver,
      reason: params.reason,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    };

    const header = { alg: 'HS256', typ: 'ITOPS-APPROVAL' };
    const headerPart = base64Url(JSON.stringify(header));
    const payloadPart = base64Url(JSON.stringify(payload));
    const signature = this.sign(`${headerPart}.${payloadPart}`);
    const token = `${headerPart}.${payloadPart}.${signature}`;

    return {
      token,
      tokenId: payload.tokenId,
      command: payload.command,
      agentId: payload.agentId,
      approver: payload.approver,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt
    };
  }

  validate(params: { token?: string; command: string; agentId: string }): ApprovalValidationResult {
    if (!params.token) {
      return { valid: false, reason: 'Missing approval token' };
    }
    const parts = params.token.split('.');
    if (parts.length !== 3) {
      return { valid: false, reason: 'Invalid approval token format' };
    }

    const [headerPart, payloadPart, signature] = parts;
    const expected = this.sign(`${headerPart}.${payloadPart}`);
    const actualSig = Buffer.from(signature);
    const expectedSig = Buffer.from(expected);
    if (actualSig.length !== expectedSig.length) {
      return { valid: false, reason: 'Invalid approval token signature' };
    }
    const signatureOk = crypto.timingSafeEqual(actualSig, expectedSig);
    if (!signatureOk) {
      return { valid: false, reason: 'Invalid approval token signature' };
    }

    let payload: ApprovalTokenPayload;
    try {
      payload = JSON.parse(fromBase64Url(payloadPart).toString('utf8')) as ApprovalTokenPayload;
    } catch {
      return { valid: false, reason: 'Invalid approval token payload' };
    }

    if (payload.command !== params.command) {
      return { valid: false, reason: 'Approval token command mismatch' };
    }
    if (payload.agentId !== params.agentId) {
      return { valid: false, reason: 'Approval token agent mismatch' };
    }

    const expiry = Date.parse(payload.expiresAt);
    if (!Number.isFinite(expiry) || Date.now() > expiry) {
      return { valid: false, reason: 'Approval token expired' };
    }

    return { valid: true, payload };
  }

  private sign(input: string): string {
    return base64Url(crypto.createHmac('sha256', this.secret).update(input).digest());
  }
}
