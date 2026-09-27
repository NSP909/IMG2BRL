import { CameraIcon, LockIcon, MicIcon, StopIcon } from './Icons';
import type { CameraMode, Recognizer } from '../lib/bridge';

export type Status = 'idle' | 'scanning' | 'streaming' | 'paused' | 'complete';
export type View = 'main' | 'dev';
/** Live: the Pi's camera and its real solenoids. Laptop: this laptop's camera and simulated pins. */
export type Rig = 'live' | 'laptop';

interface Props {
  status: Status;
  index: number;
  total: number;
  /** True when cells are being driven onto the real solenoids. */
  live: boolean;
  host: string;
  rig: Rig;
  onRig(rig: Rig): void;
  /** The Pi answers pings right now -- "Live" can't be picked until it does. */
  hardwareOnline: boolean;
  view: View;
  onView(view: View): void;
  /** Stop playback, drop the pins, clear the queue. */
  onStop(): void;
  /** Pin lock: enforced on the Pi, nothing moves until released. */
  pinsLocked: boolean;
  onLockPins(locked: boolean): void;
  recognizer: Recognizer;
  /** Camera lock: the bridge stops detection, reads and queueing. */
  cameraPaused: boolean;
  onPauseCamera(paused: boolean): void;
  /** Microphone lock: listening stops and buffered speech is discarded. */
  micPaused: boolean;
  onPauseMic(paused: boolean): void;
  /** The opt-in nearby-voice pathway is on: show it, it is easy to forget. */
  nearbyVoice: boolean;
  /** Same camera, read as objects/text (Rune) or the wearer's own ASL, spoken aloud (Bragi). */
  cameraMode: CameraMode;
  onCameraMode(mode: CameraMode): void;
  /** Set while a mode switch is in flight (loading the hand model can take a moment). */
  cameraModeBusy: boolean;
  /** No bridge process is reachable at all, so a click here can't do anything. */
  bridgeOffline: boolean;
}

const STATUS_TEXT: Record<Status, string> = {
  idle: 'Waiting for input',
  scanning: 'Scanning frame',
  streaming: 'Sending to pins',
  paused: 'Paused',
  complete: 'Message complete',
};

export function TopBar({ status, index, total, live, host, rig, onRig, hardwareOnline, view, onView, onStop, pinsLocked, onLockPins, recognizer, cameraPaused, onPauseCamera, micPaused, onPauseMic, nearbyVoice, cameraMode, onCameraMode, cameraModeBusy, bridgeOffline }: Props) {
  const showCount = status === 'streaming' || status === 'paused';
  const hasMic = recognizer !== 'camera';
  const hasCamera = recognizer !== 'sound';
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
          <button type="button" className={`tab ${view === 'main' ? 'is-active' : ''}`} onClick={() => onView('main')}>Main</button>
          <button type="button" className={`tab ${view === 'dev' ? 'is-active' : ''}`} onClick={() => onView('dev')}>Dev</button>
        </nav>
        {hasCamera && (
          <nav
            className="tabs"
            aria-label="Camera mode"
            title={bridgeOffline ? 'Bridge not connected: start bridge/detect_bridge.py first' : "Same camera: read the world (objects/text) or read the wearer's own ASL and speak it aloud"}
          >
            <button
              type="button"
              className={`tab ${cameraMode === 'objects' ? 'is-active' : ''}`}
              disabled={cameraModeBusy || bridgeOffline}
              onClick={() => onCameraMode('objects')}
            >
              Rune
            </button>
            <button
              type="button"
              className={`tab ${cameraMode === 'asl' ? 'is-active' : ''}`}
              disabled={cameraModeBusy || bridgeOffline}
              onClick={() => onCameraMode('asl')}
            >
              {cameraModeBusy && cameraMode !== 'asl' ? 'Loading Bragi…' : 'Bragi'}
            </button>
          </nav>
        )}
        {nearbyVoice && (
          <span className="pill pill--warn" title="Speech from a person close to the camera is accepted without the name">
            <span className="pill__dot pill__dot--sim" />
            Nearby voice on
          </span>
        )}
        <nav
          className="tabs"
          aria-label="Rig"
          title={hardwareOnline ? "Live: the Pi's camera and real solenoids. Laptop: this laptop's camera and simulated pins." : `Pi not reachable at ${host} -- Live can't be picked until it answers`}
        >
          <button type="button" className={`tab ${rig === 'live' ? 'is-active' : ''}`} disabled={!hardwareOnline} onClick={() => onRig('live')}>
            Live
          </button>
          <button type="button" className={`tab ${rig === 'laptop' ? 'is-active' : ''}`} onClick={() => onRig('laptop')}>
            Laptop
          </button>
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
          {hasMic && (
            <button
              type="button"
              className={`btn btn--latch btn--latch-amber ${micPaused ? 'is-on' : ''}`}
              onClick={() => onPauseMic(!micPaused)}
              aria-pressed={micPaused}
              title={micPaused ? 'Microphone listening is paused. Click to resume.' : 'Pause listening and discard buffered speech.'}
            >
              <MicIcon />
              {micPaused ? 'Mic paused' : 'Pause mic'}
            </button>
          )}
          {hasCamera && (
            <button
              type="button"
              className={`btn btn--latch btn--latch-amber ${cameraPaused ? 'is-on' : ''}`}
              onClick={() => onPauseCamera(!cameraPaused)}
              aria-pressed={cameraPaused}
              title={cameraPaused ? 'Camera is paused: no detection or queueing. Click to resume.' : 'Pause the camera: stop detecting, calling the vision model and queueing.'}
            >
              <CameraIcon />
              {cameraPaused ? 'Camera paused' : 'Pause camera'}
            </button>
          )}
          <button type="button" className="btn btn--stop" onClick={onStop} title="Stop playback now, drop all pins, clear the queue">
            <StopIcon />
            Stop
          </button>
        </div>
      </div>
    </header>
  );
}
