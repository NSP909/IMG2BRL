import { useEffect, useRef, useState } from 'react';
import type { AslStatus } from '../lib/bridge';

interface Props {
  asl: AslStatus;
}

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
export function BragiPanel({ asl }: Props) {
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

  const status: Status = !asl.available ? (asl.error ? 'error' : 'loading') : justSpoken ? 'spoken' : asl.label ? 'reading' : 'idle';

  return (
    <section className="card" aria-label="Bragi: ASL to speech">
      <div className="card__head">
        <span className="eyebrow">Bragi · reading your sign</span>
        <span className={`sound__state ${STATUS_DOT[status] ? `sound__state--${STATUS_DOT[status]}` : ''}`} style={{ textTransform: 'none' }}>
          <span className="sound__dot" />
          {STATUS_TEXT[status]}
        </span>
      </div>

      {!asl.available ? (
        <p className="muted">{asl.error || 'Loading the hand model…'}</p>
      ) : (
        <>
          <div className="bragi__hero">
            {asl.label ? (
              <span key={asl.label} className="bragi__char">{asl.label}</span>
            ) : (
              <span className="bragi__char bragi__char--idle">Show a letter to the camera</span>
            )}
          </div>

          <div className="conf">
            <div className="conf__row">
              <span className="muted">{asl.label ? `Holding ${holding}/${asl.stable_needed}` : 'Fingerspell one letter at a time'}</span>
              {asl.label && <span className="mono">{Math.round(pct)}%</span>}
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
