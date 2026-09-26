import { describeDots, dotsToMask, dotsToUnicode, maskToBinary, maskToHex } from '../lib/braille';
import type { CellStream } from '../hooks/useCellStream';
import { BrailleCellView } from './BrailleCellView';
import { NextIcon, PauseIcon, PlayIcon, PrevIcon, RestartIcon } from './Icons';

interface Props {
  stream: CellStream;
}

/** The current cell, at finger scale, with what the controller needs to know about it. */
export function CellHero({ stream }: Props) {
  const { current, index, total, playing, finished, holdMs } = stream;
  const dots = current?.dots ?? [];
  const mask = dotsToMask(dots);
  const isIdle = index < 0 || total === 0;

  return (
    <section className="card hero" aria-label="Current braille cell">
      <div className="hero__plate">
        <div className="gutter" aria-hidden>
          <span>1</span><span>2</span><span>3</span>
        </div>
        <BrailleCellView
          dots={dots}
          size="lg"
          label={current ? `${current.description}, ${describeDots(dots)}` : 'All pins down'}
        />
        <div className="gutter" aria-hidden>
          <span>4</span><span>5</span><span>6</span>
        </div>
      </div>

      <div className="hero__info">
        <div className="card__head">
          <span className="eyebrow">On the finger now</span>
          <span className="mono small muted">
            {isIdle ? '— / —' : `${Math.min(index + 1, total)} / ${total}`}
          </span>
        </div>

        <div className="hero__body">
          <div className="hero__char-wrap">{renderGlyph(current, finished, isIdle)}</div>

          <dl className="meta">
            <div><dt>Kind</dt><dd>{current ? kindName(current.kind) : finished ? 'End of message' : 'Idle'}</dd></div>
            <div><dt>Dots</dt><dd>{dots.length ? dots.join(' · ') : 'none'}</dd></div>
            <div><dt>Unicode</dt><dd><span className="glyph">{dotsToUnicode(dots)}</span> U+{(0x2800 + mask).toString(16).toUpperCase()}</dd></div>
            <div><dt>Pin mask</dt><dd>{maskToBinary(mask)} {maskToHex(mask)}</dd></div>
          </dl>

          <div className="hold" aria-hidden>
            {current && (
              <div
                key={`${index}-${holdMs}-${playing}`}
                className="hold__fill"
                style={{ animationDuration: `${holdMs}ms`, animationPlayState: playing ? 'running' : 'paused' }}
              />
            )}
          </div>
        </div>

        <div className="transport">
          <button type="button" className="btn btn--icon" onClick={stream.restart} disabled={total === 0} aria-label="Restart">
            <RestartIcon />
          </button>
          <button type="button" className="btn btn--icon" onClick={stream.prev} disabled={index <= 0} aria-label="Previous cell">
            <PrevIcon />
          </button>
          <button
            type="button"
            className="btn btn--primary transport__play"
            onClick={stream.toggle}
            disabled={total === 0}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
            {playing ? 'Pause' : finished ? 'Replay' : 'Play'}
          </button>
          <button type="button" className="btn btn--icon" onClick={stream.next} disabled={total === 0 || index >= total} aria-label="Next cell">
            <NextIcon />
          </button>
          <span className="transport__hold mono small muted">hold {holdMs} ms</span>
        </div>
      </div>
    </section>
  );
}

function renderGlyph(current: CellStream['current'], finished: boolean, idle: boolean) {
  if (idle) return <span className="hero__char hero__char--small muted">Waiting</span>;
  if (finished) return <span className="hero__char hero__char--small">Done</span>;
  if (!current) return null;
  switch (current.kind) {
    case 'space':
      return <span className="hero__char hero__char--small muted">space</span>;
    case 'indicator':
      return (
        <span className="hero__indicator">
          <span className="hero__char hero__char--glyph">{dotsToUnicode(current.dots)}</span>
          <span className="hero__char--small">{current.description}</span>
        </span>
      );
    default:
      return <span className="hero__char">{current.label}</span>;
  }
}

function kindName(kind: NonNullable<CellStream['current']>['kind']) {
  switch (kind) {
    case 'letter': return 'Letter';
    case 'digit': return 'Digit';
    case 'punctuation': return 'Punctuation';
    case 'indicator': return 'Indicator';
    case 'space': return 'Space';
  }
}
