import { useEffect } from 'react'
import { useAuth } from './useAuth'
import { api } from '../lib/api'

// LocalStorage flag — once the user has dismissed permission, we don't
// re-prompt every page load. They can clear it from browser settings.
const DISMISS_KEY = 'beacon-push-dismissed'

/** Convert a URL-safe base64 VAPID public key to the raw Uint8Array
 *  the PushManager API requires. (Standard helper from MDN's web-push
 *  primer.) */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - base64String.length % 4) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** Register the service worker and (if the user has not previously
 *  declined) subscribe to push notifications. Best-effort — never
 *  surfaces errors, never throws. Returns nothing; the side-effect is
 *  a POST /api/push/subscribe with the browser's subscription object.
 *
 *  Notes:
 *  • Doesn't prompt if Notification.permission === 'denied' or if
 *    the user previously dismissed (DISMISS_KEY). The first call to
 *    Notification.requestPermission() pops the browser permission
 *    sheet — that's the user-facing prompt.
 *  • Idempotent: if the browser already has a push subscription we
 *    just re-POST to the server (handles the case where the server
 *    db was wiped or the device migrated). */
export function usePushNotifications(): void {
  const { user, token } = useAuth()

  useEffect(() => {
    if (!user || !token) return
    if (typeof window === 'undefined') return
    if (!('serviceWorker' in navigator)) return
    if (!('PushManager' in window)) return
    if (Notification.permission === 'denied') return
    if (localStorage.getItem(DISMISS_KEY) === '1') return

    let cancelled = false
    ;(async () => {
      try {
        // 1) Make sure the SW is registered. index.html also registers
        //    on load — second register() returns the existing reg.
        const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
        await navigator.serviceWorker.ready
        if (cancelled) return

        // 2) Fetch the VAPID public key.
        const { publicKey } = await api.get<{ publicKey: string }>('/api/push/vapid-public-key')
        if (!publicKey || cancelled) return

        // 3) Ask for permission only if we haven't been granted yet.
        //    'granted' = silent re-subscribe. 'default' = prompt.
        let permission = Notification.permission
        if (permission === 'default') {
          permission = await Notification.requestPermission()
          if (permission !== 'granted') {
            // The user said "no" — flag it so we don't re-prompt.
            try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* private mode */ }
            return
          }
        }
        if (permission !== 'granted' || cancelled) return

        // 4) Subscribe (or reuse existing subscription).
        //    Cast to BufferSource — TS's PushSubscriptionOptions only
        //    accepts ArrayBuffer-backed views, but a fresh Uint8Array
        //    from urlBase64ToUint8Array() is fine at runtime.
        const applicationServerKey = urlBase64ToUint8Array(publicKey) as unknown as BufferSource
        let sub = await reg.pushManager.getSubscription()
        if (!sub) {
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })
        }
        if (cancelled) return

        // 5) Tell the server. The server keys on `endpoint` so re-POSTs
        //    are idempotent.
        await api.post('/api/push/subscribe', sub.toJSON())
      } catch (e) {
        // Push is a soft feature — log to console for ops debugging,
        // never disrupt the UI.
        console.warn('[beacon push] subscribe failed', e)
      }
    })()

    return () => { cancelled = true }
  }, [user, token])
}
