import type { ReactNode } from 'react'
import styles from './Card.module.css'

interface CardProps {
  children: ReactNode
  className?: string
}
interface HeaderProps {
  title: string
  subtitle?: string
  actions?: ReactNode
}

export function Card({ children, className = '' }: CardProps) {
  return <div className={`${styles.card} ${className}`}>{children}</div>
}

export function CardHeader({ title, subtitle, actions }: HeaderProps) {
  return (
    <div className={styles.header}>
      <div>
        <div className={styles.title}>{title}</div>
        {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  )
}

export function CardBody({ children, className = '' }: CardProps) {
  return <div className={`${styles.body} ${className}`}>{children}</div>
}

export function CardFooter({ children }: CardProps) {
  return <div className={styles.footer}>{children}</div>
}
