import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dotsToMask, encodeText } from './lib/braille';
import { SAMPLES, bridgeDetection, makeDetection, manualDetection, type Detection, type DetectionKind } from './lib/detections';
import { useCellStream } from './hooks/useCellStream';
import { useHardware } from './hooks/useHardware';
import { useBridge } from './hooks/useBridge';
import { TopBar, type Status, type View } from './components/TopBar';
import { LabView } from './components/LabView';
import { Viewfinder, type LiveFeed } from './components/Viewfinder';
import { DetectionCard } from './components/DetectionCard';
import { QueueCard } from './components/QueueCard';
import { ComposeCard } from './components/ComposeCard';
import { CellHero } from './components/CellHero';
import { SequenceStrip } from './components/SequenceStrip';
import { PinPanel, type Frame } from './components/PinPanel';
import { SettingsCard, type Settings } from './components/SettingsCard';
import { SoundPanel } from './components/SoundPanel';

/** How long the simulated detector "looks" before it answers. */
const SCAN_MS = 1400;
const FRAME_LOG_SIZE = 6;
/** Pause between one queued message finishing and the next starting. */
const QUEUE_GAP_MS = 700;

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
  const sampleCursor = useRef(0);
  const scanTimer = useRef<number | null>(null);

  // The real finger module: a Pi driving six solenoids, one per dot.
  const hardware = useHardware();
  // The laptop recognition bridge: camera vision or name-triggered sound -> queue.
  const bridge = useBridge();

  // Two screens: the finger demo, and a lab for testing the camera models alone (#lab).
  const [view, setViewState] = useState<View>(() => (window.location.hash === '#lab' ? 'lab' : 'main'));
  const setView = useCallback((v: View) => {
    window.location.hash = v === 'lab' ? '#lab' : '';
    setViewState(v);
  }, []);
  useEffect(() => {
    const onHash = () => setViewState(window.location.hash === '#lab' ? 'lab' : 'main');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Detection → cells → timed stream. The browser is the clock; every cell
  // it shows is also sent to the Pi, so the screen and the finger agree.
  const cells = useMemo(
    () => encodeText(detection?.label ?? '', { capitalIndicators: settings.capitalIndicators }),
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

  // Precedence: speech that names the wearer interrupts whatever the camera put on the finger.
  const headIsSpeech = bridge.state?.queue[0]?.kind === 'speech';
  useEffect(() => {
    if (view !== 'main' || !headIsSpeech || hardware.locked) return;
    if (stream.playing && detection && detection.source !== 'microphone') stream.stop();
  }, [view, headIsSpeech, hardware.locked, stream, detection]);

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
  const stop = useCallback(() => {
    if (scanTimer.current) window.clearTimeout(scanTimer.current);
    setScanning(false);
    stream.stop();
    allOff();
    bridgeClear();
  }, [stream, allOff, bridgeClear]);

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
  const liveFeed: LiveFeed | null =
    bridge.online && bridge.state && !soundMode
      ? {
          streamUrl: bridge.streamUrl,
          cameraOk: bridge.state.camera_ok,
          detections: bridge.state.detections,
          best: bridge.state.best,
          stats: bridge.state.stats,
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
      />

      {view === 'lab' ? (
        <LabView bridge={bridge} onSend={sendNow} nowPlaying={detection && stream.index >= 0 && !stream.finished ? detection.label : null} />
      ) : (
      <main className="layout">
        <div className="col" aria-label="Input">
          {!soundMode && <Viewfinder detection={scanning ? null : detection} scanning={scanning} onCapture={capture} live={liveFeed} />}
          {hasMic && <SoundPanel bridge={bridge} />}
          <DetectionCard detection={detection} cellCount={cells.length} />
          <QueueCard bridge={bridge} nowPlaying={nowPlaying} />
          <ComposeCard onSend={sendText} disabled={scanning} />
        </div>

        <div className="col" aria-label="Output">
          <CellHero stream={stream} />
          <SequenceStrip text={detection?.label ?? ''} cells={cells} index={stream.index} onSelect={stream.seek} />
        </div>

        <div className="bottom">
          <PinPanel cell={stream.current} frames={frames} hardware={hardware} />
          <SettingsCard settings={settings} onChange={setSettings} />
        </div>
      </main>
      )}

      <footer className="foot small muted">
        Uncontracted braille, one 3 × 2 cell at a time. Pin numbering follows the standard cell: 1–3 down the left column, 4–6 down the right.
        {hardware.live ? ` Live on the Pi at ${hardware.host}.` : ' Hardware offline: simulating.'}
        {bridge.online ? ` ${recognizer === 'both' ? 'Camera + microphone' : soundMode ? 'Sound' : 'Camera'} bridge connected.` : ''}
      </footer>
    </div>
  );
}
