import { useEffect, useRef } from 'react';
import type { BrailleCell } from '../lib/braille';
import { BrailleCellView } from './BrailleCellView';

interface Props {
  text: string;
  cells: BrailleCell[];
  index: number;
  onSelect(i: number): void;
}

/** Every cell of the message in order. The current one is raised; past ones fade. */
export function SequenceStrip({ text, cells, index, onSelect }: Props) {
  const track = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = track.current;
    const cur = el?.querySelector<HTMLElement>('.is-current');
    if (!el || !cur) return;
    const left = cur.offsetLeft - el.clientWidth / 2 + cur.clientWidth / 2;
    el.scrollTo({ left, behavior: 'smooth' });
  }, [index]);

  return (
    <section className="card seq" aria-label="Cell sequence">
      <div className="card__head">
        <span className="eyebrow">Sequence</span>
        <span className="small muted">
          <span className="mono">{cells.length}</span> cells for “{text}”
        </span>
      </div>

      {cells.length === 0 ? (
        <p className="muted small">Nothing queued.</p>
      ) : (
        <div className="seq__track" ref={track}>
          {cells.map((cell, i) => {
            const state = i === index ? 'is-current' : i < index ? 'is-done' : '';
            return (
              <button
                key={i}
                type="button"
                className={`seqcell seqcell--${cell.kind} ${state}`}
                onClick={() => onSelect(i)}
                aria-current={i === index ? 'step' : undefined}
                aria-label={`Cell ${i + 1}: ${cell.description}`}
                title={cell.description}
              >
                <BrailleCellView dots={cell.dots} size="sm" label={cell.description} />
                <span className="seqcell__label">{shortLabel(cell)}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function shortLabel(cell: BrailleCell) {
  if (cell.kind === 'space') return '␣';
  if (cell.kind === 'indicator') return cell.label === 'Num' ? '#' : '⇧';
  return cell.label;
}
