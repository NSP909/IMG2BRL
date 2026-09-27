/**
 * Client for the detection bridge (bridge/detect_bridge.py): the laptop
 * process that reads the Pi camera, runs YOLO + OCR, and keeps the queue
 * of things to send to the finger.
 */
import type { Box, DetectionKind } from './detections';

export interface BridgeDetection {
  kind: DetectionKind;
  label: string;
  confidence: number;
  box: Box;
  /** Which engine produced it: yolo (default), tesseract, or the vision model. */
  engine?: 'tesseract' | 'vlm';
}

export interface QueueItem extends BridgeDetection {
  id: string;
  at: number;
  source: 'camera';
}

export interface BridgeStats {
  fps: number;
  infer_ms: number;
  ocr_ms: number;
  model: string;
  device: string;
  passes: number;
}

export type Engine = 'tesseract' | 'vlm' | 'both' | 'none';

export interface VlmResult {
  available: boolean;
  /** 'anthropic' (Claude) or 'openai'. */
  provider: 'anthropic' | 'openai' | null;
  model: string | null;
  kind: 'text' | 'object' | null;
  label: string;
  text: string;
  object: string;
  confidence: number;
  latency_ms: number;
  at: number;
  raw: string;
  error: string | null;
  passes: number;
}

export interface BridgeState {
  engine: Engine;
  vlm: VlmResult;
  tesseract: BridgeDetection[];
  camera_ok: boolean;
  frame_age_ms: number | null;
  detections: BridgeDetection[];
  best: BridgeDetection | null;
  mode: 'auto' | 'manual';
  queue: QueueItem[];
  playing: QueueItem | null;
  stats: BridgeStats;
  direct: boolean;
  log: string[];
}

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8765';
/** The Vite dev server forwards /bridge/* to the bridge (see vite.config.ts). */
export const DEV_BRIDGE_URL = '/bridge';
const KEY_URL = 'bridge.baseUrl';

export function loadBridgeUrl(): string {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(KEY_URL);
  } catch {
    /* ignore */
  }
  if (import.meta.env.DEV && (!stored || stored === DEFAULT_BRIDGE_URL)) return DEV_BRIDGE_URL;
  return stored || DEFAULT_BRIDGE_URL;
}

export function streamUrl(baseUrl: string): string {
  return `${baseUrl}/stream.mjpg`;
}

export async function fetchBridgeState(baseUrl: string, timeoutMs = 1500): Promise<BridgeState | null> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/state`, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as BridgeState;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

async function post<T>(baseUrl: string, path: string): Promise<T> {
  const res = await fetch(baseUrl + path, { method: 'POST' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Pop the next queued item; null when the queue is empty. */
export async function bridgeNext(baseUrl: string): Promise<QueueItem | null> {
  const r = await post<{ item: QueueItem | null }>(baseUrl, '/next');
  return r.item;
}

/** Queue whatever the bridge currently sees as the best detection. */
export async function bridgeCapture(baseUrl: string): Promise<QueueItem | null> {
  const r = await post<{ item: QueueItem | null }>(baseUrl, '/capture');
  return r.item;
}

export function bridgeSetMode(baseUrl: string, mode: 'auto' | 'manual'): Promise<BridgeState> {
  return post<BridgeState>(baseUrl, `/mode?value=${mode}`);
}

export function bridgeClear(baseUrl: string): Promise<BridgeState> {
  return post<BridgeState>(baseUrl, '/clear');
}

export function bridgeQueueText(baseUrl: string, text: string): Promise<{ item: QueueItem }> {
  return post<{ item: QueueItem }>(baseUrl, `/queue?text=${encodeURIComponent(text)}`);
}

export function bridgeSetEngine(baseUrl: string, engine: Engine): Promise<BridgeState> {
  return post<BridgeState>(baseUrl, `/engine?value=${engine}`);
}

/** Ask for one OpenAI pass right now. */
export function bridgeAnalyze(baseUrl: string): Promise<{ ok: boolean }> {
  return post<{ ok: boolean }>(baseUrl, '/analyze');
}
