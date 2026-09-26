/**
 * Client for the solenoid cell controller running on the Pi
 * (solenoid_server.py). One POST per displayed cell: the browser is the
 * clock, the Pi is the actuator, so what you see is what the finger feels.
 */

export interface HardwareStatus {
  /** GPIO number for dot 1..6. */
  pins: number[];
  /** Dots currently energised, same bit layout as the cell mask. */
  mask: number;
  maxOnMs: number;
  braillePlaying: boolean;
}

export const DEFAULT_BASE_URL = 'http://169.254.10.10:8080';
const KEY_URL = 'hardware.baseUrl';
const KEY_ENABLED = 'hardware.enabled';

/** Served by the Pi itself (port 8080): talk to the same origin. */
export function servedFromPi(): boolean {
  return typeof location !== 'undefined' && location.port === '8080';
}

export function loadBaseUrl(): string {
  if (servedFromPi()) return location.origin;
  try {
    return localStorage.getItem(KEY_URL) || DEFAULT_BASE_URL;
  } catch {
    return DEFAULT_BASE_URL;
  }
}

export function saveBaseUrl(url: string) {
  try {
    localStorage.setItem(KEY_URL, url);
  } catch {
    /* private mode: keep it for this page load only */
  }
}

export function loadEnabled(): boolean {
  try {
    const v = localStorage.getItem(KEY_ENABLED);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}

export function saveEnabled(on: boolean) {
  try {
    localStorage.setItem(KEY_ENABLED, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export function normaliseBaseUrl(input: string): string {
  let s = input.trim().replace(/\/+$/, '');
  if (!s) return DEFAULT_BASE_URL;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  if (!/:\d+$/.test(s)) s += ':8080';
  return s;
}

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

async function post(baseUrl: string, path: string): Promise<void> {
  const res = await fetch(baseUrl + path, { method: 'POST', keepalive: true });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
}

/** Raise exactly the dots in `mask` for `holdMs` (the Pi clamps to its own safety limit). */
export function sendCell(baseUrl: string, mask: number, holdMs: number): Promise<void> {
  return post(baseUrl, `/cell?mask=${mask & 0x3f}&ms=${Math.max(10, Math.round(holdMs))}`);
}

export function sendAllOff(baseUrl: string): Promise<void> {
  return post(baseUrl, '/alloff');
}

/** Poll the Pi. Resolves null when it cannot be reached within `timeoutMs`. */
export async function fetchStatus(baseUrl: string, timeoutMs = 1500): Promise<HardwareStatus | null> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(baseUrl + '/state', { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const j = await res.json();
    return {
      pins: Array.isArray(j.pins) ? j.pins : [],
      mask: Number(j.mask) || 0,
      maxOnMs: Number(j.max_on_ms) || 2000,
      braillePlaying: Boolean(j.braille?.playing),
    };
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}
