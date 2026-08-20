import styles from './StatCard.module.css'

type Color = 'default' | 'danger' | 'success' | 'warning' | 'accent' | 'purple' | 'neutral'

interface Props {
  label: string
  value: string | number
  sub?: string
  color?: Color
}

export default function StatCard({ label, value, sub, color = 'default' }: Props) {
  return (
    <div className={`${styles.card} ${styles[color]}`}>
      <div className={styles.label}>{label}</div>
      <div className={styles.value}>{value}</div>
      {sub && <div className={styles.sub}>{sub}</div>}
    </div>
  )
}
