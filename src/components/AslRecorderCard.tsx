import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bridge } from '../hooks/useBridge';

// The 24 static letters, then SPACE: the sign that ends a word (the open "5"
// hand by default, but it's whatever gets recorded here).
const LETTERS = [...'ABCDEFGHIKLMNOPQRSTUVWXY'.split(''), 'SPACE'];
const TARGET = 60;
const COUNTDOWN = 3;
const labelOf = (l: string) => (l === 'SPACE' ? 'Space' : l);

interface Props {
  bridge: Bridge;
}

/** Records Bragi's KNN samples through whichever camera is live, into that
 * camera's own sample set, so they match what the classifier will see. */
export function AslRecorderCard({ bridge }: Props) {
  const s = bridge.state;
  const asl = s?.asl;
  const aslMode = s?.camera_mode === 'asl';
  const onPi = s?.camera_source !== 'webcam';
  const counts = (onPi ? asl?.pi_counts : asl?.laptop_counts) ?? {};
  const recorded = LETTERS.filter((l) => (counts[l] ?? 0) >= TARGET).length;

  const [countdown, setCountdown] = useState<{ letter: string; n: number } | null>(null);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const { aslRecord, aslRecordCancel } = bridge;

  useEffect(() => {
    if (!countdown) return;
    if (countdown.n === 0) {
      void aslRecord(countdown.letter, TARGET);
      setCountdown(null);
      return;
    }
    const t = window.setTimeout(() => setCountdown((c) => (c ? { ...c, n: c.n - 1 } : c)), 1000);
    return () => window.clearTimeout(t);
  }, [countdown, aslRecord]);

  const start = useCallback((letter: string) => setCountdown({ letter, n: COUNTDOWN }), []);

  // When a take finishes (not a cancel: the count for that letter reached the
  // target), move on to the next letter that still needs recording.
  const prevRecording = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevRecording.current;
    prevRecording.current = asl?.recording ?? null;
    if (!prev || asl?.recording || !autoAdvance) return;
    if ((counts[prev] ?? 0) < TARGET) return;
    const next = LETTERS.slice(LETTERS.indexOf(prev) + 1).find((l) => (counts[l] ?? 0) < TARGET);
    if (next) start(next);
  }, [asl?.recording, counts, autoAdvance, start]);

  const cancel = () => {
    setCountdown(null);
    if (asl?.recording) aslRecordCancel();
  };

  const busy = Boolean(countdown || asl?.recording);
  const pct = asl?.recording && asl.record_target ? (asl.record_progress / asl.record_target) * 100 : 0;

  return (
    <section className="card" aria-label="Record Bragi samples">
      <div className="card__head">
        <span className="eyebrow">Bragi · record samples</span>
        <span className="small muted">
          {recorded}/{LETTERS.length} signs · {onPi ? 'Pi' : 'laptop'} camera set{s?.camera_feed === 'none' ? ' · no camera feed' : ''}
        </span>
      </div>

      <div className="rec__status">
        {countdown ? (
          <>
            <span className="rec__big">{countdown.n}</span>
            <span className="muted">Get ready to hold <b>{labelOf(countdown.letter)}</b></span>
          </>
        ) : asl?.recording ? (
          <div className="rec__progress">
            <div className="conf__row">
              <span>Recording <b>{labelOf(asl.recording)}</b></span>
              <span className="mono">{asl.record_progress}/{asl.record_target}</span>
            </div>
            <div className="conf__bar"><div className="conf__fill" style={{ width: `${pct}%` }} /></div>
            <span className={`small ${asl.hand_visible ? 'muted' : 'rec__warn'}`}>
              {asl.hand_visible ? 'Hold the shape, and shift it a little so the samples vary.' : 'No hand in view, paused until one appears.'}
            </span>
          </div>
        ) : (
          <span className="muted small">
            {aslMode
              ? `Pick a sign. ${TARGET} samples each, about 10 seconds, with a ${COUNTDOWN}-second countdown first. Space is the sign that ends a word.`
              : 'Switch to Bragi in the top bar to record.'}
          </span>
        )}
      </div>

      <div className="rec__grid">
        {LETTERS.map((l) => {
          const n = counts[l] ?? 0;
          const active = asl?.recording === l || countdown?.letter === l;
          return (
            <button
              key={l}
              type="button"
              className={`rec__key ${l === 'SPACE' ? 'rec__key--space' : ''} ${n >= TARGET ? 'is-done' : ''} ${active ? 'is-active' : ''}`}
              onClick={() => start(l)}
              disabled={!aslMode || !bridge.online || busy}
              title={n ? `${n} samples recorded, click to retake` : 'Not recorded yet'}
            >
              <span className="rec__letter">{labelOf(l)}</span>
              <span className="rec__count">{n || '·'}</span>
            </button>
          );
        })}
      </div>

      <div className="field__row">
        <span className="small muted">
          {asl?.cnn_training
            ? 'Teaching the CNN your Space sign… (about 40 s)'
            : asl?.cnn_train_result ?? 'The CNN learns Space from your recorded Space samples (both cameras).'}
        </span>
        <button
          type="button"
          className="btn"
          onClick={bridge.aslTrainSpace}
          disabled={!bridge.online || busy || asl?.cnn_training || !((asl?.pi_counts.SPACE ?? 0) + (asl?.laptop_counts.SPACE ?? 0))}
        >
          {asl?.cnn_training ? 'Teaching…' : 'Teach the CNN this Space'}
        </button>
      </div>

      <div className="queue__bar">
        <label className="switch" htmlFor="rec-auto">
          <input id="rec-auto" type="checkbox" checked={autoAdvance} onChange={(e) => setAutoAdvance(e.target.checked)} />
          <span className="switch__track" aria-hidden><span className="switch__knob" /></span>
          <span>Go to the next sign automatically</span>
        </label>
        {busy ? (
          <button type="button" className="btn" onClick={cancel}>Cancel</button>
        ) : (
          <button
            type="button"
            className="btn"
            onClick={() => window.confirm('Delete every sample recorded on the Pi camera?') && bridge.aslRecordClear()}
            disabled={!onPi || !Object.keys(counts).length}
          >
            Clear recorded
          </button>
        )}
      </div>
    </section>
  );
}
