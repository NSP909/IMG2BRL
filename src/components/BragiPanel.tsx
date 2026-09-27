import { useEffect, useRef, useState } from 'react';
import type { AslClassifier, AslStatus, AslWordAction } from '../lib/bridge';

interface Props {
  asl: AslStatus;
  onWord(action: AslWordAction): void;
  /** Switch the letter model; resolves false if it couldn't load (the old one stays). */
  onClassifier(classifier: AslClassifier): Promise<boolean>;
}

const MODELS: { value: AslClassifier; label: string; title: string }[] = [
  { value: 'cnn', label: 'CNN', title: 'Skeleton CNN: all 26 letters, J and Z from motion' },
  { value: 'knn', label: 'Personal', title: 'KNN over the samples recorded on this camera' },
  { value: 'geometric', label: 'Rules', title: 'Finger-angle rules, 19 letters, no training data' },
];

type Status = 'loading' | 'error' | 'idle' | 'reading' | 'added' | 'decoding';

const STATUS_TEXT: Record<Status, string> = {
  loading: 'loading model…',
  error: 'error',
  idle: 'no hand in view',
  reading: 'reading…',
  added: 'got it',
  decoding: 'finding the word…',
};

const STATUS_DOT: Record<Status, string> = {
  loading: 'loading',
  error: 'error',
  idle: '',
  reading: 'listening',
  added: 'speech',
  decoding: 'transcribing',
};

/**
 * What's happening right now: the sign under the camera, and the word being
 * spelled. Letters no longer get read out one at a time; the space sign sends
 * the whole word to be decoded and spoken (see BragiHistoryCard for those).
 */
export function BragiPanel({ asl, onWord, onClassifier }: Props) {
  const [switching, setSwitching] = useState(false);
  const pickModel = async (c: AslClassifier) => {
    setSwitching(true);
    await onClassifier(c);
    setSwitching(false);
  };
  const holding = asl.label ? Math.min(asl.stable_count, asl.stable_needed) : 0;
  const pct = asl.label ? (holding / asl.stable_needed) * 100 : 0;
  const letters = asl.word_letters;

  // Flash "got it" for a beat when a letter joins the word.
  const [justAdded, setJustAdded] = useState(false);
  const prevCount = useRef(letters.length);
  useEffect(() => {
    const grew = letters.length > prevCount.current;
    prevCount.current = letters.length;
    if (!grew) return;
    setJustAdded(true);
    const t = window.setTimeout(() => setJustAdded(false), 700);
    return () => window.clearTimeout(t);
  }, [letters.length]);

  const status: Status = !asl.available
    ? asl.error ? 'error' : 'loading'
    : asl.decoding ? 'decoding' : justAdded ? 'added' : asl.label ? 'reading' : 'idle';
  const isSpace = asl.label === 'SPACE';

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
        <div className="tabs" role="radiogroup" aria-label="Letter model">
          {MODELS.map((m) => (
            <button
              key={m.value}
              type="button"
              title={m.title}
              className={`tab ${asl.classifier === m.value ? 'is-active' : ''}`}
              aria-pressed={asl.classifier === m.value}
              disabled={switching}
              onClick={() => asl.classifier !== m.value && void pickModel(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {asl.error && asl.available && <p className="sound__error small">{asl.error}</p>}

      {!asl.available ? (
        <p className="muted">{asl.error || 'Loading the hand model…'}</p>
      ) : (
        <>
          <div className="bragi__analysis">
            <div className="bragi__reading">
              <span className="eyebrow">Current prediction</span>
              <div className="bragi__hero">
                {asl.label ? (
                  <span key={asl.label} className={`bragi__char ${isSpace ? 'bragi__char--space' : ''}`}>{isSpace ? 'space' : asl.label}</span>
                ) : (
                  <span className="bragi__char bragi__char--idle">Show one letter</span>
                )}
              </div>

              <div className="bragi__predictions" aria-label="Top model predictions">
                {asl.predictions.length > 0 ? (
                  asl.predictions.map((prediction, index) => (
                    <div className="bragi__prediction" key={`${prediction.label}-${index}`}>
                      <strong>{prediction.label === 'SPACE' ? '␣' : prediction.label}</strong>
                      <span className="bragi__score-track">
                        <i
                          className={index === 0 && (asl.classifier !== 'cnn' || prediction.confidence >= 0.75) ? 'is-sure' : ''}
                          style={{ width: `${Math.round(prediction.confidence * 100)}%` }}
                        />
                      </span>
                      <span className="mono">{Math.round(prediction.confidence * 100)}%</span>
                    </div>
                  ))
                ) : (
                  <span className="small muted">Top predictions appear here</span>
                )}
              </div>
            </div>
          </div>

          <div className="conf">
            <div className="conf__row">
              <span className="muted">
                {!asl.label
                  ? 'Fingerspell one letter at a time'
                  : asl.moving
                    ? 'Moving… hold still to add it'
                    : asl.classifier === 'cnn' && asl.confidence < 0.75
                      ? 'Not sure yet'
                      : holding > 0
                        ? `Adding ${asl.label === 'SPACE' ? 'space' : asl.label}…`
                        : 'Hold it'}
              </span>
              {asl.label && (
                <span className="mono">{asl.classifier === 'cnn' ? `${Math.round(asl.confidence * 100)}% sure` : `${Math.round(pct)}%`}</span>
              )}
            </div>
            <div className="conf__bar">
              <div className="conf__fill" style={{ width: `${pct}%` }} />
            </div>
          </div>

          <div className="bragi__spell" aria-label="Word being spelled">
            <div className="bragi__letters">
              {letters.length ? (
                letters.map((l, i) => <span key={i} className="bragi__tile">{l}</span>)
              ) : (
                <span className="small muted">Letters build up here. Make the space sign to say the word.</span>
              )}
              {letters.length > 0 && <span className="bragi__caret" aria-hidden />}
            </div>
            <div className="bragi__actions">
              <button type="button" className="btn" onClick={() => onWord('backspace')} disabled={!letters.length} title="Remove the last letter">⌫</button>
              <button type="button" className="btn btn--primary" onClick={() => onWord('finish')} disabled={!letters.length || asl.decoding}>Say it</button>
            </div>
          </div>

          <p className="small muted">
            Each letter clicks softly as it lands. The space sign sends the whole word to {asl.jev ? 'Jev' : 'the dictionary'}, which works out what you meant from the letters and the sentence so far, and it's spoken aloud.
          </p>
        </>
      )}
    </section>
  );
}
