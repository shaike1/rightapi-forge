import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import Layout from '../components/Layout'
import { Card, CardHeader, CardBody } from '../components/Card'
import Button from '../components/Button'
import Badge from '../components/Badge'
import Modal from '../components/Modal'
import EmptyState from '../components/EmptyState'
import StatCard from '../components/StatCard'
import { api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../hooks/useToast'
import styles from './UsersPage.module.css'

interface AppUser {
  id: string
  username: string
  email?: string
  role: 'admin' | 'operator' | 'viewer'
  createdAt: string
  lastLogin?: string
  assignedRoleId?: number | null
  assignedRoleName?: string | null
}

interface AddUserForm {
  username: string
  email: string
  password: string
  role: AppUser['role']
}

interface AppRole {
  id: number
  name: string
  permissions: string[]
  usersCount: number
  createdAt: string
}

interface RoleForm {
  name: string
  permissions: string[]
}

type RoleVariant = 'accent' | 'info' | 'neutral'
const ROLE_BADGE: Record<AppUser['role'], RoleVariant> = {
  admin: 'accent',
  operator: 'info',
  viewer: 'neutral',
}

const ALL_PERMISSIONS = [
  'view_incidents', 'manage_incidents',
  'view_agents', 'manage_agents',
  'view_settings', 'manage_settings',
  'manage_users', 'execute_runbooks', 'view_security',
]

type Tab = 'users' | 'roles'

export default function UsersPage() {
  const navigate = useNavigate()
  const { user: currentUser } = useAuth()
  const { show } = useToast()
  const [tab, setTab] = useState<Tab>('users')

  useEffect(() => {
    if (currentUser && currentUser.role !== 'admin') {
      navigate('/incidents', { replace: true })
    }
  }, [currentUser, navigate])

  // ── Users state ──────────────────────────────────────────────────────────
  const [users, setUsers] = useState<AppUser[]>([])
  const [loading, setLoading] = useState(true)
  const [addModal, setAddModal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [form, setForm] = useState<AddUserForm>({ username: '', email: '', password: '', role: 'viewer' })

  // ── Roles state ──────────────────────────────────────────────────────────
  const [roles, setRoles] = useState<AppRole[]>([])
  const [rolesLoading, setRolesLoading] = useState(true)
  const [showNewRole, setShowNewRole] = useState(false)
  const [roleForm, setRoleForm] = useState<RoleForm>({ name: '', permissions: [] })
  const [savingRole, setSavingRole] = useState(false)
  const [editingRole, setEditingRole] = useState<AppRole | null>(null)
  const [deletingRoleId, setDeletingRoleId] = useState<number | null>(null)
  const [assigningUserId, setAssigningUserId] = useState<string | null>(null)

  const loadUsers = () => {
    api.get<{ users: AppUser[] } | AppUser[]>('/api/auth/users')
      .then(data => {
        const list = Array.isArray(data) ? data : data?.users
        setUsers(Array.isArray(list) ? list : [])
      })
      .catch((err: unknown) => show((err as Error).message, 'error'))
      .finally(() => setLoading(false))
  }

  const loadRoles = () => {
    api.get<{ roles: AppRole[] } | AppRole[]>('/api/auth/roles')
      .then(data => {
        const list = Array.isArray(data) ? data : data?.roles
        setRoles(Array.isArray(list) ? list : [])
      })
      .catch((err: unknown) => show((err as Error).message, 'error'))
      .finally(() => setRolesLoading(false))
  }

  useEffect(() => {
    if (currentUser?.role === 'admin') { loadUsers(); loadRoles() }
  }, [currentUser]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── User operations ───────────────────────────────────────────────────────
  const handleAddUser = async () => {
    if (!form.username.trim() || !form.password.trim()) {
      show('Username and password are required', 'warning'); return
    }
    setSaving(true)
    try {
      // Strip blank email so we don't store an empty-string contact handle.
      const payload = { ...form, email: form.email.trim() || undefined }
      await api.post('/api/auth/users', payload)
      loadUsers()
      setAddModal(false)
      setForm({ username: '', email: '', password: '', role: 'viewer' })
      show(`User "${form.username}" created`, 'success')
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally { setSaving(false) }
  }

  const handleDelete = async (user: AppUser) => {
    if (user.id === currentUser?.id || user.username === currentUser?.username) {
      show('You cannot delete your own account', 'warning'); return
    }
    if (!confirm(`Delete user "${user.username}"?`)) return
    setDeletingId(user.id)
    try {
      await api.delete(`/api/auth/users/${user.username}`)
      setUsers(prev => prev.filter(u => u.id !== user.id))
      show('User deleted', 'success')
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally { setDeletingId(null) }
  }

  const handleRoleChange = async (user: AppUser, newRole: AppUser['role']) => {
    setUpdatingId(user.id)
    try {
      await api.patch(`/api/auth/users/${user.username}`, { role: newRole })
      setUsers(prev => prev.map(u => u.id === user.id ? { ...u, role: newRole } : u))
      show(`Role updated for ${user.username}`, 'success')
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally { setUpdatingId(null) }
  }

  const handleAssignRole = async (user: AppUser, roleId: string) => {
    setAssigningUserId(user.id)
    try {
      await api.put(`/api/auth/users/${user.username}/role`, { roleId: roleId === '' ? null : Number(roleId) })
      const rid = roleId === '' ? null : Number(roleId)
      const rname = roleId === '' ? null : roles.find(r => r.id === Number(roleId))?.name ?? null
      setUsers(prev => prev.map(u => u.id === user.id ? { ...u, assignedRoleId: rid, assignedRoleName: rname } : u))
      show(`Custom role updated for ${user.username}`, 'success')
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally { setAssigningUserId(null) }
  }

  // ── Role operations ───────────────────────────────────────────────────────
  const handleSaveRole = async () => {
    if (!roleForm.name.trim()) { show('Role name is required', 'warning'); return }
    setSavingRole(true)
    try {
      if (editingRole) {
        await api.put(`/api/auth/roles/${editingRole.id}`, roleForm)
        show(`Role "${roleForm.name}" updated`, 'success')
      } else {
        await api.post('/api/auth/roles', roleForm)
        show(`Role "${roleForm.name}" created`, 'success')
      }
      loadRoles()
      setShowNewRole(false)
      setEditingRole(null)
      setRoleForm({ name: '', permissions: [] })
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally { setSavingRole(false) }
  }

  const handleEditRole = (role: AppRole) => {
    setEditingRole(role)
    setRoleForm({ name: role.name, permissions: [...role.permissions] })
    setShowNewRole(true)
  }

  const handleDeleteRole = async (role: AppRole) => {
    if (!confirm(`Delete role "${role.name}"? Users assigned to this role will lose it.`)) return
    setDeletingRoleId(role.id)
    try {
      await api.delete(`/api/auth/roles/${role.id}`)
      setRoles(prev => prev.filter(r => r.id !== role.id))
      show('Role deleted', 'success')
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally { setDeletingRoleId(null) }
  }

  const togglePerm = (perm: string) => {
    setRoleForm(f => ({
      ...f,
      permissions: f.permissions.includes(perm)
        ? f.permissions.filter(p => p !== perm)
        : [...f.permissions, perm]
    }))
  }

  if (currentUser && currentUser.role !== 'admin') return null

  const adminCount = users.filter(u => u.role === 'admin').length
  const regularCount = users.filter(u => u.role !== 'admin').length

  return (
    <Layout
      title="User Management"
      subtitle="Accounts and access control"
      actions={
        tab === 'users'
          ? <Button variant="primary" size="sm" onClick={() => setAddModal(true)}>+ Add User</Button>
          : <Button variant="primary" size="sm" onClick={() => { setEditingRole(null); setRoleForm({ name: '', permissions: [] }); setShowNewRole(v => !v) }}>🛡️ New Role</Button>
      }
    >
      <div className={styles.statsRow}>
        <StatCard label="Total Users" value={users.length} />
        <StatCard label="Admins" value={adminCount} color="accent" />
        <StatCard label="Regular Users" value={regularCount} color="default" />
        <StatCard label="Custom Roles" value={roles.length} color="default" />
      </div>

      {/* ── Tabs ── */}
      <div className={styles.tabs}>
        <button className={`${styles.tab}${tab === 'users' ? ' ' + styles.tabActive : ''}`} onClick={() => setTab('users')}>
          👥 Users
        </button>
        <button className={`${styles.tab}${tab === 'roles' ? ' ' + styles.tabActive : ''}`} onClick={() => setTab('roles')}>
          🛡️ Roles
        </button>
      </div>

      {/* ── Users Tab ── */}
      {tab === 'users' && (
        <Card>
          <CardHeader title={`Users (${users.length})`} />
          <CardBody>
            {loading ? (
              <div className={styles.loading}>Loading…</div>
            ) : users.length === 0 ? (
              <EmptyState
                icon="👥"
                title="No users found"
                description="Add users to grant access to the platform"
                action={{ label: '+ Add User', onClick: () => setAddModal(true) }}
              />
            ) : (
              <div className={styles.tableWrapper}>
                <table className={styles.table}>
                <thead>
                  <tr>
                    {['User', 'System Role', 'Custom Role', 'Created', 'Last Login', 'Change Role', ''].map((h, i) => (
                      <th key={i} className={styles.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {users.map(user => (
                    <tr key={user.id} className={styles.tr}>
                      <td className={styles.td}>
                        <div className={styles.userRow}>
                          <div className={styles.avatar}>{user.username.charAt(0).toUpperCase()}</div>
                          <div>
                            <div className={styles.userName}>{user.username}</div>
                            {user.email && (
                              <div className={styles.userEmail}>{user.email}</div>
                            )}
                            {(user.id === currentUser?.id || user.username === currentUser?.username) && (
                              <div className={styles.userEmail}>You</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className={styles.td}>
                        <Badge variant={ROLE_BADGE[user.role]}>{user.role}</Badge>
                      </td>
                      <td className={styles.td}>
                        <select
                          value={user.assignedRoleId?.toString() ?? ''}
                          disabled={assigningUserId === user.id}
                          onChange={e => handleAssignRole(user, e.target.value)}
                          className={styles.roleSelect}
                          style={{ opacity: assigningUserId === user.id ? 0.6 : 1 }}
                        >
                          <option value="">— none —</option>
                          {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                        </select>
                      </td>
                      <td className={styles.td}>{new Date(user.createdAt).toLocaleDateString()}</td>
                      <td className={styles.td}>{user.lastLogin ? new Date(user.lastLogin).toLocaleString() : 'Never'}</td>
                      <td className={styles.td}>
                        <select
                          value={user.role}
                          disabled={updatingId === user.id}
                          onChange={e => handleRoleChange(user, e.target.value as AppUser['role'])}
                          className={styles.roleSelect}
                          style={{ opacity: updatingId === user.id ? 0.6 : 1, cursor: updatingId === user.id ? 'wait' : 'pointer' }}
                        >
                          <option value="admin">admin</option>
                          <option value="operator">operator</option>
                          <option value="viewer">viewer</option>
                        </select>
                      </td>
                      <td className={styles.tdRight}>
                        <Button
                          variant="danger" size="xs"
                          loading={deletingId === user.id}
                          disabled={user.id === currentUser?.id || user.username === currentUser?.username}
                          onClick={() => handleDelete(user)}
                        >
                          Delete
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {/* ── Roles Tab ── */}
      {tab === 'roles' && (
        <Card>
          <CardHeader title={`Roles (${roles.length})`} />
          <CardBody>
            {/* Inline new/edit role form */}
            {showNewRole && (
              <div className={styles.newRoleBox}>
                <div className={styles.newRoleTitle}>
                  🔑 {editingRole ? `Edit Role: ${editingRole.name}` : 'New Role'}
                </div>
                <div className={styles.formRow}>
                  <div className={styles.formRowInput}>
                    <label className={styles.label}>Role Name</label>
                    <input
                      className={styles.input}
                      value={roleForm.name}
                      onChange={e => setRoleForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="e.g. incident-responder"
                    />
                  </div>
                </div>
                <div style={{ marginTop: 12 }}>
                  <label className={styles.label}>🔑 Permissions</label>
                  <div className={styles.permCheckGrid}>
                    {ALL_PERMISSIONS.map(perm => (
                      <label key={perm} className={styles.permCheck}>
                        <input
                          type="checkbox"
                          checked={roleForm.permissions.includes(perm)}
                          onChange={() => togglePerm(perm)}
                        />
                        {perm}
                      </label>
                    ))}
                  </div>
                </div>
                <div className={styles.newRoleActions}>
                  <Button variant="primary" size="sm" loading={savingRole} onClick={handleSaveRole}>
                    {editingRole ? 'Save Changes' : 'Create Role'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => { setShowNewRole(false); setEditingRole(null); setRoleForm({ name: '', permissions: [] }) }}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {rolesLoading ? (
              <div className={styles.loading}>Loading…</div>
            ) : roles.length === 0 ? (
              <EmptyState
                icon="🛡️"
                title="No custom roles yet"
                description="Create roles to assign fine-grained permissions to users"
                action={{ label: '🛡️ New Role', onClick: () => setShowNewRole(true) }}
              />
            ) : (
              <div className={styles.tableWrapper}>
                <table className={styles.table}>
                <thead>
                  <tr>
                    {['Role Name', 'Permissions', 'Users', 'Actions'].map((h, i) => (
                      <th key={i} className={styles.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {roles.map(role => (
                    <tr key={role.id} className={styles.tr}>
                      <td className={styles.td}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span>🛡️</span>
                          <span className={styles.userName}>{role.name}</span>
                        </div>
                      </td>
                      <td className={styles.td}>
                        {role.permissions.length === 0 ? (
                          <span style={{ color: 'var(--text3)', fontSize: '.75rem' }}>No permissions</span>
                        ) : (
                          <div className={styles.permBadges}>
                            {role.permissions.map(p => (
                              <span key={p} className={styles.permBadge}>🔑 {p}</span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className={styles.td}>
                        <Badge variant="info">{role.usersCount}</Badge>
                      </td>
                      <td className={styles.tdRight} style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <Button variant="ghost" size="xs" onClick={() => handleEditRole(role)}>Edit</Button>
                        <Button
                          variant="danger" size="xs"
                          loading={deletingRoleId === role.id}
                          onClick={() => handleDeleteRole(role)}
                        >
                          Delete
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {/* Add User Modal */}
      <Modal
        open={addModal}
        onClose={() => setAddModal(false)}
        title="Add User"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddModal(false)}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={handleAddUser}>Create User</Button>
          </>
        }
      >
        <FormField label="Username" value={form.username} onChange={v => setForm(f => ({ ...f, username: v }))} placeholder="username" />
        <FormField label="Email (optional)" value={form.email} onChange={v => setForm(f => ({ ...f, email: v }))} placeholder="user@example.com" />
        <FormField label="Password" value={form.password} onChange={v => setForm(f => ({ ...f, password: v }))} placeholder="••••••••" type="password" />
        <div className={styles.field}>
          <label className={styles.label}>Role</label>
          <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value as AppUser['role'] }))} className={styles.select}>
            <option value="viewer">Viewer — read-only access</option>
            <option value="operator">Operator — can manage incidents &amp; workflows</option>
            <option value="admin">Admin — full access</option>
          </select>
        </div>
      </Modal>
    </Layout>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function FormField({ label, value, onChange, placeholder, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string
}) {
  return (
    <div className={styles.field}>
      <label className={styles.label}>{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} className={styles.input} />
    </div>
  )
}
