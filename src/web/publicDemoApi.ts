import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router } from 'express';

export interface PublicDemoRequest {
  id: string;
  createdAt: string;
  name: string;
  email: string;
  company: string;
  teamSize: string;
  useCase: string;
  source: 'product-site';
}

export interface PublicDemoApiOptions {
  dataRoot: string;
  notify?: (subject: string, body: string, recipients: string[]) => Promise<void>;
  recipient?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEAM_SIZES = new Set(['1-10', '11-50', '51-200', '201-1000', '1000+']);

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function createPublicDemoRouter(options: PublicDemoApiOptions): Router {
  const router = Router();
  const recipient = options.recipient || 'info@right-api.com';
  const requestPath = path.join(options.dataRoot, 'public-demo-requests.jsonl');

  router.post('/demo-requests', async (req, res) => {
    const website = text(req.body?.website, 200);
    if (website) {
      res.status(202).json({ accepted: true });
      return;
    }

    const name = text(req.body?.name, 100);
    const email = text(req.body?.email, 254).toLowerCase();
    const company = text(req.body?.company, 120);
    const teamSize = text(req.body?.teamSize, 20);
    const useCase = text(req.body?.useCase, 2_000);
    if (name.length < 2 || !EMAIL_RE.test(email) || company.length < 2 || useCase.length < 20) {
      res.status(400).json({
        error: 'Please provide your name, work email, company, and a use case of at least 20 characters.',
        code: 'INVALID_DEMO_REQUEST',
      });
      return;
    }
    if (teamSize && !TEAM_SIZES.has(teamSize)) {
      res.status(400).json({ error: 'Select a valid team size.', code: 'INVALID_TEAM_SIZE' });
      return;
    }

    const record: PublicDemoRequest = {
      id: `demo_${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      name,
      email,
      company,
      teamSize,
      useCase,
      source: 'product-site',
    };
    fs.mkdirSync(path.dirname(requestPath), { recursive: true });
    fs.appendFileSync(requestPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });

    if (options.notify) {
      const body = [
        'New RightAPI Forge demo request',
        `Request: ${record.id}`,
        `Name: ${record.name}`,
        `Email: ${record.email}`,
        `Company: ${record.company}`,
        `Team size: ${record.teamSize || 'Not specified'}`,
        '',
        record.useCase,
      ].join('\n');
      options.notify(`RightAPI Forge demo request from ${record.company}`, body, [recipient])
        .catch(() => undefined);
    }

    res.status(201).json({ accepted: true, requestId: record.id });
  });

  return router;
}
