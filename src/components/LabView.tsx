import type { Bridge } from '../hooks/useBridge';
import type { BridgeDetection, Engine } from '../lib/bridge';
import type { DetectionKind } from '../lib/detections';
import { Viewfinder, type LiveFeed } from './Viewfinder';

interface Props {
  bridge: Bridge;
  /** Play a label on the finger right away (bypasses the queue). */
  onSend(label: string, kind: DetectionKind): void;
  nowPlaying: string | null;
}

const ENGINES: { value: Engine; label: string }[] = [
  { value: 'tesseract', label: 'Tesseract' },
  { value: 'vlm', label: 'Claude' },
  { value: 'both', label: 'Both' },
  { value: 'none', label: 'Off' },
];

function providerName(p: 'anthropic' | 'openai' | null | undefined) {
  return p === 'openai' ? 'OpenAI' : 'Claude';
}

/** A screen for testing the camera, the object model and text reading on their own. */
export function LabView({ bridge, onSend, nowPlaying }: Props) {
  const s = bridge.state;
  const live: LiveFeed | null =
    bridge.online && s ? { streamUrl: bridge.streamUrl, cameraOk: s.camera_ok, detections: s.detections, best: s.best, stats: s.stats } : null;
  const yolo = (s?.detections ?? []).filter((d) => !d.engine).sort((a, b) => b.confidence - a.confidence);
  const vlm = s?.vlm;
  const best = s?.best ?? null;

  return (
    <main className="layout lab">
      <div className="col" aria-label="Camera">
        <Viewfinder detection={null} scanning={false} onCapture={() => void bridge.capture()} live={live} />

        <section className="card" aria-label="Best detection">
          <div className="card__head">
            <span className="eyebrow">Best right now</span>
            <span className="small muted">{best ? (best.engine ?? 'yolo') : ''}</span>
          </div>
          {best ? (
            <div className="detect__row">
              <span className={`chip chip--${best.kind}`}>{best.kind}</span>
              <span className="detect__label">{best.label}</span>
              <span className="mono small muted">{Math.round(best.confidence * 100)}%</span>
              <button type="button" className="btn btn--primary lab__send" onClick={() => onSend(best.label, best.kind)}>Send to finger</button>
            </div>
          ) : (
            <p className="muted small">{bridge.online ? 'Nothing confident in view.' : 'Bridge offline.'}</p>
          )}
          {nowPlaying && <p className="small muted">Now on the finger: <b>{nowPlaying}</b></p>}
        </section>

        <section className="card" aria-label="Bridge log">
          <div className="card__head"><span className="eyebrow">Bridge log</span></div>
          <pre className="lab__log mono small muted">{(s?.log ?? []).slice().reverse().join('\n') || '—'}</pre>
        </section>
      </div>

      <div className="col" aria-label="Models">
        <section className="card" aria-label="Object model">
          <div className="card__head">
            <span className="eyebrow">Objects · YOLO</span>
            <span className="small muted mono">
              {s ? `${s.stats.model} · ${s.stats.device} · ${s.stats.infer_ms} ms · ${s.stats.fps} fps` : 'offline'}
            </span>
          </div>
          {yolo.length ? (
            <div className="lab__list">
              {yolo.map((d, i) => (
                <DetRow key={`${d.label}-${i}`} d={d} best={best === d} onSend={onSend} />
              ))}
            </div>
          ) : (
            <p className="muted small">No objects above the confidence threshold.</p>
          )}
        </section>

        <section className="card" aria-label="Text and classification">
          <div className="card__head">
            <span className="eyebrow">Text & classification</span>
            <div className="tabs" role="radiogroup" aria-label="Engine">
              {ENGINES.map((e) => (
                <button
                  key={e.value}
                  type="button"
                  className={`tab ${s?.engine === e.value ? 'is-active' : ''}`}
                  onClick={() => bridge.setEngine(e.value)}
                  disabled={!bridge.online || (e.value !== 'tesseract' && e.value !== 'none' && vlm ? !vlm.available : false)}
                >
                  {e.value === 'vlm' ? providerName(vlm?.provider) : e.label}
                </button>
              ))}
            </div>
          </div>

          <div className="lab__engine">
            <div className="field__row">
              <span className="muted">{providerName(vlm?.provider)} vision</span>
              <span className="mono small">
                {vlm?.available ? `${vlm.model ?? '…'} · ${vlm.latency_ms} ms · ${vlm.passes} passes` : vlm?.error ? `unavailable: ${vlm.error}` : 'no key in bridge/.env'}
              </span>
            </div>
            {vlm?.available && (
              <>
                <div className="detect__row">
                  {vlm.label ? (
                    <>
                      <span className={`chip chip--${vlm.kind ?? 'object'}`}>{vlm.kind}</span>
                      <span className="detect__label">{vlm.label}</span>
                      <span className="mono small muted">{Math.round(vlm.confidence * 100)}%</span>
                      <button type="button" className="btn lab__send" onClick={() => onSend(vlm.label, vlm.kind ?? 'text')}>Send</button>
                    </>
                  ) : (
                    <span className="muted small">{vlm.error ?? 'waiting for the first answer…'}</span>
                  )}
                </div>
                {(vlm.text || vlm.object) && (
                  <div className="small muted">text: <span className="mono">{vlm.text || '—'}</span> · object: <span className="mono">{vlm.object || '—'}</span></div>
                )}
                <div className="field__row">
                  <button type="button" className="btn" onClick={bridge.analyze} disabled={!bridge.online}>Analyze now</button>
                  {vlm.raw && <span className="mono small muted lab__raw" title={vlm.raw}>{vlm.raw.slice(0, 90)}</span>}
                </div>
              </>
            )}

            <div className="field__row" style={{ marginTop: 8 }}>
              <span className="muted">Tesseract</span>
              <span className="mono small">{s ? `${s.stats.ocr_ms} ms` : ''}</span>
            </div>
            {s?.tesseract.length ? (
              <div className="lab__list">
                {s.tesseract.map((d, i) => (
                  <DetRow key={`${d.label}-${i}`} d={d} best={best === d} onSend={onSend} />
                ))}
              </div>
            ) : (
              <p className="muted small">No confident text lines from Tesseract.</p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function DetRow({ d, best, onSend }: { d: BridgeDetection; best: boolean; onSend(label: string, kind: DetectionKind): void }) {
  return (
    <div className={`lab__row ${best ? 'is-best' : ''}`}>
      <span className={`chip chip--${d.kind}`}>{d.kind}</span>
      <span className="lab__label">{d.label}</span>
      <span className="conf__bar lab__bar"><span className="conf__fill" style={{ width: `${d.confidence * 100}%` }} /></span>
      <span className="mono small muted">{Math.round(d.confidence * 100)}%</span>
      <button type="button" className="btn lab__send" onClick={() => onSend(d.label, d.kind)}>Send</button>
    </div>
  );
}
