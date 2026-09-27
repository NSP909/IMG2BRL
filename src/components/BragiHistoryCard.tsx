import type { AslWord } from '../lib/bridge';

interface Props {
  words: AslWord[];
  decoding: boolean;
  onReset(): void;
}

const SOURCE: Record<AslWord['source'], string> = { jev: 'Jev', local: 'dictionary', raw: 'as signed' };

/** The sentence so far, big enough to read at a glance, and how each word got there. */
export function BragiHistoryCard({ words, decoding, onReset }: Props) {
  const recent = words.slice(-6).reverse();
  return (
    <section className="card" aria-label="Spoken this session">
      <div className="card__head">
        <span className="eyebrow">Spoken this session</span>
        <button type="button" className="btn" onClick={onReset} disabled={!words.length}>Clear</button>
      </div>
      {words.length === 0 && !decoding ? (
        <p className="muted">Nothing spoken yet. Spell a word, then make the space sign.</p>
      ) : (
        <>
          <p className="bragi__transcript">
            {words.map((w) => w.word).join(' ')}
            {decoding && <span className="bragi__pending"> …</span>}
          </p>
          <ul className="bragi__words">
            {recent.map((w, i) => (
              <li key={`${w.raw}-${words.length - i}`}>
                <span className="mono muted">{w.raw}</span>
                <span className="muted">→</span>
                <b>{w.word}</b>
                <span className="small muted">
                  {SOURCE[w.source]}{w.source === 'jev' ? ` ${Math.round(w.confidence * 100)}%` : ''} · {w.ms} ms
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
