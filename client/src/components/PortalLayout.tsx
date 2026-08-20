import { LogOut, LifeBuoy } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import styles from './PortalLayout.module.css'

interface PortalLayoutProps {
  children: React.ReactNode
}

/** Minimal chrome for the self-service portal. No sidebar, no
 *  breadcrumbs — just a clean header with the brand mark, the user's
 *  identity, and a logout. The portal page itself owns all the
 *  surface area below the header. */
export default function PortalLayout({ children }: PortalLayoutProps) {
  const { user, logout } = useAuth()
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <div className={styles.mark}>
            <LifeBuoy size={18} />
          </div>
          <div className={styles.brandText}>
            <div className={styles.title}>RightAPI Forge Support</div>
            <div className={styles.subtitle}>Self-service portal</div>
          </div>
        </div>
        <div className={styles.right}>
          {user && (
            <span className={styles.user}>
              <span className={styles.userName}>{user.username}</span>
              {user.email && <span className={styles.userEmail}>{user.email}</span>}
            </span>
          )}
          <button type="button" onClick={logout} className={styles.logoutBtn} aria-label="Sign out">
            <LogOut size={16} />
            <span>Sign out</span>
          </button>
        </div>
      </header>
      <main className={styles.main}>{children}</main>
      <footer className={styles.footer}>
        <span>Need a full admin view? <a href="/app/">Go to admin dashboard →</a></span>
      </footer>
    </div>
  )
}
