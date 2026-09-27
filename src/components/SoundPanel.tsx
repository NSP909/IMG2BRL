import { useEffect, useState, type FormEvent } from 'react';
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
  const paused = bridge.micPaused;
  const names = sound
    ? [sound.wake_name, ...sound.aliases].filter(Boolean).join(' · ')
    : '—';

  // Editable wearer name + aliases; saved on the bridge (bridge/wake.json) so it survives restarts.
  const [name, setName] = useState(sound?.wake_name ?? '');
  const [aliases, setAliases] = useState(sound?.aliases.join(', ') ?? '');
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const aliasKey = sound?.aliases.join(',') ?? '';
  useEffect(() => {
    if (sound && saving === 'idle') {
      setName(sound.wake_name ?? '');
      setAliases(sound.aliases.join(', '));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sound?.wake_name, aliasKey]);
  const dirty = !!sound && (name.trim() !== (sound.wake_name ?? '') || aliases.split(',').map((a) => a.trim()).filter(Boolean).join(',') !== aliasKey);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving('saving');
    const ok = await bridge.setWake(name.trim(), aliases.split(',').map((a) => a.trim()).filter(Boolean));
    setSaving(ok ? 'saved' : 'failed');
    window.setTimeout(() => setSaving('idle'), 1500);
  }

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
          <div className="small muted">{sound?.device ?? 'Start the bridge to select the Mac microphone.'}</div>
        </div>
      </div>

      <form className="sound__name" onSubmit={save} aria-label="Wearer name">
        <input className="input" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Wearer's name" aria-label="Wearer's name" spellCheck={false} disabled={!bridge.online} />
        <input className="input" type="text" value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="Other spellings, comma-separated" aria-label="Alternate spellings" spellCheck={false} disabled={!bridge.online} />
        <button type="submit" className="btn btn--primary" disabled={!bridge.online || !name.trim() || (!dirty && saving === 'idle')}>
          {saving === 'saving' ? 'Saving…' : saving === 'saved' ? 'Saved' : saving === 'failed' ? 'Failed' : 'Set name'}
        </button>
      </form>

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
      <p className="small muted">Only complete utterances containing the name or an alias enter the queue, ahead of anything the camera saw. Other speech is discarded without being shown or logged.</p>
    </section>
  );
}
