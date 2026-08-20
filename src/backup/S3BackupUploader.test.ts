import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deriveS3SigningKey, S3BackupUploader } from './S3BackupUploader.js';

function configuredUploader(): S3BackupUploader {
  process.env.BACKUP_S3_ENDPOINT = 'https://objects.example.test';
  process.env.BACKUP_S3_BUCKET = 'recovery';
  process.env.BACKUP_S3_ACCESS_KEY = 'access';
  process.env.BACKUP_S3_SECRET_KEY = 'secret';
  process.env.BACKUP_S3_REGION = 'us-east-1';
  process.env.BACKUP_S3_RETAIN = '1';
  return new S3BackupUploader();
}

test('derives the SigV4 signing key in date, region, service, request order', () => {
  const secret = 'test-secret';
  const dateKey = crypto.createHmac('sha256', `AWS4${secret}`).update('20260819').digest();
  const regionKey = crypto.createHmac('sha256', dateKey).update('us-east-1').digest();
  const serviceKey = crypto.createHmac('sha256', regionKey).update('s3').digest();
  const expected = crypto.createHmac('sha256', serviceKey).update('aws4_request').digest('hex');

  assert.equal(deriveS3SigningKey(secret, '20260819', 'us-east-1').toString('hex'), expected);
});

test('streams uploads and checks the S3 response', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-s3-test-'));
  const filePath = path.join(root, 'recovery.itops-recovery');
  fs.writeFileSync(filePath, Buffer.alloc(2 * 1024 * 1024, 7));
  const originalFetch = globalThis.fetch;
  try {
    let received = 0;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as unknown as AsyncIterable<Buffer>;
      for await (const chunk of body) received += chunk.length;
      return new Response('', { status: 200 });
    }) as typeof fetch;
    const result = await configuredUploader().upload(filePath);
    assert.equal(received, fs.statSync(filePath).size);
    assert.equal(result.key, 'beacon-backups/recovery.itops-recovery');

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      for await (const _chunk of init?.body as unknown as AsyncIterable<Buffer>) { /* drain request */ }
      return new Response('unavailable', { status: 503 });
    }) as typeof fetch;
    await assert.rejects(() => configuredUploader().upload(filePath), /S3 upload failed: 503 unavailable/);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('signs list query parameters and rejects list and prune failures', async () => {
  const originalFetch = globalThis.fetch;
  try {
    let requestedUrl = '';
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response('<ListBucketResult><Key>beacon-backups/b</Key><Key>beacon-backups/a</Key></ListBucketResult>', { status: 200 });
    }) as typeof fetch;
    assert.deepEqual(await configuredUploader().listBackups(), ['beacon-backups/a', 'beacon-backups/b']);
    assert.match(requestedUrl, /list-type=2&prefix=beacon-backups%2F$/);

    globalThis.fetch = (async () => new Response('denied', { status: 403 })) as typeof fetch;
    await assert.rejects(() => configuredUploader().listBackups(), /S3 list failed: 403 denied/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('re-downloads an uploaded artifact and verifies its complete checksum', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-s3-verify-'));
  const filePath = path.join(root, 'recovery.itops-recovery');
  const payload = Buffer.from('authenticated recovery envelope');
  fs.writeFileSync(filePath, payload);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(init?.method, undefined);
      assert.match(String(input), /beacon-backups\/recovery\.itops-recovery$/);
      return new Response(payload, { status: 200 });
    }) as typeof fetch;
    const verified = await configuredUploader().verifyUpload(filePath, 'beacon-backups/recovery.itops-recovery');
    assert.equal(verified.bytes, payload.length);
    assert.equal(verified.sha256.length, 64);

    globalThis.fetch = (async () => new Response(Buffer.from('corrupt'), { status: 200 })) as typeof fetch;
    await assert.rejects(
      () => configuredUploader().verifyUpload(filePath, 'beacon-backups/recovery.itops-recovery'),
      /checksum mismatch/,
    );
    await assert.rejects(() => configuredUploader().download('../unsafe', path.join(root, 'bad')), /Invalid S3 backup key/);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
