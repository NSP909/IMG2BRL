import { CameraIcon, LockIcon, MicIcon, StopIcon } from './Icons';
import type { Recognizer } from '../lib/bridge';

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
  /** Pin lock: enforced on the Pi, nothing moves until released. */
  pinsLocked: boolean;
  onLockPins(locked: boolean): void;
  recognizer: Recognizer;
  /** Active-input lock: the bridge stops camera detection or microphone listening. */
  inputPaused: boolean;
  onPauseInput(paused: boolean): void;
}

const STATUS_TEXT: Record<Status, string> = {
  idle: 'Waiting for input',
  scanning: 'Scanning frame',
  streaming: 'Sending to pins',
  paused: 'Paused',
  complete: 'Message complete',
};

export function TopBar({ status, index, total, live, host, view, onView, onStop, pinsLocked, onLockPins, recognizer, inputPaused, onPauseInput }: Props) {
  const showCount = status === 'streaming' || status === 'paused';
  const sound = recognizer === 'sound';
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand__mark" aria-hidden>
          <i className="on" /><i className="on" /><i /><i className="on" /><i /><i />
        </span>
        <div>
          <div className="brand__name">Braille Pin Visualizer</div>
          <div className="brand__sub">Camera or microphone → recognition → one tactile cell at a time</div>
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
          <button type="button" className={`tab ${view === 'lab' ? 'is-active' : ''}`} onClick={() => onView('lab')}>{sound ? 'Sound lab' : 'Camera lab'}</button>
        </nav>
        <span className="pill" title={pinsLocked ? 'Pins are locked on the Pi' : live ? `Solenoid cell on the Pi at ${host}` : 'The Pi is not driving pins right now'}>
          <span className={`pill__dot ${pinsLocked ? 'pill__dot--locked' : live ? 'pill__dot--live' : 'pill__dot--sim'}`} />
          {pinsLocked ? 'Pins locked' : live ? 'Live hardware' : 'Simulated hardware'}
        </span>
        <div className="controls" role="group" aria-label="Safety controls">
          <button
            type="button"
            className={`btn btn--latch ${pinsLocked ? 'is-on' : ''}`}
            onClick={() => onLockPins(!pinsLocked)}
            aria-pressed={pinsLocked}
            title={pinsLocked ? 'Pins are locked on the Pi. Click to unlock.' : 'Lock the pins: the Pi refuses every actuation until unlocked.'}
          >
            <LockIcon />
            {pinsLocked ? 'Pins locked' : 'Lock pins'}
          </button>
          <button
            type="button"
            className={`btn btn--latch btn--latch-amber ${inputPaused ? 'is-on' : ''}`}
            onClick={() => onPauseInput(!inputPaused)}
            aria-pressed={inputPaused}
            title={sound
              ? inputPaused ? 'Microphone listening is paused. Click to resume.' : 'Pause listening and discard buffered speech.'
              : inputPaused ? 'Camera is paused: no detection or queueing. Click to resume.' : 'Pause the camera: stop detecting, calling the vision model and queueing.'}
          >
            {sound ? <MicIcon /> : <CameraIcon />}
            {sound ? (inputPaused ? 'Mic paused' : 'Pause mic') : (inputPaused ? 'Camera paused' : 'Pause camera')}
          </button>
          <button type="button" className="btn btn--stop" onClick={onStop} title="Stop playback now, drop all pins, clear the queue">
            <StopIcon />
            Stop
          </button>
        </div>
      </div>
    </header>
  );
}
