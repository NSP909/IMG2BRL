import { useCallback, useEffect, useRef, useState } from 'react';
import {
  bridgeAnalyze,
  bridgeCapture,
  bridgeClear,
  bridgeNext,
  bridgeSetEngine,
  bridgeSetMode,
  bridgeSetPausedTarget,
  bridgeSetWake,
  fetchBridgeState,
  loadBridgeUrl,
  streamUrl,
  type BridgeState,
  type Engine,
  type QueueItem,
} from '../lib/bridge';

const POLL_MS = 500;

export interface Bridge {
  baseUrl: string;
  online: boolean;
  state: BridgeState | null;
  /** URL of the live annotated MJPEG stream; changes whenever the bridge comes back, so <img> reconnects. */
  streamUrl: string;
  /** Queue the current best detection. Resolves the queued item, or null if nothing is in view. */
  capture(): Promise<QueueItem | null>;
  /** Pop the next queued item. */
  next(): Promise<QueueItem | null>;
  setMode(mode: 'auto' | 'manual'): void;
  clear(): void;
  setEngine(engine: Engine): void;
  /** Run one vision-model pass now. */
  analyze(): void;
  /** Camera lock (detection, reads and queueing stop). */
  paused: boolean;
  setPaused(paused: boolean): void;
  /** Microphone lock. */
  micPaused: boolean;
  setMicPaused(paused: boolean): void;
  /** Change the wearer name the microphone listens for. */
  setWake(name: string, aliases: string[]): Promise<boolean>;
}

export function useBridge(): Bridge {
  const [baseUrl] = useState(loadBridgeUrl);
  const [state, setState] = useState<BridgeState | null>(null);
  const [online, setOnline] = useState(false);
  const [session, setSession] = useState(0);
  const failures = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const s = await fetchBridgeState(baseUrl);
      if (cancelled) return;
      if (s) {
        failures.current = 0;
        setState(s);
        setOnline((was) => {
          if (!was) setSession((n) => n + 1); // (re)connected: give the stream a fresh URL
          return true;
        });
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

  const setEngine = useCallback(
    (engine: Engine) => {
      bridgeSetEngine(baseUrl, engine).then(setState).catch(() => {});
    },
    [baseUrl],
  );

  const analyze = useCallback(() => {
    bridgeAnalyze(baseUrl).catch(() => {});
  }, [baseUrl]);

  const setPaused = useCallback(
    (paused: boolean) => {
      setState((s) => (s ? { ...s, paused } : s));
      bridgeSetPausedTarget(baseUrl, paused, 'camera').then(setState).catch(() => {});
    },
    [baseUrl],
  );

  const setMicPaused = useCallback(
    (paused: boolean) => {
      setState((s) => (s ? { ...s, sound: { ...s.sound, paused } } : s));
      bridgeSetPausedTarget(baseUrl, paused, 'mic').then(setState).catch(() => {});
    },
    [baseUrl],
  );

  const setWake = useCallback(
    async (name: string, aliases: string[]) => {
      try {
        setState(await bridgeSetWake(baseUrl, name, aliases));
        return true;
      } catch {
        return false;
      }
    },
    [baseUrl],
  );

  return {
    baseUrl,
    online,
    state,
    streamUrl: `${streamUrl(baseUrl)}?s=${session}`,
    capture,
    next,
    setMode,
    clear,
    setEngine,
    analyze,
    paused: state?.paused ?? false,
    setPaused,
    micPaused: state?.sound.paused ?? false,
    setMicPaused,
    setWake,
  };
}
