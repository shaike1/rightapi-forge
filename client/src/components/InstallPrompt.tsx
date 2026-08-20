import { useEffect, useState } from 'react'
import { X, Download } from 'lucide-react'
import styles from './InstallPrompt.module.css'

// Minimal type for the BeforeInstallPromptEvent — TypeScript's lib.dom
// doesn't ship a full definition yet.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISS_KEY = 'beacon-install-dismissed'

/** Subtle banner offering the user to install RightAPI Forge as a PWA. Only
 *  appears when:
 *    • the browser fires `beforeinstallprompt` (Chrome/Edge/Android)
 *    • the user hasn't previously dismissed it
 *    • the app isn't already running in standalone mode
 *  Dismissing it persists in localStorage so we don't nag. */
export default function InstallPrompt() {
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    // Already installed — don't show.
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return
    if (localStorage.getItem(DISMISS_KEY) === '1') return

    const onPrompt = (e: Event) => {
      e.preventDefault()
      setEvt(e as BeforeInstallPromptEvent)
      setVisible(true)
    }
    const onInstalled = () => {
      setVisible(false)
      try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* private mode */ }
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (!visible || !evt) return null

  const install = async () => {
    try {
      await evt.prompt()
      await evt.userChoice
    } catch {
      // ignore — user dismissed
    } finally {
      setVisible(false)
      try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* private */ }
    }
  }
  const dismiss = () => {
    setVisible(false)
    try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* private */ }
  }

  return (
    <div className={styles.banner} role="dialog" aria-label="Install RightAPI Forge">
      <Download size={16} />
      <span className={styles.text}>Install RightAPI Forge to your home screen for fast access.</span>
      <button type="button" className={styles.install} onClick={install}>Install</button>
      <button type="button" className={styles.close} onClick={dismiss} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  )
}
