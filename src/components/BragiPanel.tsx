import type { AslStatus } from '../lib/bridge';

interface Props {
  asl: AslStatus;
  /** Letters spoken so far this session, oldest first. Reset with onClear. */
  history: string[];
  onClear(): void;
}

/**
 * Bragi has nothing to do with braille cells, pins, or the queue -- it reads
 * the wearer's own signing and speaks it aloud for a bystander. Reusing the
 * Rune finger-visualizer UI here would show a permanently-idle braille cell
 * next to the one thing that actually matters: the letter it just read.
 * Reuses the app's existing card/chip/conf-bar/hero-char patterns (just not
 * the two-column .hero grid, which is built specifically for the plate +
 * info pairing) rather than introducing a second visual language.
 */
export function BragiPanel({ asl, history, onClear }: Props) {
  const holding = asl.label ? Math.min(asl.stable_count, asl.stable_needed) : 0;
  const pct = asl.label ? (holding / asl.stable_needed) * 100 : 0;

  return (
    <section className="card" aria-label="Bragi: ASL to speech">
      <div className="card__head">
        <span className="eyebrow">Bragi · reading your sign</span>
        <span className="small muted mono">{asl.classifier}</span>
      </div>

      {!asl.available ? (
        <p className="muted">{asl.error || 'Loading the hand model…'}</p>
      ) : (
        <>
          <div className="hero__char-wrap">
            <span className="hero__char">{asl.label ?? '–'}</span>
          </div>

          <div className="conf">
            <div className="conf__row">
              <span className="muted">{asl.label ? `Holding ${holding}/${asl.stable_needed}` : 'No hand in view'}</span>
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

      <div className="card__head">
        <span className="eyebrow">Spoken this session</span>
        <button type="button" className="btn" onClick={onClear} disabled={history.length === 0}>
          Clear
        </button>
      </div>
      {history.length === 0 ? (
        <p className="muted">Nothing spoken yet. Hold a letter shape steady.</p>
      ) : (
        <div className="bragi__history">
          {history.map((letter, i) => (
            <span key={i} className="chip chip--speech">{letter}</span>
          ))}
        </div>
      )}
    </section>
  );
}
