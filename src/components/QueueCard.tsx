import type { Bridge } from '../hooks/useBridge';

interface Props {
  bridge: Bridge;
  /** Label of the item currently playing on the finger, if any. */
  nowPlaying: string | null;
}

/** What the camera has lined up for the finger, and how it gets there. */
export function QueueCard({ bridge, nowPlaying }: Props) {
  const s = bridge.state;
  const queue = s?.queue ?? [];
  const auto = s?.mode === 'auto';

  return (
    <section className="card" aria-label="Detection queue">
      <div className="card__head">
        <span className="eyebrow">Queue</span>
        <span className="small muted">
          {bridge.online ? (auto ? 'auto · new things in view are queued' : 'manual · queue with the capture button') : 'bridge offline'}
        </span>
      </div>

      {bridge.online ? (
        <>
          <div className="queue__list">
            {nowPlaying && (
              <div className="queue__item queue__item--now">
                <span className="queue__idx mono">now</span>
                <span className="queue__label">{nowPlaying}</span>
              </div>
            )}
            {queue.length === 0 && !nowPlaying && <p className="muted small">Nothing queued. Point the camera at an object or some text.</p>}
            {queue.map((q, i) => (
              <div key={q.id} className="queue__item">
                <span className="queue__idx mono">{i + 1}</span>
                <span className={`chip chip--${q.kind}`}>{q.kind}</span>
                <span className="queue__label">{q.label}</span>
                <span className="mono small muted">{Math.round(q.confidence * 100)}%</span>
              </div>
            ))}
          </div>

          <div className="queue__bar">
            <label className="switch" htmlFor="queue-auto">
              <input id="queue-auto" type="checkbox" checked={auto} onChange={(e) => bridge.setMode(e.target.checked ? 'auto' : 'manual')} />
              <span className="switch__track" aria-hidden><span className="switch__knob" /></span>
              <span>Auto-queue detections</span>
            </label>
            <button type="button" className="btn" onClick={bridge.clear} disabled={queue.length === 0}>Clear</button>
          </div>
        </>
      ) : (
        <p className="muted small">
          Start the bridge on this laptop: <span className="mono">python3 bridge/detect_bridge.py</span>
        </p>
      )}
    </section>
  );
}
