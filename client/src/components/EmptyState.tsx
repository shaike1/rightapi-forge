import styles from './EmptyState.module.css'
import Button from './Button'

interface Props {
  icon?: string
  title: string
  description?: string
  action?: { label: string; onClick: () => void }
}

export default function EmptyState({ icon = '📭', title, description, action }: Props) {
  return (
    <div className={styles.wrap}>
      <div className={styles.icon}>{icon}</div>
      <div className={styles.title}>{title}</div>
      {description && <div className={styles.desc}>{description}</div>}
      {action && (
        <Button variant="primary" size="sm" onClick={action.onClick} style={{ marginTop: 16 }}>
          {action.label}
        </Button>
      )}
    </div>
  )
}
