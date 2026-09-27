import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dotsToMask, encodeText } from './lib/braille';
import { SAMPLES, bridgeDetection, makeDetection, manualDetection, type Detection, type DetectionKind } from './lib/detections';
import { useCellStream } from './hooks/useCellStream';
import { useHardware } from './hooks/useHardware';
import { useBridge } from './hooks/useBridge';
import { TopBar, type Status, type View } from './components/TopBar';
import { DevView } from './components/DevView';
import { Viewfinder, type LiveFeed } from './components/Viewfinder';
import { bridgeSendAslFrame, bridgeSendCameraFrame, type AslStatus } from './lib/bridge';
import { BragiPanel } from './components/BragiPanel';
import { DetectionCard } from './components/DetectionCard';
import { TextReadCard } from './components/TextReadCard';
import { QueueCard } from './components/QueueCard';
import { CellHero } from './components/CellHero';
import { SequenceStrip } from './components/SequenceStrip';
import { MicStatusCard } from './components/MicStatusCard';
import { type Frame } from './components/PinPanel';
import { type Settings } from './components/SettingsCard';

/** How long the simulated detector "looks" before it answers. */
const SCAN_MS = 1400;
const FRAME_LOG_SIZE = 6;
/** Pause between one queued message finishing and the next starting. */
const QUEUE_GAP_MS = 700;
/** Shown only until the bridge's first /state response arrives. */
const DEFAULT_ASL: AslStatus = {
  available: false, classifier: 'knn', label: null, stable_count: 0, stable_needed: 2, last_spoken: null, error: null,
};

/** `?text=Hello` in the URL plays that text on load; otherwise wait for real input. */
function initialDetection(): Detection | null {
  const text = new URLSearchParams(window.location.search).get('text')?.trim();
  return text ? manualDetection(text) : null;
}

