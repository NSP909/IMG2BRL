import { useEffect, useRef } from 'react';
import type { Detection } from '../lib/detections';
import type { BridgeDetection, BridgeStats } from '../lib/bridge';
import { useCamera } from '../hooks/useCamera';
import { CameraIcon, ScanIcon } from './Icons';

/** How often to POST a captured frame to the bridge while in ASL mode. */
const ASL_CAPTURE_MS = 350;

/** What the viewfinder shows when the Pi camera bridge is connected. */
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
  /** ASL mode: use the browser's own camera (getUserMedia) instead of the Pi
   * stream, and POST captured frames to the bridge -- lets ASL be tested
   * without granting the bridge process its own OS camera permission. */
  aslActive?: boolean;
  onAslFrame?: (blob: Blob) => void;
}

export function Viewfinder({ detection, scanning, onCapture, live, aslActive, onAslFrame }: Props) {
  const cam = useCamera();
  const webcam = cam.state === 'on';
  // In ASL mode the browser's own camera is the source of truth, even if a
  // Pi-side bridge stream also exists -- Bragi answers to a bystander who can
  // see the wearer, not through the Pi's outward-facing feed.
  const isLive = Boolean(live) && !aslActive;
  const box = detection?.box;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const { start: camStart } = cam;
  useEffect(() => {
    if (aslActive) void camStart();
  }, [aslActive, camStart]);

  const onAslFrameRef = useRef(onAslFrame);
  onAslFrameRef.current = onAslFrame;
  useEffect(() => {
    if (!aslActive || cam.state !== 'on') return;
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
      canvas.toBlob((blob) => { if (blob) onAslFrameRef.current?.(blob); }, 'image/jpeg', 0.85);
    }, ASL_CAPTURE_MS);
    return () => window.clearInterval(id);
  }, [aslActive, cam.state, cam.videoRef]);

  return (
    <section className="card viewfinder" aria-label="Camera">
      <div
        className={`vf__frame ${isLive || webcam ? 'vf__frame--live' : ''} ${!aslActive && live?.frameSize && live.frameSize[1] > live.frameSize[0] ? 'vf__frame--portrait' : ''}`}
        style={!aslActive && live?.frameSize ? { aspectRatio: `${live.frameSize[0]} / ${live.frameSize[1]}` } : undefined}
      >
        {live && !aslActive ? (
          <img className="vf__video" src={live.streamUrl} alt="Live view from the Pi camera" />
        ) : (
          <video ref={cam.videoRef} className="vf__video" muted playsInline hidden={!webcam} />
        )}
        <canvas ref={canvasRef} hidden />

        <span className="vf__corner vf__corner--tl" />
        <span className="vf__corner vf__corner--tr" />
        <span className="vf__corner vf__corner--bl" />
        <span className="vf__corner vf__corner--br" />

        {scanning && <div className="vf__scan" aria-hidden />}

        {isLive
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
          {aslActive
            ? cam.state === 'on'
              ? 'Browser camera · streaming frames to Bragi'
              : cam.state === 'starting'
                ? 'Starting the browser camera…'
                : cam.error || 'Waiting for camera permission…'
            : live
              ? live.cameraOk
                ? `Pi camera · ${live.stats.model} on ${live.stats.device} · ${live.stats.infer_ms} ms · text gate ${live.stats.gate_ms} ms`
                : 'Bridge running · waiting for the Pi camera'
              : scanning
                ? 'Looking for objects and text…'
                : webcam
                  ? 'Live preview · detection is simulated'
                  : 'Simulated frame · detection is simulated'}
        </div>
      </div>

      {!aslActive && (
      <div className="vf__bar">
        <button type="button" className="btn btn--primary" onClick={onCapture} disabled={scanning || (isLive && !live?.best)}>
          <ScanIcon />
          {scanning ? 'Scanning…' : isLive ? (live?.best ? `Send “${live.best.label}”` : 'Nothing in view') : 'Capture frame'}
        </button>
        <div className="vf__bar-right">
          {isLive ? (
            <span className="small muted">{live?.detections.length ?? 0} in view</span>
          ) : (
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
