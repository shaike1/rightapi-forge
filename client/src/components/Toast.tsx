import { useToast } from '../hooks/useToast'
import type { Toast } from '../hooks/useToast'
import styles from './Toast.module.css'

function ToastItem({ toast }: { toast: Toast }) {
  return (
    <div className={`${styles.toast} ${styles[toast.type]}`}>
      <span className={styles.icon}>
        {toast.type === 'success' ? '✓' : toast.type === 'error' ? '✕' : toast.type === 'warning' ? '⚠' : 'ℹ'}
      </span>
      {toast.message}
    </div>
  )
}

export function ToastContainer() {
  const { toasts } = useToast()
  return (
    <div className={styles.container}>
      {toasts.map(t => <ToastItem key={t.id} toast={t} />)}
    </div>
  )
}
