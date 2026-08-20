import { useState, useCallback } from 'react'

interface Toast {
  id: number
  message: string
  type: 'info' | 'success' | 'error' | 'warning'
}

let _show: ((msg: string, type?: Toast['type']) => void) | null = null

export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([])

  const show = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = Date.now()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3500)
  }, [])

  _show = show

  return { toasts, show }
}

// Imperative helper for use outside components
export const toast = {
  show: (msg: string, type: Toast['type'] = 'info') => _show?.(msg, type),
  success: (msg: string) => _show?.(msg, 'success'),
  error: (msg: string) => _show?.(msg, 'error'),
  info: (msg: string) => _show?.(msg, 'info'),
}

export type { Toast }
