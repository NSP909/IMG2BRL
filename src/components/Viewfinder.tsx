import type { Detection } from '../lib/detections';
import { useCamera } from '../hooks/useCamera';
import { CameraIcon, ScanIcon } from './Icons';

interface Props {
  detection: Detection | null;
  scanning: boolean;
  onCapture(): void;
}

export function Viewfinder({ detection, scanning, onCapture }: Props) {
  const cam = useCamera();
  const live = cam.state === 'on';
  const box = detection?.box;

  return (
    <section className="card viewfinder" aria-label="Camera">
      <div className={`vf__frame ${live ? 'vf__frame--live' : ''}`}>
        <video ref={cam.videoRef} className="vf__video" muted playsInline hidden={!live} />

        <span className="vf__corner vf__corner--tl" />
        <span className="vf__corner vf__corner--tr" />
        <span className="vf__corner vf__corner--bl" />
        <span className="vf__corner vf__corner--br" />

        {scanning && <div className="vf__scan" aria-hidden />}

        {!scanning && detection && box && (
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
          {scanning ? 'Looking for objects and text…' : live ? 'Live preview · detection is simulated' : 'Simulated frame · detection is simulated'}
        </div>
      </div>

      <div className="vf__bar">
        <button type="button" className="btn btn--primary" onClick={onCapture} disabled={scanning}>
          <ScanIcon />
          {scanning ? 'Scanning…' : 'Capture frame'}
        </button>
        <div className="vf__bar-right">
          {cam.error && <span className="small muted">{cam.error}</span>}
          <button
            type="button"
            className="btn"
            onClick={live ? cam.stop : cam.start}
            disabled={cam.state === 'starting'}
            aria-pressed={live}
          >
            <CameraIcon />
            {live ? 'Stop camera' : cam.state === 'starting' ? 'Starting…' : 'Use camera'}
          </button>
        </div>
      </div>
    </section>
  );
}
