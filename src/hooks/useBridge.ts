import { useCallback, useEffect, useRef, useState } from 'react';
import {
  bridgeAnalyze,
  bridgeAslRecord,
  bridgeAslRecordCancel,
  bridgeAslRecordClear,
  bridgeAslSetSampleSet,
  bridgeAslWord,
  bridgeAslTrainSpace,
  bridgeCapture,
  bridgeClear,
  bridgeNext,
  bridgeSetCameraMode,
  bridgeSetAslClassifier,
  bridgeSetCameraSource,
  bridgeSetEngine,
  bridgeSetMode,
  bridgeSetPausedTarget,
  bridgeSetProximity,
  bridgeSetRotate,
  bridgeSetWake,
  fetchBridgeState,
  loadBridgeUrl,
  streamUrl,
  type AslSampleSet,
  type AslWordAction,
  type AslClassifier,
  type BridgeState,
  type CameraMode,
  type CameraSource,
  type Engine,
  type QueueItem,
} from '../lib/bridge';

const POLL_MS = 500;
/** In Bragi the hand overlay and top-3 bars follow the hand, so poll faster. */
const POLL_MS_ASL = 150;

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
  /** Opt-in nearby-voice pathway. */
  setProximity(enabled: boolean): void;
  /** Clockwise camera rotation. */
  setRotate(deg: 0 | 90 | 180 | 270): void;
  /** Same camera, interpreted as objects/text (Rune) or ASL fingerspelling
   * spoken aloud (Bragi). Resolves false (state left unchanged) if the ASL
   * model failed to load. */
  setCameraMode(mode: CameraMode): Promise<boolean>;
  /** Which physical camera to read from: the Pi's own, or this laptop's
   * webcam (handy for testing away from the Pi). Resolves false if --camera
   * pinned the source at bridge startup. */
  setCameraSource(source: CameraSource): Promise<boolean>;
  /** Switch Bragi's letter model (CNN, KNN or rules). Resolves false if it couldn't load. */
  setAslClassifier(classifier: AslClassifier): Promise<boolean>;
  /** Bragi sample recorder: capture one letter from the live feed. */
  aslRecord(letter: string, count: number): Promise<boolean>;
  aslRecordCancel(): void;
  aslSetSampleSet(set: AslSampleSet): void;
  aslRecordClear(letter?: string): void;
  /** The word being spelled: finish (decode and speak), backspace, clear; reset also clears the sentence. */
  aslWord(action: AslWordAction): void;
  /** Retrain the CNN's SPACE output from the recorded Space samples. */
  aslTrainSpace(): void;
}

export function useBridge(): Bridge {
  const [baseUrl] = useState(loadBridgeUrl);
  const [state, setState] = useState<BridgeState | null>(null);
  const [online, setOnline] = useState(false);
  const [session, setSession] = useState(0);
  const failures = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    let asl = false;
    const tick = async () => {
      const s = await fetchBridgeState(baseUrl);
      if (cancelled) return;
      if (s) {
        failures.current = 0;
        asl = s.camera_mode === 'asl';
        setState(s);
        setOnline((was) => {
          if (!was) setSession((n) => n + 1); // (re)connected: give the stream a fresh URL
          return true;
        });
      } else if (++failures.current >= 2) {
        setOnline(false);
      }
      timer = window.setTimeout(tick, asl ? POLL_MS_ASL : POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
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

  const setProximity = useCallback(
    (enabled: boolean) => {
      setState((s) => (s ? { ...s, proximity: { ...s.proximity, enabled } } : s));
      bridgeSetProximity(baseUrl, enabled).then(setState).catch(() => {});
    },
    [baseUrl],
  );

  const setRotate = useCallback(
    (deg: 0 | 90 | 180 | 270) => {
      bridgeSetRotate(baseUrl, deg).then(setState).catch(() => {});
    },
    [baseUrl],
  );

  const setCameraMode = useCallback(
    async (mode: CameraMode) => {
      try {
        setState(await bridgeSetCameraMode(baseUrl, mode));
        return true;
      } catch {
        void refresh(); // pull the real state (e.g. the ASL error) back from the bridge
        return false;
      }
    },
    [baseUrl, refresh],
  );

  const setCameraSource = useCallback(
    async (source: CameraSource) => {
      try {
        setState(await bridgeSetCameraSource(baseUrl, source));
        return true;
      } catch {
        void refresh(); // pull the real state back (e.g. camera_source_fixed)
        return false;
      }
    },
    [baseUrl, refresh],
  );

  const aslRecord = useCallback(
    async (letter: string, count: number) => {
      try {
        setState(await bridgeAslRecord(baseUrl, letter, count));
        return true;
      } catch {
        void refresh();
        return false;
      }
    },
    [baseUrl, refresh],
  );

  const aslRecordCancel = useCallback(() => {
    bridgeAslRecordCancel(baseUrl).then(setState).catch(() => {});
  }, [baseUrl]);

  const aslSetSampleSet = useCallback(
    (set: AslSampleSet) => {
      bridgeAslSetSampleSet(baseUrl, set).then(setState).catch(() => {});
    },
    [baseUrl],
  );

  const aslRecordClear = useCallback(
    (letter?: string) => {
      bridgeAslRecordClear(baseUrl, letter).then(setState).catch(() => {});
    },
    [baseUrl],
  );

  const setAslClassifier = useCallback(
    async (classifier: AslClassifier) => {
      try {
        setState(await bridgeSetAslClassifier(baseUrl, classifier));
        return true;
      } catch {
        void refresh();
        return false;
      }
    },
    [baseUrl, refresh],
  );

  const aslTrainSpace = useCallback(() => {
    bridgeAslTrainSpace(baseUrl).then(setState).catch(() => {});
  }, [baseUrl]);

  const aslWord = useCallback(
    (action: AslWordAction) => {
      bridgeAslWord(baseUrl, action).then(setState).catch(() => {});
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
    setProximity,
    setRotate,
    setCameraMode,
    setCameraSource,
    setAslClassifier,
    aslRecord,
    aslRecordCancel,
    aslSetSampleSet,
    aslRecordClear,
    aslWord,
    aslTrainSpace,
  };
}
