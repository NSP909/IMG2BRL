interface Props {
  /** Letters spoken so far this session, oldest first. Reset with onClear. */
  history: string[];
  onClear(): void;
}

/** The running transcript, big enough for a bystander to read at a glance,
 * plus the letter-by-letter chips underneath for a sense of pace. */
export function BragiHistoryCard({ history, onClear }: Props) {
  return (
    <section className="card" aria-label="Spoken this session">
      <div className="card__head">
        <span className="eyebrow">Spoken this session</span>
        <button type="button" className="btn" onClick={onClear} disabled={history.length === 0}>
          Clear
        </button>
      </div>
      {history.length === 0 ? (
        <p className="muted">Nothing spoken yet. Hold a letter shape steady.</p>
      ) : (
        <>
          <p className="bragi__transcript">{history.join('')}</p>
          <div className="bragi__history">
            {history.map((letter, i) => (
              <span key={i} className="chip chip--speech">{letter}</span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
