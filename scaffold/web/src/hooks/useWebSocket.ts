import { useEffect, useRef, useState } from 'react';
import type { WsFrame } from '../types';

export function useWebSocket(
  workspace: string | null,
  onFrame: (frame: WsFrame) => void,
): 'connected' | 'reconnecting' | 'disconnected' {
  const [status, setStatus] = useState<'connected' | 'reconnecting' | 'disconnected'>('disconnected');
  const lastSeqRef = useRef<number | undefined>(undefined);
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  useEffect(() => {
    if (!workspace) {
      setStatus('disconnected');
      return;
    }

    lastSeqRef.current = undefined;
    let closed = false;
    let attempt = 0;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const after = lastSeqRef.current !== undefined ? `&after=${lastSeqRef.current}` : '';
      const url = `${proto}//${window.location.host}/ws?workspace=${encodeURIComponent(workspace)}${after}`;

      ws = new WebSocket(url);

      ws.onopen = () => {
        attempt = 0;
        setStatus('connected');
      };

      ws.onmessage = (evt) => {
        try {
          const frame = JSON.parse(String(evt.data)) as WsFrame;
          if (typeof frame.seq === 'number') {
            if (lastSeqRef.current !== undefined && frame.seq <= lastSeqRef.current) return;
            lastSeqRef.current = frame.seq;
          }
          onFrameRef.current(frame);
        } catch {
          // ignore non-json frames
        }
      };

      ws.onclose = () => {
        if (closed) return;
        setStatus('reconnecting');
        const delay = Math.min(5000, 400 * 2 ** Math.min(attempt++, 4));
        timer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [workspace]);

  return status;
}
