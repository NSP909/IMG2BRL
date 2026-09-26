import type { Detection } from '../lib/detections';

interface Props {
  detection: Detection | null;
  cellCount: number;
}

export function DetectionCard({ detection, cellCount }: Props) {
  return (
    <section className="card" aria-label="Detection result">
      <div className="card__head">
        <span className="eyebrow">Detected</span>
        {detection && (
          <span className="small muted mono">
            {detection.source === 'manual' ? 'typed' : 'camera'} · {formatTime(detection.at)}
          </span>
        )}
      </div>

      {detection ? (
        <>
          <div className="detect__row">
            <span className={`chip chip--${detection.kind}`}>{detection.kind}</span>
            <span className="detect__label">{detection.label}</span>
          </div>
          <div className="detect__meta">
            <div className="conf">
              <div className="conf__row">
                <span className="muted">Confidence</span>
                <span className="mono">{Math.round(detection.confidence * 100)}%</span>
              </div>
              <div className="conf__bar">
                <div className="conf__fill" style={{ width: `${detection.confidence * 100}%` }} />
              </div>
            </div>
            <div className="conf__row">
              <span className="muted">Braille cells</span>
              <span className="mono">{cellCount}</span>
            </div>
          </div>
        </>
      ) : (
        <p className="muted">Nothing detected yet. Capture a frame or type some text.</p>
      )}
    </section>
  );
}

function formatTime(t: number) {
  return new Date(t).toLocaleTimeString([], { hour12: false });
}
