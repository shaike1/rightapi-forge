import { useState, useEffect, createContext, useContext } from 'react'
import { api } from '../lib/api'
import type { User } from '../lib/types'

interface AuthState {
  user: User | null
  loading: boolean
  token: string
  logout: () => void
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  token: '',
  logout: () => {},
})

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const token = api.getToken()

  useEffect(() => {
    if (!token) {
      window.location.href = '/login.html?return=/app/'
      return
    }
    // /api/auth/me returns the envelope { user, tenant } on the
    // multitenant server; older builds returned the bare user. Accept
    // either shape so this hook works against any backend deployed in
    // the wild.
    api.get<User | { user: User; tenant?: unknown }>('/api/auth/me')
      .then(data => {
        const u = (data && typeof data === 'object' && 'user' in data) ? (data as { user: User }).user : (data as User)
        if (!u || !u.username) {
          window.location.href = '/login.html?return=/app/'
          return
        }
        setUser(u)
      })
      .catch(() => { window.location.href = '/login.html?return=/app/' })
      .finally(() => setLoading(false))
  }, [token])

  const logout = () => {
    sessionStorage.removeItem('itops_token')
    localStorage.removeItem('itops_token')
    window.location.href = '/login.html?return=/app/'
  }

  return (
    <AuthContext.Provider value={{ user, loading, token, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
