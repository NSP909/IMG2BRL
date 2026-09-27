import { useEffect, useRef, useState } from 'react';
import type { Detection } from '../lib/detections';
import type { BridgeDetection, BridgeStats } from '../lib/bridge';
import { useCamera } from '../hooks/useCamera';
import { CameraIcon, ScanIcon } from './Icons';
import { HandSkeleton } from './HandSkeleton';
import { useSmoothedPoints } from '../hooks/useAslHand';

/** How often to POST a captured frame to the bridge while browser-fed. */
const CAPTURE_MS = 350;

/** What the viewfinder shows when the bridge is connected (Pi, laptop
 * OpenCV, or a browser-fed frame -- this doesn't know or care which). */
export interface LiveFeed {
  streamUrl: string;
  cameraOk: boolean;
  detections: BridgeDetection[];
  best: BridgeDetection | null;
  stats: BridgeStats;
  /** [width, height] of the frames as streamed (after rotation). */
  frameSize: [number, number] | null;
}

interface Props {
  detection: Detection | null;
  scanning: boolean;
  onCapture(): void;
  live?: LiveFeed | null;
  /** ASL mode specifically (changes the hint text and hides the capture bar,
   * which doesn't apply to Bragi -- it never queues anything). */
  aslActive?: boolean;
  /** True whenever the browser's own camera (getUserMedia) should be driving
   * detection instead of the bridge process's own OS camera access -- true
   * for ASL always, and true for Rune whenever the bridge can't open its own
   * camera. Same underlying fix in both cases: a plain command-line Python
   * process often can't even prompt for camera permission (no app bundle to
   * attach the OS request to), so the browser tab does it instead. */
  browserFeedActive?: boolean;
  onFrame?: (blob: Blob) => void;
  /** How often to send a browser frame. Bragi's CNN smooths over frames and reads J/Z from motion, so it wants them faster. */
  captureMs?: number;
  /** Bragi: the 21 hand points (0-1, upright displayed frame), drawn over the feed like the CNN sees them. */
  hand?: [number, number][] | null;
}

