// useTenant — client-side tenant detection.
//
// Sources, in priority order:
//   1. Subdomain of window.location.hostname (parsed against the
//      base domain hint received from /api/tenant/public).
//   2. JWT context exposed by useAuth (the server already resolved
//      and validated, so we trust it).
//
// The server is the authoritative resolver — this hook is a UX
// optimisation so the login + registration pages can render the
// tenant brand before any login attempt.
//
// API surface:
//   { tenant, source, loading, refresh }
//
// `tenant` is null when there's no real tenant context (e.g. the user
// is on the apex domain unauthenticated). The login page renders a
// "Sign in to RightAPI Forge" header in that case.

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'

export interface PublicTenant {
  id: string
  slug: string
  name: string
  isSystem: boolean
  logoUrl: string | null
}

type Source = 'subdomain' | 'jwt' | 'system' | 'none'

interface UseTenantResult {
  tenant: PublicTenant | null
  source: Source
  loading: boolean
  /** Manual refetch (after registration or a custom-domain change). */
  refresh: () => Promise<void>
}

/** Try to extract a tenant slug from the current hostname. The flat
 *  pattern is `<slug>-itops.<root>` (e.g. `acme-itops.example.com`
 *  → 'acme'). Returns null for the apex, IPs, localhost, hostnames
 *  that don't carry the `-itops` suffix, or reserved slug values.
 *  Pure: doesn't touch the network.
 *
 *  The `-itops` label is hardcoded here intentionally: the client
 *  doesn't know the configured TENANT_BASE_DOMAIN until /api/tenant/public
 *  responds, and this helper runs synchronously before that. The server
 *  is authoritative — this is just for early-render branding. */
const TENANT_APEX_LABEL = 'itops'

export function extractSubdomain(hostname: string): string | null {
  if (!hostname) return null
  const h = hostname.toLowerCase()
  if (/^[\d.:]+$/.test(h)) return null  // IPv4 / IPv6
  if (h === 'localhost') return null
  const parts = h.split('.')
  if (parts.length < 3) return null      // need at least <sub>.<domain>.<tld>
  const first = parts[0]
  if (!first) return null
  const suffix = '-' + TENANT_APEX_LABEL
  if (!first.endsWith(suffix)) return null
  const slug = first.slice(0, first.length - suffix.length)
  if (!slug) return null
  const reserved = new Set(['www', 'api', 'app', 'admin', 'static', 'cdn', 'mail', 'docs'])
  if (reserved.has(slug)) return null
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return null
  return slug
}

export function useTenant(): UseTenantResult {
  const [tenant, setTenant] = useState<PublicTenant | null>(null)
  const [source, setSource] = useState<Source>('none')
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      // Server is authoritative: it sees the Host header, applies the
      // same TenantResolver rules, and returns the public-safe view.
      // We pass no extra info — the cookie/JWT (if any) is sent
      // automatically by api.get.
      const data = await api.get<{ tenant: PublicTenant | null }>('/api/tenant/public').catch(() => null)
      if (data?.tenant) {
        setTenant(data.tenant)
        // The server marks the system tenant as `isSystem`; we treat
        // that as "no tenant context" for UI purposes.
        if (data.tenant.isSystem) {
          setSource(extractSubdomain(window.location.hostname) ? 'subdomain' : 'system')
        } else {
          setSource(extractSubdomain(window.location.hostname) ? 'subdomain' : 'jwt')
        }
      } else {
        setTenant(null)
        setSource('none')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  return { tenant, source, loading, refresh }
}
