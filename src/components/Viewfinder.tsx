import type { Detection } from '../lib/detections';
import type { BridgeDetection, BridgeStats } from '../lib/bridge';
import { useCamera } from '../hooks/useCamera';
import { CameraIcon, ScanIcon } from './Icons';

/** What the viewfinder shows when the Pi camera bridge is connected. */
export interface LiveFeed {
  streamUrl: string;
  cameraOk: boolean;
  detections: BridgeDetection[];
  best: BridgeDetection | null;
  stats: BridgeStats;
}

interface Props {
  detection: Detection | null;
  scanning: boolean;
  onCapture(): void;
  live?: LiveFeed | null;
}

export function Viewfinder({ detection, scanning, onCapture, live }: Props) {
  const cam = useCamera();
  const webcam = cam.state === 'on';
  const isLive = Boolean(live);
  const box = detection?.box;

  return (
    <section className="card viewfinder" aria-label="Camera">
      <div className={`vf__frame ${isLive || webcam ? 'vf__frame--live' : ''}`}>
        {live ? (
          <img className="vf__video" src={live.streamUrl} alt="Live view from the Pi camera" />
        ) : (
          <video ref={cam.videoRef} className="vf__video" muted playsInline hidden={!webcam} />
        )}

        <span className="vf__corner vf__corner--tl" />
        <span className="vf__corner vf__corner--tr" />
        <span className="vf__corner vf__corner--bl" />
        <span className="vf__corner vf__corner--br" />

        {scanning && <div className="vf__scan" aria-hidden />}

        {live
          ? live.detections.map((d, i) => {
              if (!d.box) return null;
              const isBest = live.best !== null && d.label === live.best.label && d.kind === live.best.kind;
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
          {live
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
    </section>
  );
}
