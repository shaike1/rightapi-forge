import { useState, useEffect, useCallback, useRef } from 'react';
import type { WSEvent } from './useWebSocket';
import { api } from '../lib/api';

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  severity: string;
  ts: number;
  read: boolean;
}

interface ApiNotification {
  id: number;
  type: string;
  title: string;
  message: string;
  severity: string;
  read: number;
  created_at: string;
}

function toAppNotification(n: ApiNotification): AppNotification {
  return {
    id: String(n.id),
    type: n.type,
    title: n.title,
    message: n.message,
    severity: n.severity || 'info',
    ts: new Date(n.created_at).getTime(),
    read: n.read === 1,
  };
}

export function useNotifications(lastEvent: WSEvent | null) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const fetchedRef = useRef(false);

  const fetchNotifications = useCallback(async () => {
    try {
      const rows = await api.get<ApiNotification[]>('/api/notifications?limit=30');
      setNotifications(rows.map(toAppNotification));
    } catch {
      // silently ignore if not authenticated yet
    }
  }, []);

  // Fetch on mount
  useEffect(() => {
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      fetchNotifications();
    }
  }, [fetchNotifications]);

  // Re-fetch when a new notification arrives via WebSocket
  useEffect(() => {
    if (!lastEvent) return;
    if (lastEvent.type === 'notification_new' || (lastEvent as any).event === 'notification_new') {
      fetchNotifications();
    }
  }, [lastEvent, fetchNotifications]);

  const markRead = useCallback(async (id: string) => {
    try {
      await api.put(`/api/notifications/${id}/read`);
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
    } catch { /* ignore */ }
  }, []);

  const markAllRead = useCallback(async () => {
    try {
      await api.put('/api/notifications/read-all');
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    } catch { /* ignore */ }
  }, []);

  const clearAll = useCallback(async () => {
    try {
      await api.delete('/api/notifications');
      setNotifications([]);
    } catch { /* ignore */ }
  }, []);

  const unreadCount = notifications.filter(n => !n.read).length;

  return { notifications, unreadCount, markRead, markAllRead, clearAll };
}
