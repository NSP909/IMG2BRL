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
  { value: 'vlm', label: 'Claude' },
  { value: 'tesseract', label: 'Tesseract' },
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
  const read = s?.read;
  const gate = s?.text;
  const best = s?.best ?? null;
  const cloud = read?.provider !== null && read?.model !== null;

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
          {s && <p className="small muted">Only these are reported: {s.classes.join(', ')}.</p>}
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

        <section className="card" aria-label="Text reading">
          <div className="card__head">
            <span className="eyebrow">Text · gate then read</span>
            <div className="tabs" role="radiogroup" aria-label="Reader">
              {ENGINES.map((e) => (
                <button
                  key={e.value}
                  type="button"
                  className={`tab ${s?.engine === e.value ? 'is-active' : ''}`}
                  onClick={() => bridge.setEngine(e.value)}
                  disabled={!bridge.online || (e.value === 'vlm' && !cloud)}
                >
                  {e.value === 'vlm' ? providerName(read?.provider) : e.label}
                </button>
              ))}
            </div>
          </div>

          <div className="lab__engine">
            <div className="field__row">
              <span className="muted">Text present?</span>
              <span className="mono small">
                {gate ? (gate.present ? `yes · ${gate.cells} cells · ${Math.round(gate.score * 100)}%` : `no · ${Math.round(gate.score * 100)}%`) : '—'}
                {s ? ` · EAST ${s.stats.gate_ms} ms` : ''}
              </span>
            </div>
            <div className="field__row">
              <span className="muted">{read?.engine === 'tesseract' ? 'Tesseract' : providerName(read?.provider)} read</span>
              <span className="mono small">
                {read
                  ? `${read.model ?? 'offline'} · ${read.passes} reads · ${read.latency_ms} ms${read.gap_left_ms > 0 ? ` · next in ${(read.gap_left_ms / 1000).toFixed(1)} s` : ' · ready'}`
                  : '—'}
              </span>
            </div>
            <div className="detect__row">
              {read?.text ? (
                <>
                  <span className="chip chip--text">text</span>
                  <span className="detect__label">{read.text}</span>
                  <span className="mono small muted">{Math.round(read.confidence * 100)}%</span>
                  <button type="button" className="btn lab__send" onClick={() => onSend(read.text, 'text')}>Send</button>
                </>
              ) : (
                <span className="muted small">{read?.error ?? (gate?.present ? 'text in view, waiting for the read…' : 'no text read yet')}</span>
              )}
            </div>
            <div className="field__row">
              <button type="button" className="btn" onClick={bridge.analyze} disabled={!bridge.online}>Read now</button>
              {read?.raw && <span className="mono small muted lab__raw" title={read.raw}>{read.raw.slice(0, 90)}</span>}
            </div>
            <p className="small muted">
              Flow: EAST says whether text is in view (every pass, local). When it is, and at least {read ? (read.read_gap_ms / 1000).toFixed(0) : '5'} s passed since the last read,
              one request goes to {providerName(read?.provider)} to transcribe it. Text always beats objects.
            </p>
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
