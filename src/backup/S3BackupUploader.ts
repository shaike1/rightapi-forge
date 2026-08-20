/**
 * S3-compatible backup uploader.
 * Works with AWS S3, Cloudflare R2, MinIO, etc.
 *
 * Required env vars:
 *   BACKUP_S3_ENDPOINT   — e.g. https://s3.amazonaws.com or https://<accountid>.r2.cloudflarestorage.com
 *   BACKUP_S3_BUCKET     — bucket name
 *   BACKUP_S3_ACCESS_KEY — access key id
 *   BACKUP_S3_SECRET_KEY — secret access key
 *   BACKUP_S3_REGION     — default 'auto' (for R2) or 'us-east-1'
 *   BACKUP_S3_RETAIN     — number of backups to keep on S3 (default 30)
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

export function deriveS3SigningKey(secretKey: string, dateStamp: string, region: string): Buffer {
  const dateKey = crypto.createHmac('sha256', `AWS4${secretKey}`).update(dateStamp).digest();
  const regionKey = crypto.createHmac('sha256', dateKey).update(region).digest();
  const serviceKey = crypto.createHmac('sha256', regionKey).update('s3').digest();
  return crypto.createHmac('sha256', serviceKey).update('aws4_request').digest();
}

export class S3BackupUploader {
  private endpoint: string;
  private bucket: string;
  private accessKey: string;
  private secretKey: string;
  private region: string;
  private retain: number;

  constructor() {
    this.endpoint = process.env.BACKUP_S3_ENDPOINT || '';
    this.bucket = process.env.BACKUP_S3_BUCKET || '';
    this.accessKey = process.env.BACKUP_S3_ACCESS_KEY || '';
    this.secretKey = process.env.BACKUP_S3_SECRET_KEY || '';
    this.region = process.env.BACKUP_S3_REGION || 'auto';
    this.retain = parseInt(process.env.BACKUP_S3_RETAIN || '30');
  }

  get isConfigured(): boolean {
    return !!(this.endpoint && this.bucket && this.accessKey && this.secretKey);
  }

  // AWS Signature V4 signing (no SDK needed)
  private sign(method: string, urlPath: string, canonicalQuery: string, headers: Record<string, string>, payloadHash: string): Record<string, string> {
    const now = new Date();
    const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');

    const allHeaders: Record<string, string> = {
      ...headers,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
    };

    const signedHeaders = Object.keys(allHeaders).sort().join(';');
    const canonicalHeaders = Object.entries(allHeaders)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k.toLowerCase()}:${v.trim()}`)
      .join('\n') + '\n';

    const canonicalRequest = [method, urlPath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope,
      crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');

    const signingKey = deriveS3SigningKey(this.secretKey, dateStamp, this.region);

    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    return {
      ...allHeaders,
      Authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${credentialScope},SignedHeaders=${signedHeaders},Signature=${signature}`,
    };
  }

  async upload(localPath: string): Promise<{ url: string; key: string }> {
    const fileName = path.basename(localPath);
    const key = `beacon-backups/${fileName}`;
    const bytes = fs.statSync(localPath).size;
    const payloadHash = await hashFile(localPath);
    const url = `${this.endpoint}/${this.bucket}/${key}`;

    const headers = this.sign('PUT', `/${this.bucket}/${key}`, '', {
      host: new URL(this.endpoint).host,
      'content-length': bytes.toString(),
      'content-type': 'application/octet-stream',
    }, payloadHash);

    const response = await fetch(url, { method: 'PUT', headers, body: fs.createReadStream(localPath), duplex: 'half' } as RequestInit & { duplex: 'half' });
    if (!response.ok) throw new Error(`S3 upload failed: ${response.status} ${await response.text()}`);

    return { url, key };
  }

  async listBackups(): Promise<string[]> {
    const prefix = 'beacon-backups/';
    const canonicalQuery = `list-type=2&prefix=${encodeURIComponent(prefix)}`;
    const url = `${this.endpoint}/${this.bucket}?${canonicalQuery}`;
    const emptyHash = crypto.createHash('sha256').update('').digest('hex');
    const headers = this.sign('GET', `/${this.bucket}`, canonicalQuery, { host: new URL(this.endpoint).host }, emptyHash);
    const response = await fetch(url, { headers });
    const text = await response.text();
    if (!response.ok) throw new Error(`S3 list failed: ${response.status} ${text}`);
    const keys = [...text.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]);
    return keys.sort();
  }

  async download(key: string, destination: string): Promise<{ bytes: number; sha256: string }> {
    if (!/^beacon-backups\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(key)) throw new Error('Invalid S3 backup key');
    const encodedKey = key.split('/').map(segment => encodeURIComponent(segment)).join('/');
    const urlPath = `/${this.bucket}/${encodedKey}`;
    const url = `${this.endpoint}${urlPath}`;
    const emptyHash = crypto.createHash('sha256').update('').digest('hex');
    const headers = this.sign('GET', urlPath, '', { host: new URL(this.endpoint).host }, emptyHash);
    const response = await fetch(url, { headers });
    if (!response.ok || !response.body) throw new Error(`S3 download failed: ${response.status} ${await response.text()}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temp = `${destination}.${process.pid}.tmp`;
    try {
      await pipeline(Readable.fromWeb(response.body as any), fs.createWriteStream(temp, { mode: 0o600 }));
      fs.renameSync(temp, destination);
      fs.chmodSync(destination, 0o600);
      return { bytes: fs.statSync(destination).size, sha256: await hashFile(destination) };
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw error;
    }
  }

  /** Re-download the uploaded object and compare its full SHA-256 hash.
   *  A list result alone does not prove that the payload is recoverable. */
  async verifyUpload(localPath: string, key: string): Promise<{ bytes: number; sha256: string }> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-offsite-verify-'));
    try {
      const downloaded = path.join(root, path.basename(localPath));
      const remote = await this.download(key, downloaded);
      const localBytes = fs.statSync(localPath).size;
      const localHash = await hashFile(localPath);
      if (remote.bytes !== localBytes || remote.sha256 !== localHash) {
        throw new Error(`Off-site checksum mismatch for ${key}`);
      }
      return remote;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  async pruneOldBackups(): Promise<number> {
    const keys = await this.listBackups();
    const toDelete = keys.slice(0, Math.max(0, keys.length - this.retain));
    for (const key of toDelete) {
      const url = `${this.endpoint}/${this.bucket}/${key}`;
      const emptyHash = crypto.createHash('sha256').update('').digest('hex');
      const headers = this.sign('DELETE', `/${this.bucket}/${key}`, '', { host: new URL(this.endpoint).host }, emptyHash);
      const response = await fetch(url, { method: 'DELETE', headers });
      if (!response.ok) throw new Error(`S3 delete failed: ${response.status} ${await response.text()}`);
    }
    return toDelete.length;
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
