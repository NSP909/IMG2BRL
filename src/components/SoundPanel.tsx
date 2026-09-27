import type { Bridge } from '../hooks/useBridge';
import { MicIcon } from './Icons';

interface Props {
  bridge: Bridge;
}

function levelPercent(dbfs: number) {
  return Math.max(0, Math.min(100, ((dbfs + 60) / 60) * 100));
}

function stateLabel(state: string) {
  return state.replaceAll('_', ' ');
}

/** Read-only microphone status. Rejected transcripts are intentionally absent. */
export function SoundPanel({ bridge }: Props) {
  const sound = bridge.state?.sound;
  const paused = bridge.paused;
  const names = sound
    ? [sound.wake_name, ...sound.aliases].filter(Boolean).join(' · ')
    : '—';

  return (
    <section className="card sound" aria-label="Name-triggered speech recognition">
      <div className="card__head">
        <span className="eyebrow">Microphone · name-triggered text</span>
        <span className={`sound__state sound__state--${sound?.state ?? 'off'}`}>
          <span className="sound__dot" />
          {bridge.online && sound ? stateLabel(sound.state) : 'bridge offline'}
        </span>
      </div>

      <div className="sound__hero">
        <span className="sound__icon"><MicIcon /></span>
        <div>
          <div className="sound__title">Listening for: {names}</div>
          <div className="small muted">{sound?.device ?? 'Start the bridge in sound mode to select the Mac microphone.'}</div>
        </div>
      </div>

      <div className="sound__meter" aria-label={`Microphone level ${sound?.level_dbfs ?? -120} decibels full scale`}>
        <span style={{ width: `${levelPercent(sound?.level_dbfs ?? -120)}%` }} />
      </div>
      <div className="field__row">
        <span className="small muted mono">{sound ? `${sound.level_dbfs.toFixed(1)} dBFS · VAD ${Math.round(sound.vad_probability * 100)}%` : '—'}</span>
        <span className="small muted">{paused ? 'Listening paused' : 'Use Pause mic in the top bar'}</span>
      </div>

      {sound?.error && <p className="sound__error small">{sound.error}</p>}
      {sound && (
        <div className="sound__stats small muted mono">
          <span>{sound.latency_ms ? `${sound.latency_ms} ms last ASR` : 'waiting for speech'}</span>
          <span>{sound.accepted_count} accepted</span>
          <span>{sound.discarded_count} discarded privately</span>
          <span>{sound.dropped_count} dropped</span>
        </div>
      )}
      {sound?.last_text && <p className="sound__last"><span className="chip chip--speech">speech</span>{sound.last_text}</p>}
      <p className="small muted">Only complete utterances containing the configured name or alias enter the queue. Other speech is discarded without being shown or logged.</p>
    </section>
  );
}