export default function App() {
  const [settings, setSettings] = useState<Settings>({
    cellMs: 900,
    spaceMs: 500,
    loop: false,
    capitalIndicators: true,
  });
  const [detection, setDetection] = useState<Detection | null>(initialDetection);
  const [scanning, setScanning] = useState(false);
  const [cameraModeBusy, setCameraModeBusy] = useState(false);
  const sampleCursor = useRef(0);
  const scanTimer = useRef<number | null>(null);

  // The real finger module: a Pi driving six solenoids, one per dot.
  const hardware = useHardware();
  // The laptop recognition bridge: camera vision or name-triggered sound -> queue.
  const bridge = useBridge();

  // Two screens: Main (what an audience should see) and Dev (raw model
  // diagnostics, the queue's internals, GPIO pin states, timing, testing
  // bypasses -- everything that used to be split across two separate "lab"
  // and "settings" tabs for no good reason, since both were just "not the
  // demo").
  const hashToView = (hash: string): View => (hash === '#dev' ? 'dev' : 'main');
  const viewToHash: Record<View, string> = { main: '', dev: '#dev' };
  const [view, setViewState] = useState<View>(() => hashToView(window.location.hash));
  const setView = useCallback((v: View) => {
    window.location.hash = viewToHash[v];
    setViewState(v);
  }, []);
  useEffect(() => {
    const onHash = () => setViewState(hashToView(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Detection → cells → timed stream. The browser is the clock; every cell
  // it shows is also sent to the Pi, so the screen and the finger agree.
  const cells = useMemo(
    () => encodeText(detection?.label ?? '', { capitalIndicators: settings.capitalIndicators, kind: detection?.kind }),
    [detection, settings.capitalIndicators],
  );
  const stream = useCellStream(cells, {
    cellMs: settings.cellMs,
    spaceMs: settings.spaceMs,
    loop: settings.loop,
    autoPlay: true,
  });

  // Capture: with the bridge online, queue what the camera sees now;
  // otherwise fall back to the simulated detector.
  const { capture: bridgeCapture, next: bridgeNext } = bridge;
  const capture = useCallback(() => {
    if (scanning) return;
    if (bridge.online) {
      void bridgeCapture();
      return;
    }
    setScanning(true);
    scanTimer.current = window.setTimeout(() => {
      const sample = SAMPLES[sampleCursor.current % SAMPLES.length];
      sampleCursor.current += 1;
      setDetection(makeDetection(sample, 'simulated'));
      setScanning(false);
    }, SCAN_MS);
  }, [scanning, bridge.online, bridgeCapture]);

  useEffect(() => () => { if (scanTimer.current) window.clearTimeout(scanTimer.current); }, []);

  const sendText = useCallback((text: string) => setDetection(manualDetection(text)), []);

  // Queue consumer: when nothing is playing, pull the next recognition result.
  const queueLen = bridge.state?.queue.length ?? 0;
  const idle = !scanning && !stream.playing && (stream.total === 0 || stream.finished || stream.index < 0);
  useEffect(() => {
    if (view !== 'main' || !bridge.online || queueLen === 0 || !idle || hardware.locked) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const item = await bridgeNext();
      if (!cancelled && item) setDetection(bridgeDetection(item));
    }, QUEUE_GAP_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [view, bridge.online, queueLen, idle, bridgeNext, hardware.locked]);

  // Precedence and relevance while something is playing:
  //  - a higher-precedence item at the head of the queue (speech > text > object) cuts in;
  //  - an object that has left the view is cut short when anything else is waiting.
  const PRIO: Record<string, number> = { speech: 0, text: 1, object: 2 };
  const head = bridge.state?.queue[0];
  const headPrio = head ? PRIO[head.kind] ?? 3 : null;
  const playingPrio = detection && detection.source !== 'manual' && detection.source !== 'simulated' ? PRIO[detection.kind] ?? 3 : null;
  const playingObjectGone =
    detection?.kind === 'object' && detection.source === 'camera' && bridge.state
      ? !bridge.state.visible.includes(detection.label.toLowerCase())
      : false;
  useEffect(() => {
    if (view !== 'main' || hardware.locked || !stream.playing || playingPrio === null || headPrio === null) return;
    if (headPrio < playingPrio || (playingObjectGone && queueLen > 0)) stream.stop();
  }, [view, hardware.locked, stream, playingPrio, headPrio, playingObjectGone, queueLen]);

  // Every change of the displayed cell is one frame to the controller.
  const [frames, setFrames] = useState<Frame[]>([]);
  const frameSeq = useRef(0);
  const lastFrameKey = useRef('');
  const { sendCell, allOff, live } = hardware;
  useEffect(() => {
    const key = `${detection?.id ?? 'idle'}:${stream.index}`;
    if (lastFrameKey.current === key) return;
    lastFrameKey.current = key;
    frameSeq.current += 1;
    const mask = stream.current ? dotsToMask(stream.current.dots) : 0;
    const frame: Frame = {
      id: frameSeq.current,
      at: Date.now(),
      mask,
      label: stream.current?.label ?? '',
      sent: live,
    };
    setFrames((prev) => [frame, ...prev].slice(0, FRAME_LOG_SIZE));
    if (stream.current) sendCell(mask, stream.holdMs);
    else allOff();
  }, [detection?.id, stream.index, stream.current, stream.holdMs, sendCell, allOff, live]);

  // Pausing drops the pins; stepping while paused raises them again above.
  useEffect(() => {
    if (!stream.playing) allOff();
  }, [stream.playing, allOff]);

  // Pin lock: stop what is playing, then latch the Pi so nothing can move.
  const { setLocked } = hardware;
  const lockPins = useCallback(
    (locked: boolean) => {
      if (locked) {
        stream.pause();
        allOff();
      }
      setLocked(locked);
    },
    [stream, allOff, setLocked],
  );

  // Stop everything: playback, pins, queue, and any scan in progress.
  const { clear: bridgeClear } = bridge;
  const { setPaused, setMicPaused } = bridge;
  const stop = useCallback(() => {
    if (scanTimer.current) window.clearTimeout(scanTimer.current);
    setScanning(false);
    stream.stop();
    allOff();
    bridgeClear();
    // Pause both recognizers too -- otherwise the camera or microphone just
    // auto-queues something new a moment later and playback quietly resumes,
    // which looks like Stop did nothing. Pause camera/mic in the top bar
    // resume them explicitly.
    setPaused(true);
    setMicPaused(true);
  }, [stream, allOff, bridgeClear, setPaused, setMicPaused]);

  // Play a label on the finger right away (used by the lab screen).
  const sendNow = useCallback((label: string, kind: DetectionKind) => {
    setDetection(bridgeDetection({ id: `lab-${Date.now()}`, at: Date.now(), kind, label, confidence: 1, box: null, source: kind === 'speech' ? 'microphone' : 'camera' }));
  }, []);

  const status: Status = scanning
    ? 'scanning'
    : stream.playing
      ? 'streaming'
      : stream.finished
        ? 'complete'
        : stream.total > 0 && stream.index >= 0
          ? 'paused'
          : 'idle';

  const recognizer = bridge.state?.recognizer ?? 'camera';
  const soundMode = recognizer === 'sound';
  const hasMic = recognizer !== 'camera';
  const cameraMode = bridge.state?.camera_mode ?? 'objects';
  const aslMode = cameraMode === 'asl';
  const { setCameraMode: bridgeSetCameraMode } = bridge;
  const [cameraModeError, setCameraModeError] = useState<string | null>(null);
  const handleCameraMode = useCallback(
    async (mode: typeof cameraMode) => {
      setCameraModeBusy(true);
      setCameraModeError(null);
      const ok = await bridgeSetCameraMode(mode);
      setCameraModeBusy(false);
      // The switch can fail server-side (e.g. the ASL model didn't load) without
      // throwing, in which case cameraMode silently stays where it was; surface
      // that instead of leaving the click looking like it did nothing.
      if (!ok) setCameraModeError(`Could not switch to ${mode}${mode === 'asl' ? ' (check the bridge terminal, or mediapipe/model download)' : ''}.`);
    },
    [bridgeSetCameraMode],
  );
  const { baseUrl } = bridge;
  // Browser camera drives detection whenever the bridge's own camera (the Pi
  // stream, or a webcam it opened itself) isn't the one supplying frames --
  // same fallback for Rune and Bragi alike, since detect_loop() feeds
  // STATE["frame"] to asl_pass() exactly like it does the object detector
  // (see bridge/detect_bridge.py). Only actually needed when that camera is
  // down (e.g. a plain command-line Python process without an OS
  // camera-permission prompt).
  const browserFeedActive = bridge.online && !(bridge.state?.camera_ok ?? false);
  const handleFrame = useCallback(
    (blob: Blob) => {
      if (aslMode) void bridgeSendAslFrame(baseUrl, blob);
      else void bridgeSendCameraFrame(baseUrl, blob);
    },
    [aslMode, baseUrl],
  );

  // Bragi's spoken-letter history: the bridge only reports the single most
  // recent one (STATE["asl"]["last_spoken"]), so track transitions ourselves
  // to build a running "what's been said" readout for the panel.
  const [aslHistory, setAslHistory] = useState<string[]>([]);
  const lastSpokenRef = useRef<string | null>(null);
  const lastSpoken = bridge.state?.asl.last_spoken ?? null;
  useEffect(() => {
    if (lastSpoken && lastSpoken !== lastSpokenRef.current) {
      setAslHistory((h) => [...h, lastSpoken]);
    }
    lastSpokenRef.current = lastSpoken;
  }, [lastSpoken]);
  const clearAslHistory = useCallback(() => setAslHistory([]), []);

  const liveFeed: LiveFeed | null =
    bridge.online && bridge.state && !soundMode
      ? {
          streamUrl: bridge.streamUrl,
          cameraOk: bridge.state.camera_ok,
          detections: bridge.state.detections,
          best: bridge.state.best,
          stats: bridge.state.stats,
          frameSize: bridge.state.frame_size,
        }
      : null;
  const nowPlaying = detection && (detection.source === 'camera' || detection.source === 'microphone') && stream.index >= 0 && !stream.finished ? detection.label : null;

  return (
    <div className="app">
      <TopBar
        status={status}
        index={stream.index}
        total={stream.total}
        live={hardware.live}
        host={hardware.host}
        hardwareEnabled={hardware.enabled}
        onSetHardwareEnabled={hardware.setEnabled}
        hardwareOnline={hardware.online}
        view={view}
        onView={setView}
        onStop={stop}
        pinsLocked={hardware.locked}
        onLockPins={lockPins}
        recognizer={recognizer}
        cameraPaused={bridge.paused}
        onPauseCamera={bridge.setPaused}
        micPaused={bridge.micPaused}
        onPauseMic={bridge.setMicPaused}
        nearbyVoice={bridge.state?.proximity.enabled ?? false}
        cameraMode={cameraMode}
        onCameraMode={handleCameraMode}
        cameraModeBusy={cameraModeBusy}
        bridgeOffline={!bridge.online}
      />

      {view === 'dev' ? (
        <DevView
          bridge={bridge}
          nowPlaying={detection && stream.index >= 0 && !stream.finished ? detection.label : null}
          onSendNow={sendNow}
          onSendText={sendText}
          sendDisabled={scanning}
          cell={stream.current}
          frames={frames}
          hardware={hardware}
          settings={settings}
          onSettingsChange={setSettings}
        />
      ) : (
      <main className="layout">
        <div className="col" aria-label="Input">
          {!soundMode && (
            <Viewfinder
              detection={scanning ? null : detection}
              scanning={scanning}
              onCapture={capture}
              live={liveFeed}
              aslActive={aslMode}
              browserFeedActive={browserFeedActive}
              onFrame={handleFrame}
            />
          )}
          {!aslMode && <DetectionCard detection={detection} cellCount={cells.length} />}
          {/* Sound-only has no camera column to balance against, so its mic
              status stays here; with a camera, the feed (tall -- the Pi's is
              portrait) already fills this column, so text/mic move to the
              right instead of stacking below it out of view. */}
          {!aslMode && hasMic && soundMode && <MicStatusCard bridge={bridge} />}
        </div>

        {aslMode ? (
          <div className="col" aria-label="Output">
            <BragiPanel asl={bridge.state?.asl ?? DEFAULT_ASL} history={aslHistory} onClear={clearAslHistory} />
          </div>
        ) : (
          <div className="col" aria-label="Output">
            <CellHero stream={stream} />
            <SequenceStrip text={detection?.label ?? ''} cells={cells} index={stream.index} onSelect={stream.seek} />
            <QueueCard bridge={bridge} nowPlaying={nowPlaying} />
            {!soundMode && <TextReadCard bridge={bridge} onSend={sendNow} />}
            {!soundMode && hasMic && <MicStatusCard bridge={bridge} />}
          </div>
        )}
      </main>
      )}

      <footer className="foot small muted">
        Uncontracted braille, one 3 × 2 cell at a time. Pin numbering follows the standard cell: 1–3 down the left column, 4–6 down the right.
        {hardware.live ? ` Live on the Pi at ${hardware.host}.` : ' Hardware offline: simulating.'}
        {bridge.online ? ` ${recognizer === 'both' ? 'Camera + microphone' : soundMode ? 'Sound' : 'Camera'} bridge connected.` : ' Bridge not connected: start bridge/detect_bridge.py.'}
        {!aslMode && (cameraModeError || bridge.state?.asl.error) ? ` ⚠ ${cameraModeError || bridge.state?.asl.error}` : ''}
      </footer>
    </div>
  );
}
