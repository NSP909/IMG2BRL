import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchStatus,
  hostOf,
  loadBaseUrl,
  loadEnabled,
  normaliseBaseUrl,
  saveBaseUrl,
  saveEnabled,
  sendAllOff,
  sendCell,
  servedFromPi,
  type HardwareStatus,
} from '../lib/hardware';

const POLL_MS = 2000;
/** Extra hold sent to the Pi so its own timer never drops a cell before the next one arrives. */
const HOLD_MARGIN_MS = 150;
/** All-down blip between two identical consecutive cells, so "ll" is felt as two. */
const REPEAT_BLIP_MS = 120;

export interface Hardware {
  baseUrl: string;
  host: string;
  /** True when this page is served by the Pi itself (address is then fixed). */
  fixedAddress: boolean;
  setBaseUrl(url: string): void;
  enabled: boolean;
  setEnabled(on: boolean): void;
  online: boolean;
  status: HardwareStatus | null;
  /** Live when the user wants real pins and the Pi answers. */
  live: boolean;
  sendCell(mask: number, holdMs: number): void;
  allOff(): void;
}

export function useHardware(): Hardware {
  const [baseUrl, setBaseUrlState] = useState(loadBaseUrl);
  const [enabled, setEnabledState] = useState(loadEnabled);
  const [status, setStatus] = useState<HardwareStatus | null>(null);
  const [online, setOnline] = useState(false);
  const lastMask = useRef(0);
  const blipTimer = useRef<number | null>(null);

  const setBaseUrl = useCallback((url: string) => {
    const next = normaliseBaseUrl(url);
    saveBaseUrl(next);
    setBaseUrlState(next);
    setStatus(null);
    setOnline(false);
  }, []);

  const setEnabled = useCallback((on: boolean) => {
    saveEnabled(on);
    setEnabledState(on);
  }, []);

  // Poll for presence.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const s = await fetchStatus(baseUrl);
      if (cancelled) return;
      setStatus(s);
      setOnline(s !== null);
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [baseUrl]);

  const fail = useCallback(() => setOnline(false), []);

  const allOff = useCallback(() => {
    if (blipTimer.current) {
      window.clearTimeout(blipTimer.current);
      blipTimer.current = null;
    }
    lastMask.current = 0;
    if (!enabled) return;
    sendAllOff(baseUrl).catch(fail);
  }, [baseUrl, enabled, fail]);

  const send = useCallback(
    (mask: number, holdMs: number) => {
      if (!enabled) return;
      if (blipTimer.current) {
        window.clearTimeout(blipTimer.current);
        blipTimer.current = null;
      }
      const ms = holdMs + HOLD_MARGIN_MS;
      const raise = () => {
        lastMask.current = mask;
        sendCell(baseUrl, mask, ms).catch(fail);
      };
      if (mask !== 0 && mask === lastMask.current) {
        // Same cell twice in a row: drop the pins briefly so the repeat is felt.
        sendAllOff(baseUrl).catch(fail);
        blipTimer.current = window.setTimeout(raise, REPEAT_BLIP_MS);
      } else {
        raise();
      }
    },
    [baseUrl, enabled, fail],
  );

  // Pins down when the page goes away or is hidden.
  useEffect(() => {
    const down = () => {
      if (enabled) sendAllOff(baseUrl).catch(() => {});
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') down();
    };
    window.addEventListener('pagehide', down);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', down);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [baseUrl, enabled]);

  return {
    baseUrl,
    host: hostOf(baseUrl),
    fixedAddress: servedFromPi(),
    setBaseUrl,
    enabled,
    setEnabled,
    online,
    status,
    live: enabled && online,
    sendCell: send,
    allOff,
  };
}
