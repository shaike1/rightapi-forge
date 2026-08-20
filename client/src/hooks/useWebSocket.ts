import { useEffect, useRef, useState, useCallback } from 'react';

export interface WSEvent {
  type: string;
  data?: unknown;
  [k: string]: unknown;
}

export interface UseWebSocketReturn {
  /** True only after the auth handshake completes. Pre-handshake the
   *  socket is open at the transport level but not yet usable for
   *  application messages. */
  connected: boolean;
  lastEvent: WSEvent | null;
  /** Sends only when authenticated. Pre-auth sends are dropped so a
   *  page can't accidentally race the handshake. */
  send: (msg: object) => void;
}

const WS_RECONNECT_DELAY = 3000;
const WS_CLOSE_AUTH_FAILED = 4403;
const WS_CLOSE_AUTH_TIMEOUT = 4401;

function readToken(): string {
  try {
    return sessionStorage.getItem('itops_token') || localStorage.getItem('itops_token') || '';
  } catch {
    return '';
  }
}

export function useWebSocket(): UseWebSocketReturn {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<WSEvent | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  // Tracks whether the current connection's handshake succeeded. Reset
  // on every connect so reconnects re-handshake cleanly.
  const authedRef = useRef(false);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws`;

    const ws = new WebSocket(url);
    wsRef.current = ws;
    authedRef.current = false;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      // Send the auth handshake immediately. The server gives us a 5s
      // grace period; if we don't beat it the connection closes with
      // code 4401 and the reconnect timer kicks in below.
      const token = readToken();
      try {
        ws.send(JSON.stringify({ type: 'auth', token }));
      } catch {
        /* socket may have flipped to CLOSING before we got here */
      }
    };

    ws.onmessage = (evt) => {
      if (!mountedRef.current) return;
      let msg: WSEvent;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      // Surface auth:ok / auth:fail internally — these manage the
      // connected flag but otherwise stay invisible to page components,
      // which never need to special-case the handshake.
      if (msg.type === 'auth:ok') {
        authedRef.current = true;
        setConnected(true);
        // Don't forward the auth event itself as a page-visible WSEvent;
        // pages would have to filter it out otherwise.
        return;
      }
      if (msg.type === 'auth:fail') {
        authedRef.current = false;
        setConnected(false);
        // Closing here triggers the reconnect cycle. The next attempt
        // re-reads the token, which may have been refreshed by the
        // REST flow in the meantime.
        try { ws.close(); } catch { /* ignore */ }
        return;
      }
      setLastEvent(msg);
    };

    ws.onclose = (closeEvt) => {
      if (!mountedRef.current) return;
      setConnected(false);
      authedRef.current = false;
      // Auth-failure close codes mean the token is bad — likely expired.
      // Trigger the same 401-redirect path the REST wrapper uses so the
      // user lands on the login screen instead of looping reconnects
      // forever. For network blips (1006, etc.) we reconnect normally.
      if (closeEvt.code === WS_CLOSE_AUTH_FAILED || closeEvt.code === WS_CLOSE_AUTH_TIMEOUT) {
        try {
          sessionStorage.removeItem('itops_token');
          localStorage.removeItem('itops_token');
        } catch { /* storage may be locked */ }
        // Only redirect if we're inside /app; the login page itself shouldn't
        // bounce on its own WS failure.
        if (window.location.pathname.startsWith('/app')) {
          window.location.href = '/login.html?return=/app/';
          return;
        }
      }
      timerRef.current = setTimeout(connect, WS_RECONNECT_DELAY);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!authedRef.current) return;
    ws.send(JSON.stringify(msg));
  }, []);

  return { connected, lastEvent, send };
}
