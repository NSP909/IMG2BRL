import { useEffect, useRef, useState } from 'react';
import type { AslClassifier, AslStatus } from '../lib/bridge';

interface Props {
  asl: AslStatus;
  onClassifier(classifier: AslClassifier): void;
  classifierBusy?: boolean;
}

const CLASSIFIERS: { value: AslClassifier; label: string }[] = [
  { value: 'cnn', label: 'Small CNN' },
  { value: 'knn', label: 'Personal KNN' },
  { value: 'geometric', label: 'Rules' },
];

type Status = 'loading' | 'error' | 'idle' | 'reading' | 'spoken';

const STATUS_TEXT: Record<Status, string> = {
  loading: 'loading model…',
  error: 'error',
  idle: 'no hand in view',
  reading: 'reading…',
  spoken: 'spoken',
};

const STATUS_DOT: Record<Status, string> = {
  loading: 'loading',
  error: 'error',
  idle: '',
  reading: 'listening',
  spoken: 'speech',
};

/**
 * Bragi has nothing to do with braille cells, pins, or the queue -- it reads
 * the wearer's own signing and speaks it aloud for a bystander. Reusing the
 * Rune finger-visualizer UI here would show a permanently-idle braille cell
 * next to the one thing that actually matters: the letter it just read. This
 * is the "what's happening right now" card; the running transcript lives in
 * BragiHistoryCard alongside it.
 */
export function BragiPanel({ asl, onClassifier, classifierBusy = false }: Props) {
  const holding = asl.label ? Math.min(asl.stable_count, asl.stable_needed) : 0;
  const pct = asl.label ? (holding / asl.stable_needed) * 100 : 0;

  // Flash "spoken" for a beat when a letter actually lands, so the moment it
  // spoke is visible instead of only inferable from the history list growing.
  // Guarded by loadedRef so the *first* real state we get from the bridge
  // (which may already have a stale last_spoken from before this page ever
  // loaded) primes silently instead of flashing for something old.
  const [justSpoken, setJustSpoken] = useState(false);
  const lastSpokenRef = useRef<string | null>(null);
  const loadedRef = useRef(false);
  useEffect(() => {
    if (!asl.available) return;
    if (!loadedRef.current) {
      loadedRef.current = true;
      lastSpokenRef.current = asl.last_spoken;
      return;
    }
    if (asl.last_spoken && asl.last_spoken !== lastSpokenRef.current) {
      lastSpokenRef.current = asl.last_spoken;
      setJustSpoken(true);
      const t = window.setTimeout(() => setJustSpoken(false), 900);
      return () => window.clearTimeout(t);
    }
    lastSpokenRef.current = asl.last_spoken;
  }, [asl.available, asl.last_spoken]);

  const status: Status = asl.error ? 'error' : !asl.available ? 'loading' : justSpoken ? 'spoken' : asl.label ? 'reading' : 'idle';

  return (
    <section className="card" aria-label="Bragi: ASL to speech">
      <div className="card__head">
        <span className="eyebrow">Bragi · reading your sign</span>
        <span className={`sound__state ${STATUS_DOT[status] ? `sound__state--${STATUS_DOT[status]}` : ''}`} style={{ textTransform: 'none' }}>
          <span className="sound__dot" />
          {STATUS_TEXT[status]}
        </span>
      </div>

      <div className="field__row">
        <span className="small muted">Letter model</span>
        <div className="tabs" role="radiogroup" aria-label="ASL letter model">
          {CLASSIFIERS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`tab ${asl.classifier === value ? 'is-active' : ''}`}
              onClick={() => onClassifier(value)}
              disabled={classifierBusy || asl.classifier === value}
              aria-pressed={asl.classifier === value}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {asl.error && <p className="sound__error small">{asl.error}</p>}

      {!asl.available ? (
        !asl.error && <p className="muted">Loading the hand model…</p>
      ) : (
        <>
          <div className="bragi__analysis">
            <div className="bragi__model-view">
              <span className="eyebrow">AI view · skeleton</span>
              <div className="bragi__skeleton">
                {asl.skeleton_image ? (
                  <img src={asl.skeleton_image} alt="Normalized hand skeleton seen by the ASL model" />
                ) : (
                  <span>{asl.classifier === 'cnn' ? 'Waiting for a hand' : 'Available with Small CNN'}</span>
                )}
              </div>
            </div>

            <div className="bragi__reading">
              <span className="eyebrow">Current prediction</span>
              <div className="bragi__hero">
                {asl.label ? (
                  <span key={asl.label} className="bragi__char">{asl.label}</span>
                ) : (
                  <span className="bragi__char bragi__char--idle">Show one letter</span>
                )}
              </div>

              <div className="bragi__predictions" aria-label="Top model predictions">
                {asl.predictions.length > 0 ? asl.predictions.map((prediction, index) => (
                  <div className="bragi__prediction" key={`${prediction.label}-${index}`}>
                    <strong>{prediction.label}</strong>
                    <span className="bragi__score-track">
                      <i style={{ width: `${Math.round(prediction.confidence * 100)}%` }} />
                    </span>
                    <span className="mono">{Math.round(prediction.confidence * 100)}%</span>
                  </div>
                )) : (
                  <span className="small muted">
                    {asl.classifier === 'cnn' ? 'Top predictions appear here' : 'Top predictions are available with Small CNN'}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="conf">
            <div className="conf__row">
              <span className="muted">
                {asl.moving ? 'Tracking movement…' : asl.label ? `Holding ${holding}/${asl.stable_needed}` : 'Fingerspell one letter at a time'}
              </span>
              {asl.label && <span className="mono">{asl.classifier === 'cnn' ? `${Math.round(asl.confidence * 100)}% confidence` : `${Math.round(pct)}% held`}</span>}
            </div>
            <div className="conf__bar">
              <div className="conf__fill" style={{ width: `${pct}%` }} />
            </div>
          </div>

          <p className="small muted">
            Spoken locally (macOS <code>say</code>) for someone nearby who doesn't know ASL. Never sent to the pins.
          </p>
        </>
      )}
    </section>
  );
}
