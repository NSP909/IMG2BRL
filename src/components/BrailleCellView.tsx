import { GRID_ORDER, describeDots, type Dot } from '../lib/braille';

interface Props {
  dots: readonly Dot[];
  size?: 'xs' | 'sm' | 'lg';
  /** Accessible name; defaults to the raised dots. */
  label?: string;
}

/** The 3x2 cell, drawn as six pins. Raised pins are dark, lowered pins sit flush. */
export function BrailleCellView({ dots, size = 'sm', label }: Props) {
  const raised = new Set(dots);
  return (
    <div className={`cell cell--${size}`} role="img" aria-label={label ?? `Braille cell, ${describeDots(dots)}`}>
      {GRID_ORDER.map((d) => (
        <span key={d} className={`dot ${raised.has(d) ? 'dot--up' : 'dot--down'}`} data-dot={d} />
      ))}
    </div>
  );
}
