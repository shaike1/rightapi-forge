# Multi-Tenant Deployment

RightAPI Forge supports three ways to identify the tenant for an incoming
request, in priority order:

1. **Custom domain** — full `Host:` header matches a tenant's
   registered `custom_domain`. Example:
   `support.acme.com` → tenant `acme`.
2. **Subdomain on the base domain** — `Host:` is
   `<slug>-<apex-label>.<root-domain>`, where
   `<apex-label>.<root-domain>` equals `TENANT_BASE_DOMAIN`. Example
   with `TENANT_BASE_DOMAIN=itops.example.com`:
   `acme-itops.example.com` → tenant slug `acme`.
3. **JWT `tid` claim** — the authenticated principal's tenant. This
   is the legacy single-tenant path; if no host-based signal matches,
   RightAPI Forge falls through to the JWT, then to `X-Tenant-ID` (admin
   override), then to the system tenant.

Subdomain support is **off by default**. Set `TENANT_BASE_DOMAIN` in
the runtime environment to enable it.

### Why the flat `<slug>-itops.example.com` pattern

Cloudflare's free **Universal SSL** covers exactly one wildcard level
(`*.example.com`). A nested pattern like `<slug>.itops.example.com`
would need the **Advanced Certificate** add-on ($10/month per zone).

Flattening tenant hostnames to `acme-itops.example.com` keeps every
tenant inside the free wildcard cert. The RightAPI Forge apex itself remains
`itops.example.com` (also covered by the same wildcard).

---

## 1. Environment configuration

Add to `.env` (or your secret provider):

```
TENANT_BASE_DOMAIN=itops.example.com
# Optional — slug values that should NEVER be treated as a tenant.
# The default list covers labels we don't want shadowed by tenant URLs
# (e.g. www-itops.example.com, api-itops.example.com):
#   www, api, app, admin, static, cdn, mail, docs
TENANT_RESERVED_SUBDOMAINS=www,api,app,admin,static,cdn,mail,docs
```

Restart RightAPI Forge. The deep health probe at `/api/health` returns
`healthy` immediately — the resolver is a request-scope component
with no separate boot step.

---

## 2. DNS

RightAPI Forge receives the `Host:` header verbatim; everything else is its
job. With Cloudflare Tunnel in front, you don't need a public A record
at all — the tunnel pulls traffic into the box from inside the
Cloudflare network.

### Wildcard CNAME via Cloudflare Tunnel

Create a single wildcard CNAME on the `example.com` zone pointing at
the tunnel hostname. All `*-itops.example.com` names resolve through
the same tunnel:

```
*-itops.example.com.   1   IN   CNAME   <TUNNEL_ID>.cfargotunnel.com.
itops.example.com.     1   IN   CNAME   <TUNNEL_ID>.cfargotunnel.com.
```

A tenant created with slug `acme` is reachable at
`acme-itops.example.com` the moment the CNAME and Cloudflare's edge
cache propagate (usually < 1 minute).

> **Note:** the wildcard CNAME must be marked **proxied** (orange
> cloud) in the Cloudflare UI so the tunnel can answer for it.

### Per-tenant custom domain

The tenant admin sets their hostname via the Tenant Settings page
(General → Custom domain) or via the API:

```
PUT /api/tenant/settings/domain
{ "customDomain": "support.acme.com" }
```

Then **the tenant** points the hostname at RightAPI Forge via a CNAME to the
same tunnel hostname:

```
support.acme.com.   1   IN   CNAME   <TUNNEL_ID>.cfargotunnel.com.
```

For a tenant on a different Cloudflare account, they CNAME to a
public `A` record fronted by their own TLS termination, or onboard
their zone into the RightAPI Forge-owned Cloudflare account.

---

## 3. TLS

TLS is terminated by **Cloudflare's edge**, not by RightAPI Forge. The free
Universal SSL cert covers:

- The zone apex `example.com`
- One level of wildcard `*.example.com` — which includes both
  `itops.example.com` (the RightAPI Forge apex) and every
  `<slug>-itops.example.com` tenant URL.

Cloudflare → origin (the tunnel) is encrypted by the tunnel itself.
RightAPI Forge serves plain HTTP on `19123` to the tunnel daemon.

For custom-domain tenants, Cloudflare issues a per-hostname cert
automatically once the CNAME is in place and the zone is on a
Cloudflare account that has SSL enabled.

---

## 4. Cloudflare Tunnel (cloudflared)

RightAPI Forge is fronted by `cloudflared` on the server. The relevant section
of `/etc/cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /etc/cloudflared/<TUNNEL_ID>.json

ingress:
  # RightAPI Forge apex — system tenant / marketing UI.
  - hostname: itops.example.com
    service: http://127.0.0.1:19123
    originRequest:
      noTLSVerify: true
      httpHostHeader: itops.example.com

  # Per-tenant subdomains. Single wildcard rule covers every
  # <slug>-itops.example.com; RightAPI Forge's TenantResolver reads the
  # Host header to pick the slug.
  - hostname: "*-itops.example.com"
    service: http://127.0.0.1:19123

  # Custom-domain tenants. Add one block per onboarded tenant, or use
  # a catch-all ingress at the bottom if all custom domains share the
  # same Cloudflare account.
  - hostname: support.acme.com
    service: http://127.0.0.1:19123

  # Required default rule — must be last.
  - service: http_status:404
```

Pass the Host header through (cloudflared does this by default) so
RightAPI Forge's `TenantResolver` sees the original hostname. The Express
process trusts `X-Forwarded-*` because cloudflared sits on
`127.0.0.1`.

Apply and restart:

```bash
sudo cloudflared tunnel ingress validate
sudo systemctl restart cloudflared
```

The tunnel daemon picks up DNS automatically — no `cloudflared tunnel
route dns` invocation is required when you manage the CNAMEs in the
Cloudflare UI.

---

## 5. Verifying the resolver

After deploy:

```bash
# Apex — system tenant.
curl -s https://itops.example.com/api/tenant/public | jq

# Subdomain — should return the tenant matching slug.
curl -s https://acme-itops.example.com/api/tenant/public | jq

# Unknown subdomain — 404 with a "No tenant with slug" body.
curl -s -i https://nosuch-itops.example.com/api/tenant/public | head -5

# Custom domain.
curl -s https://support.acme.com/api/tenant/public | jq
```

A JWT issued under tenant A that's sent to a request on tenant B's
subdomain returns **HTTP 403** with a `Tenant mismatch` reason —
this is the privilege boundary check, enforced server-side regardless
of how the tunnel is configured.

---

## 6. Reverting

Subdomain support is purely additive. To disable it, unset
`TENANT_BASE_DOMAIN` and restart RightAPI Forge. Existing tenants keep their
`custom_domain` rows but RightAPI Forge falls back to JWT-only resolution.

Pre-existing data continues to live under `SYSTEM_TENANT_ID="system"`
— no migration is required to roll back.

To roll back to the older nested `<slug>.itops.example.com` pattern,
you'd need an Advanced Certificate on the Cloudflare zone (or your own
wildcard cert covering `*.itops.example.com`) — the flat pattern was
adopted specifically to stay inside the free Universal SSL cert.
