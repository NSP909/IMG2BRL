import { StopIcon } from './Icons';

export type Status = 'idle' | 'scanning' | 'streaming' | 'paused' | 'complete';
export type View = 'main' | 'lab';

interface Props {
  status: Status;
  index: number;
  total: number;
  /** True when cells are being driven onto the real solenoids. */
  live: boolean;
  host: string;
  view: View;
  onView(view: View): void;
  /** Stop playback, drop the pins, clear the queue. */
  onStop(): void;
}

const STATUS_TEXT: Record<Status, string> = {
  idle: 'Waiting for input',
  scanning: 'Scanning frame',
  streaming: 'Sending to pins',
  paused: 'Paused',
  complete: 'Message complete',
};

export function TopBar({ status, index, total, live, host, view, onView, onStop }: Props) {
  const showCount = status === 'streaming' || status === 'paused';
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand__mark" aria-hidden>
          <i className="on" /><i className="on" /><i /><i className="on" /><i /><i />
        </span>
        <div>
          <div className="brand__name">Braille Pin Visualizer</div>
          <div className="brand__sub">Camera → detection → one tactile cell at a time</div>
        </div>
      </div>

      <div className="status" aria-live="polite">
        <span className={`status__dot status__dot--${status}`} />
        <span>{STATUS_TEXT[status]}</span>
        {showCount && (
          <span className="mono muted">
            cell {Math.min(index + 1, total)} / {total}
          </span>
        )}
      </div>

      <div className="topbar__right">
        <nav className="tabs" aria-label="Screens">
          <button type="button" className={`tab ${view === 'main' ? 'is-active' : ''}`} onClick={() => onView('main')}>Finger</button>
          <button type="button" className={`tab ${view === 'lab' ? 'is-active' : ''}`} onClick={() => onView('lab')}>Camera lab</button>
        </nav>
        <span className="pill" title={live ? `Solenoid cell on the Pi at ${host}` : 'The Pi is not driving pins right now'}>
          <span className={`pill__dot ${live ? 'pill__dot--live' : 'pill__dot--sim'}`} />
          {live ? 'Live hardware' : 'Simulated hardware'}
        </span>
        <button type="button" className="btn btn--stop" onClick={onStop} title="Stop playback, drop all pins, clear the queue">
          <StopIcon />
          Stop
        </button>
      </div>
    </header>
  );
}
