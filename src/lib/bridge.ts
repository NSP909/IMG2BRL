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
  /** 0 speech, 1 text, 2 object: the queue is kept in this order. */
  priority: number;
  /** For speech: accepted because it named the wearer, or because someone was close (opt-in). */
  via?: 'name' | 'nearby';
}

export interface Proximity {
  /** The opt-in nearby-voice pathway. Off at every bridge start. */
  enabled: boolean;
  threshold: number;
  /** A person is close to the camera right now (with a short grace period). */
  close: boolean;
  /** Height of the largest person box as a fraction of the frame. */
  ratio: number;
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
export type Recognizer = 'camera' | 'sound' | 'both';
/** Same camera either way: YOLO/EAST/Claude objects+text, or ASL fingerspelling spoken aloud. */
export type CameraMode = 'objects' | 'asl';
/** Bragi's letter model: the skeleton CNN (default), the personal KNN, or the geometric rules. */
export type AslClassifier = 'cnn' | 'knn' | 'geometric';
export interface AslPrediction {
  label: string;
  confidence: number;
}
/** Which physical camera the bridge reads frames from. */
export type CameraSource = 'pi' | 'webcam';

/** Bragi: the wearer's own signing, read from the camera and spoken locally
 * (macOS `say`) for a bystander who doesn't know ASL. Opposite direction from
 * everything else here -- it never enters the braille queue. */
export interface AslStatus {
  available: boolean;
  classifier: AslClassifier;
  label: string | null;
  stable_count: number;
  stable_needed: number;
  /** The CNN's smoothed confidence in `label` (always 1 for the KNN and rules). */
  confidence: number;
  /** The hand is moving: the CNN won't count a letter mid-motion (it's also how it reads J and Z). */
  moving: boolean;
  /** The 21 hand points in the displayed (upright) frame, 0-1, or null with no hand. */
  hand: [number, number][] | null;
  /** Exact normalized skeleton image seen by the small CNN (PNG data URL). */
  skeleton_image: string | null;
  /** Top guesses, best first. */
  predictions: AslPrediction[];
  /** Last sign confirmed: a letter, or "SPACE". */
  last_letter: string | null;
  error: string | null;
  hand_visible: boolean;
  /** Letters since the last SPACE: the word being spelled. */
  word_letters: string[];
  /** Words decoded and spoken this session, oldest first. */
  words: AslWord[];
  /** A finished word is being decoded right now. */
  decoding: boolean;
  /** Unused: words are decoded locally. Kept for older bridges. */
  jev: boolean;
  /** The CNN's SPACE output is being retrained from the recorded Space samples. */
  cnn_training: boolean;
  /** Outcome of the last retrain (held-out accuracy), or null. */
  cnn_train_result: string | null;
  /** Which camera's sample set a recording goes into. */
  record_into: 'pi' | 'laptop';
  laptop_counts: Record<string, number>;
  /** Letter currently being recorded for the KNN set, or null. */
  recording: string | null;
  record_progress: number;
  record_target: number;
  /** Which recorded samples the KNN matches against. */
  sample_set: AslSampleSet;
  /** Samples recorded on this rig's own camera, per letter. */
  pi_counts: Record<string, number>;
}

export type AslSampleSet = 'laptop' | 'pi' | 'both';

/** One fingerspelled word: what the camera caught, and what was spoken. */
export interface AslWord {
  raw: string;
  word: string;
  /** Who picked the word: the local dictionary, or nobody (raw letters). */
  source: 'local' | 'raw';
  confidence: number;
  candidates: string[];
  ms: number;
  error: string | null;
}

export type AslWordAction = 'finish' | 'backspace' | 'clear' | 'reset';

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
  /** Clockwise rotation applied to camera frames, in degrees. */
  rotate: number;
  /** [width, height] of the (rotated) frames, once the camera is up. */
  frame_size: [number, number] | null;
  proximity: Proximity;
  /** Object labels in view right now (lower-case). */
  visible: string[];
  scene: { diff: number; changed_at: number; changes: number; pruned: number };
  recognizer: Recognizer;
  camera_mode: CameraMode;
  /** Which physical camera capture_loop() reads from: the Pi's own, or this laptop's webcam. */
  camera_source: CameraSource;
  /** True when --camera pinned the source at bridge startup (a testing-only override); the toggle is disabled. */
  camera_source_fixed: boolean;
  /** Who delivered a frame in the last 2 s: the bridge's own capture (Pi), a browser tab, or nobody. */
  camera_feed: 'bridge' | 'browser' | 'none';
  asl: AslStatus;
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

/** Change the wearer name (and comma-separated aliases) the microphone listens for. */
export function bridgeSetWake(baseUrl: string, name: string, aliases: string[]): Promise<BridgeState> {
  return post<BridgeState>(baseUrl, `/wake?name=${encodeURIComponent(name)}&aliases=${encodeURIComponent(aliases.join(','))}`);
}

export type PauseTarget = 'all' | 'camera' | 'mic';

export function bridgeSetPausedTarget(baseUrl: string, paused: boolean, target: PauseTarget): Promise<BridgeState> {
  return post<BridgeState>(baseUrl, `/pause?value=${paused ? 1 : 0}&target=${target}`);
}

export function bridgeSetProximity(baseUrl: string, enabled: boolean): Promise<BridgeState> {
  return post<BridgeState>(baseUrl, `/proximity?enabled=${enabled ? 1 : 0}`);
}

export function bridgeSetRotate(baseUrl: string, deg: 0 | 90 | 180 | 270): Promise<BridgeState> {
  return post<BridgeState>(baseUrl, `/rotate?deg=${deg}`);
}

/** Switch what the same camera feed is interpreted as. Loads the hand model
 * on first switch to 'asl', so this can take a moment and can fail (no
 * mediapipe installed, model download blocked, etc.) -- callers should
 * expect the promise to reject. */
export function bridgeSetCameraMode(baseUrl: string, mode: CameraMode): Promise<BridgeState> {
  return post<BridgeState>(baseUrl, `/camera_mode?value=${mode}`);
}

/** Record `count` hand samples of one letter from the live feed into the
 * bridge's own sample set (bridge/models/asl_samples_pi.json). */
export function bridgeAslRecord(baseUrl: string, letter: string, count: number): Promise<BridgeState> {
  return post<BridgeState>(baseUrl, `/asl_record?letter=${encodeURIComponent(letter)}&count=${count}`);
}

/** Finish (decode + speak), backspace, or clear the word being spelled; reset also clears the spoken sentence. */
export function bridgeAslWord(baseUrl: string, action: AslWordAction): Promise<BridgeState> {
  return post<BridgeState>(baseUrl, `/asl_word?action=${action}`);
}

/** Retrain the CNN's SPACE output from the recorded Space samples (runs in the background). */
export function bridgeAslTrainSpace(baseUrl: string): Promise<BridgeState> {
  return post<BridgeState>(baseUrl, '/asl_train_space');
}

export function bridgeAslRecordCancel(baseUrl: string): Promise<BridgeState> {
  return post<BridgeState>(baseUrl, '/asl_record_cancel');
}

export function bridgeAslSetSampleSet(baseUrl: string, set: AslSampleSet): Promise<BridgeState> {
  return post<BridgeState>(baseUrl, `/asl_sample_set?value=${set}`);
}

/** Drop recorded samples for one letter, or every letter when omitted. */
export function bridgeAslRecordClear(baseUrl: string, letter?: string): Promise<BridgeState> {
  return post<BridgeState>(baseUrl, `/asl_record_clear${letter ? `?letter=${encodeURIComponent(letter)}` : ''}`);
}

/** Switch Bragi's letter model live. If the new one can't load, the old one stays active. */
export function bridgeSetAslClassifier(baseUrl: string, classifier: AslClassifier): Promise<BridgeState> {
  return post<BridgeState>(baseUrl, `/asl_classifier?value=${classifier}`);
}

/** Switch which physical camera capture_loop() reads from: the Pi's own, or
 * this laptop's webcam. Rejects if --camera pinned the source at startup. */
export function bridgeSetCameraSource(baseUrl: string, source: CameraSource): Promise<BridgeState> {
  return post<BridgeState>(baseUrl, `/camera_source?value=${source}`);
}

/** Browser-captured frame (getUserMedia) for ASL mode, bypassing the bridge's
 * own OS camera access entirely -- handy when the bridge process hasn't been
 * granted camera permission but the browser tab has. Silently drops failures
 * (an occasional missed frame just means one skipped detect pass). */
export async function bridgeSendAslFrame(baseUrl: string, blob: Blob): Promise<AslStatus | null> {
  try {
    const res = await fetch(`${baseUrl}/asl_frame`, {
      method: 'POST',
      body: blob,
      headers: { 'Content-Type': 'image/jpeg' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { asl: AslStatus };
    return data.asl;
  } catch {
    return null;
  }
}

/** Browser-captured frame (getUserMedia) for Rune's object/text detection,
 * same reasoning as bridgeSendAslFrame: lets detect_loop() run without this
 * process's own OS camera permission. Feeds STATE["frame"] directly, so it
 * works no matter which camera_mode is active. */
export async function bridgeSendCameraFrame(baseUrl: string, blob: Blob): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/camera_frame`, {
      method: 'POST',
      body: blob,
      headers: { 'Content-Type': 'image/jpeg' },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Bragi's live hand view: polled much faster than /state, so it's kept tiny. */
export type AslHand = Pick<AslStatus, 'hand' | 'skeleton_image' | 'predictions' | 'label' | 'confidence' | 'moving' | 'classifier'>;

export async function fetchAslHand(baseUrl: string, timeoutMs = 800): Promise<AslHand | null> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/asl_hand`, { signal: ctrl.signal, cache: 'no-store' });
    return res.ok ? ((await res.json()) as AslHand) : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}
