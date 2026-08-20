# Deployment Guide

## HTTPS Setup (Caddy Reverse Proxy)

RightAPI Forge runs on HTTP port `19123` internally. Caddy terminates TLS and proxies traffic into the container.

### Caddyfile block

```
:8447 {
    tls /etc/ssl/certs/openclaw.crt /etc/ssl/private/openclaw.key

    reverse_proxy itops-agents:19123
}
```

This follows the same pattern as other services on this host. Port `8447` is the HTTPS entry point for RightAPI Forge. The upstream `itops-agents:19123` is reachable because the Caddy container and the RightAPI Forge container share the `root_default` Docker network.

However, the **primary HTTPS block** lives in `/root/Caddyfile` (the Caddyfile bind-mounted into the Caddy container at `/etc/caddy/Caddyfile`):

```
# RightAPI Forge IT Ops — HTTPS
https://beacon.{$NM_DOMAIN} {
    reverse_proxy itops-agents:19123
}
```

This uses Caddy's automatic HTTPS via Let's Encrypt for `beacon.nm.129-159-151-140.nip.io`.

### After editing the Caddyfile, reload Caddy

```bash
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```

### CORS configuration

Set `BEACON_HTTPS_URL` in `.env` to the HTTPS URL you use to access RightAPI Forge:

```env
BEACON_HTTPS_URL=https://beacon.nm.129-159-151-140.nip.io
```

The server adds this to the CORS `allowedOrigins` list alongside `PUBLIC_URL`, so browser requests from the HTTPS origin are accepted.

---

## S3 Off-Host Backups

RightAPI Forge can upload local backup bundles to any S3-compatible object store (AWS S3, Cloudflare R2, MinIO, etc.) after each manual backup creation.

### Backup encryption

Set a dedicated key before enabling or uploading backups:

```env
BACKUP_ENCRYPTION_KEY=<at-least-32-random-characters>
BACKUP_ENCRYPTION_REQUIRED=true
```

New state bundles use AES-256-GCM with a unique nonce and authenticated envelope metadata. Existing plaintext bundles remain readable for migration. Keep the backup key in a separate secret manager and recovery runbook; losing it makes encrypted backups unrecoverable. Do not store the key in the backup bucket.

### Configuration

Add these variables to `.env`:

| Variable | Required | Description |
|---|---|---|
| `BACKUP_S3_ENDPOINT` | ✅ | e.g. `https://s3.amazonaws.com` or `https://<account>.r2.cloudflarestorage.com` |
| `BACKUP_S3_BUCKET` | ✅ | Destination bucket name |
| `BACKUP_S3_ACCESS_KEY` | ✅ | Access key ID |
| `BACKUP_S3_SECRET_KEY` | ✅ | Secret access key |
| `BACKUP_S3_REGION` | — | Default: `auto` (Cloudflare R2). Use `us-east-1` for AWS. |
| `BACKUP_S3_RETAIN` | — | How many remote backups to keep. Default: `30` |
| `BACKUP_KEY_CUSTODY_EXTERNAL` | — | Set `true` only after the recovery key is held outside the source host. External secret-provider and `/run/secrets` sources are detected automatically. |

### How it works

1. A full recovery run creates one authenticated encrypted artifact containing state plus online SQLite snapshots.
2. The artifact is uploaded, re-listed, re-downloaded, and compared byte-for-byte by SHA-256 before off-site verification succeeds.
3. Old remote backups beyond `BACKUP_S3_RETAIN` are pruned automatically.
4. `GET /api/system/backups/scheduler` reports object-storage verification and external key-custody readiness separately.

### Verify the integration is active

```bash
curl -s http://localhost:19123/api/health | python3 -m json.tool | grep -A2 s3Backup
```

Expected output when configured:
```json
"s3Backup": {
    "configured": true
}
```

### No SDK required

The uploader uses AWS Signature V4 signing implemented with Node.js built-in `crypto` — no `aws-sdk` or third-party dependencies needed.
