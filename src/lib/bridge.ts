/**
 * Client for the recognition bridge (bridge/detect_bridge.py): the laptop
 * process that runs either camera vision or name-triggered cloud speech
 * recognition and keeps the queue of things to send to the finger.
 */
import type { Box, DetectionKind } from './detections';

export interface BridgeDetection {
  kind: DetectionKind;
  label: string;
  confidence: number;
  box: Box | null;
  /** Who produced it: yolo (default), the text gate ('east', not a candidate), or a reader. */
  engine?: 'east' | 'anthropic' | 'openai' | 'tesseract' | 'vlm';
}

export interface QueueItem extends BridgeDetection {
  id: string;
  at: number;
  source: 'camera' | 'microphone';
}

export interface BridgeStats {
  fps: number;
  infer_ms: number;
  gate_ms: number;
  model: string;
  device: string;
  passes: number;
}

export type Engine = 'vlm' | 'tesseract' | 'none';
export type Recognizer = 'camera' | 'sound';

export type SoundWorkerState = 'off' | 'starting' | 'loading' | 'listening' | 'speech' | 'transcribing' | 'paused' | 'error' | 'stopped';

export interface SoundStatus {
  available: boolean;
  device: string | null;
  sample_rate: number | null;
  listening: boolean;
  paused: boolean;
  state: SoundWorkerState;
  level_dbfs: number;
  vad_probability: number;
  wake_name: string | null;
  aliases: string[];
  model: string;
  latency_ms: number;
  accepted_count: number;
  discarded_count: number;
  dropped_count: number;
  /** Only the most recent accepted utterance; rejected text is never exposed. */
  last_text: string;
  error: string | null;
}

/** The EAST text-presence gate. */
export interface TextGate {
  present: boolean;
  cells: number;
  score: number;
  box: Box | null;
  since: number;
}

/** The last text read (Claude, or Tesseract offline). */
export interface ReadResult {
  available: boolean;
  provider: 'anthropic' | 'openai' | null;
  model: string | null;
  engine: 'anthropic' | 'openai' | 'tesseract' | null;
  text: string;
  confidence: number;
  latency_ms: number;
  at: number;
  requested_at: number;
  passes: number;
  raw: string;
  error: string | null;
  /** Milliseconds until the next cloud read is allowed. */
  gap_left_ms: number;
  read_gap_ms: number;
}

export interface BridgeState {
  recognizer: Recognizer;
  sound: SoundStatus;
  engine: Engine;
  /** Active input lock: pauses the camera or microphone worker. */
  paused: boolean;
  text: TextGate;
  read: ReadResult;
  /** Object labels the detector is allowed to report. */
  classes: string[];
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

export function bridgeSetPaused(baseUrl: string, paused: boolean): Promise<BridgeState> {
  return post<BridgeState>(baseUrl, `/pause?value=${paused ? 1 : 0}`);
}
