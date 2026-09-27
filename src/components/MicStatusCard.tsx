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

/**
 * Read-only mic status for the demo-facing Main view: is it listening, for
 * whom, and what did it last hear. Editing the wake name/aliases and the
 * detailed accept/discard/drop stats are debugging concerns -- those stay in
 * the full SoundPanel on Dev.
 */
export function MicStatusCard({ bridge }: Props) {
  const sound = bridge.state?.sound;
  const names = sound ? [sound.wake_name, ...sound.aliases].filter(Boolean).join(' · ') : '—';

  return (
    <section className="card sound" aria-label="Microphone status">
      <div className="card__head">
        <span className="eyebrow">Microphone</span>
        <span className={`sound__state sound__state--${sound?.state ?? 'off'}`}>
          <span className="sound__dot" />
          {bridge.online && sound ? stateLabel(sound.state) : 'bridge offline'}
        </span>
      </div>

      <div className="sound__hero">
        <span className="sound__icon"><MicIcon /></span>
        <div>
          <div className="sound__title">Listening for: {names}</div>
          <div className="small muted">{sound?.device ?? 'Start the bridge to select the Mac microphone.'}</div>
        </div>
      </div>

      <div className="sound__meter" aria-label={`Microphone level ${sound?.level_dbfs ?? -120} decibels full scale`}>
        <span style={{ width: `${levelPercent(sound?.level_dbfs ?? -120)}%` }} />
      </div>

      {sound?.error && <p className="sound__error small">{sound.error}</p>}
      {sound?.last_text && <p className="sound__last"><span className="chip chip--speech">speech</span>{sound.last_text}</p>}
    </section>
  );
}
