import { useCallback, useEffect, useRef, useState } from 'react';
import {
  bridgeCapture,
  bridgeClear,
  bridgeNext,
  bridgeSetMode,
  fetchBridgeState,
  loadBridgeUrl,
  streamUrl,
  type BridgeState,
  type QueueItem,
} from '../lib/bridge';

const POLL_MS = 500;

export interface Bridge {
  baseUrl: string;
  online: boolean;
  state: BridgeState | null;
  /** URL of the live annotated MJPEG stream. */
  streamUrl: string;
  /** Queue the current best detection. Resolves the queued item, or null if nothing is in view. */
  capture(): Promise<QueueItem | null>;
  /** Pop the next queued item. */
  next(): Promise<QueueItem | null>;
  setMode(mode: 'auto' | 'manual'): void;
  clear(): void;
}

export function useBridge(): Bridge {
  const [baseUrl] = useState(loadBridgeUrl);
  const [state, setState] = useState<BridgeState | null>(null);
  const [online, setOnline] = useState(false);
  const failures = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const s = await fetchBridgeState(baseUrl);
      if (cancelled) return;
      if (s) {
        failures.current = 0;
        setState(s);
        setOnline(true);
      } else if (++failures.current >= 2) {
        setOnline(false);
      }
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [baseUrl]);

  const refresh = useCallback(async () => {
    const s = await fetchBridgeState(baseUrl);
    if (s) setState(s);
  }, [baseUrl]);

  const capture = useCallback(async () => {
    const item = await bridgeCapture(baseUrl).catch(() => null);
    void refresh();
    return item;
  }, [baseUrl, refresh]);

  const next = useCallback(async () => {
    const item = await bridgeNext(baseUrl).catch(() => null);
    void refresh();
    return item;
  }, [baseUrl, refresh]);

  const setMode = useCallback(
    (mode: 'auto' | 'manual') => {
      bridgeSetMode(baseUrl, mode).then(setState).catch(() => {});
    },
    [baseUrl],
  );

  const clear = useCallback(() => {
    bridgeClear(baseUrl).then(setState).catch(() => {});
  }, [baseUrl]);

  return { baseUrl, online, state, streamUrl: streamUrl(baseUrl), capture, next, setMode, clear };
}