export function Viewfinder({ detection, scanning, onCapture, live, aslActive, browserFeedActive, onFrame, captureMs = CAPTURE_MS, hand }: Props) {
  const cam = useCamera();
  const webcam = cam.state === 'on';
  // A real detection feed exists whenever the bridge has state, regardless of
  // whether the frames came from its own camera or a browser-fed one -- only
  // *which element displays it* depends on the frame source.
  const hasFeed = Boolean(live);
  const box = detection?.box;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The browser video's real shape, so the frame (and the hand overlay drawn
  // in its percentages) matches it instead of cropping to 4:3.
  const [videoSize, setVideoSize] = useState<[number, number] | null>(null);
  const bridgeView = Boolean(live && !browserFeedActive);
  const view: [number, number] | null = bridgeView ? live?.frameSize ?? null : videoSize;
  const smoothHand = useSmoothedPoints(hand ?? null);

  const { start: camStart } = cam;
  useEffect(() => {
    if (browserFeedActive) void camStart();
  }, [browserFeedActive, camStart]);

  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  useEffect(() => {
    if (!browserFeedActive || cam.state !== 'on') return;
    const video = cam.videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const id = window.setInterval(() => {
      if (!video.videoWidth) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      canvas.toBlob((blob) => { if (blob) onFrameRef.current?.(blob); }, 'image/jpeg', 0.85);
    }, captureMs);
    return () => window.clearInterval(id);
  }, [browserFeedActive, cam.state, cam.videoRef, captureMs]);

  return (
    <section className="card viewfinder" aria-label="Camera">
      <div
        className={`vf__frame ${hasFeed || webcam ? 'vf__frame--live' : ''} ${!browserFeedActive && live?.frameSize && live.frameSize[1] > live.frameSize[0] ? 'vf__frame--portrait' : ''}`}
        style={view ? { aspectRatio: `${view[0]} / ${view[1]}` } : undefined}
      >
        {live && !browserFeedActive ? (
          <img className="vf__video" src={live.streamUrl} alt="Live view from the bridge camera" />
        ) : (
          <video
            ref={cam.videoRef}
            className={`vf__video ${aslActive ? 'vf__video--mirror' : ''}`}
            muted
            playsInline
            hidden={!webcam}
            onLoadedMetadata={(e) => setVideoSize([e.currentTarget.videoWidth, e.currentTarget.videoHeight])}
          />
        )}
        <canvas ref={canvasRef} hidden />

        <span className="vf__corner vf__corner--tl" />
        <span className="vf__corner vf__corner--tr" />
        <span className="vf__corner vf__corner--bl" />
        <span className="vf__corner vf__corner--br" />

        {scanning && <div className="vf__scan" aria-hidden />}

        {smoothHand && view && (
          <svg
            className={`vf__hand ${aslActive && !bridgeView ? 'vf__video--mirror' : ''}`}
            viewBox={`0 0 ${view[0]} ${view[1]}`}
            aria-hidden
          >
            <HandFocus points={smoothHand} w={view[0]} h={view[1]} />
            <HandSkeleton points={smoothHand} w={view[0]} h={view[1]} size={0.011} />
          </svg>
        )}

        {hasFeed
          ? live!.detections.map((d, i) => {
              if (!d.box) return null;
              const isBest = live!.best !== null && d.label === live!.best.label && d.kind === live!.best.kind;
              return (
                <div
                  key={`${d.kind}-${d.label}-${i}`}
                  className={`vf__box vf__box--${d.kind} ${isBest ? '' : 'vf__box--dim'} ${d.engine === 'east' ? 'vf__box--gate' : ''}`}
                  style={{ left: `${d.box.x * 100}%`, top: `${d.box.y * 100}%`, width: `${d.box.w * 100}%`, height: `${d.box.h * 100}%` }}
                >
                  <span className="vf__tag">
                    {d.engine === 'east' ? 'text?' : d.kind === 'text' ? `“${d.label}”` : d.label} · {Math.round(d.confidence * 100)}%
                  </span>
                </div>
              );
            })
          : !scanning && detection && box && (
              <div
                key={detection.id}
                className="vf__box"
                style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}
              >
                <span className="vf__tag">
                  {detection.kind} · {Math.round(detection.confidence * 100)}%
                </span>
              </div>
            )}

        <div className="vf__hint">
          {browserFeedActive
            ? cam.state === 'on'
              ? `Browser camera · streaming frames to ${aslActive ? 'Bragi' : 'Rune'}`
              : cam.state === 'starting'
                ? 'Starting the browser camera…'
                : cam.error || 'Waiting for camera permission…'
            : live
              ? live.cameraOk
                ? `Camera bridge · ${live.stats.model} on ${live.stats.device} · ${live.stats.infer_ms} ms · text gate ${live.stats.gate_ms} ms`
                : 'Bridge running · waiting for a frame'
              : scanning
                ? 'Looking for objects and text…'
                : webcam
                  ? 'Live preview · detection is simulated'
                  : 'Simulated frame · detection is simulated'}
        </div>
      </div>

      {!aslActive && (
      <div className="vf__bar">
        <button type="button" className="btn btn--primary" onClick={onCapture} disabled={scanning || (hasFeed && !live?.best)}>
          <ScanIcon />
          {scanning ? 'Scanning…' : hasFeed ? (live?.best ? `Send “${live.best.label}”` : 'Nothing in view') : 'Capture frame'}
        </button>
        <div className="vf__bar-right">
          {hasFeed ? (
            <span className="small muted">{live?.detections.length ?? 0} in view</span>
          ) : browserFeedActive ? null : (
            <>
              {cam.error && <span className="small muted">{cam.error}</span>}
              <button
                type="button"
                className="btn"
                onClick={webcam ? cam.stop : cam.start}
                disabled={cam.state === 'starting'}
                aria-pressed={webcam}
              >
                <CameraIcon />
                {webcam ? 'Stop camera' : cam.state === 'starting' ? 'Starting…' : 'Use camera'}
              </button>
            </>
          )}
        </div>
      </div>
      )}
    </section>
  );
}

/** The box around the hand that the CNN crops to (its "AI focus"). */
function HandFocus({ points, w, h }: { points: [number, number][]; w: number; h: number }) {
  const xs = points.map((p) => p[0] * w);
  const ys = points.map((p) => p[1] * h);
  const pad = 0.12 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return (
    <rect
      x={x}
      y={y}
      width={Math.max(...xs) - Math.min(...xs) + 2 * pad}
      height={Math.max(...ys) - Math.min(...ys) + 2 * pad}
      fill="none"
      stroke="rgb(74,144,226)"
      strokeWidth={Math.min(w, h) * 0.004}
      rx={Math.min(w, h) * 0.008}
    />
  );
}
