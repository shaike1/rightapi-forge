import styles from './Badge.module.css'

type Variant = 'success' | 'danger' | 'warning' | 'info' | 'accent' | 'purple' | 'neutral'

interface Props {
  variant?: Variant
  children: React.ReactNode
  className?: string
}

export default function Badge({ variant = 'neutral', children, className = '' }: Props) {
  return (
    <span className={`${styles.badge} ${styles[variant]} ${className}`}>
      {children}
    </span>
  )
}
