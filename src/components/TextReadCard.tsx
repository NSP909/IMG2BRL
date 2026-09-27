import type { Bridge } from '../hooks/useBridge';
import type { DetectionKind } from '../lib/detections';

interface Props {
  bridge: Bridge;
  /** Play this on the finger right away, bypassing the queue. */
  onSend(label: string, kind: DetectionKind): void;
}

function providerName(p: 'anthropic' | 'openai' | null | undefined) {
  return p === 'openai' ? 'OpenAI' : 'Claude';
}

/**
 * Live text read from the world (EAST gate -> Claude/Tesseract), independent
 * of the queue -- lets a demo send what's currently in view without waiting
 * for auto-queue, or switching to Dev to see it.
 */
export function TextReadCard({ bridge, onSend }: Props) {
  const read = bridge.state?.read;
  const gate = bridge.state?.text;

  return (
    <section className="card" aria-label="Text read from the world">
      <div className="card__head">
        <span className="eyebrow">Text</span>
        <span className="small muted">{read?.text ? providerName(read.provider) : ''}</span>
      </div>
      {read?.text ? (
        <div className="detect__row">
          <span className="chip chip--text">text</span>
          <span className="detect__label">{read.text}</span>
          <span className="mono small muted">{Math.round(read.confidence * 100)}%</span>
          <button type="button" className="btn btn--primary" onClick={() => onSend(read.text, 'text')}>Send</button>
        </div>
      ) : (
        <p className="muted small">{read?.error ?? (gate?.present ? 'Text in view, reading…' : 'No text read yet.')}</p>
      )}
    </section>
  );
}
