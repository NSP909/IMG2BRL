export interface Settings {
  cellMs: number;
  spaceMs: number;
  loop: boolean;
  capitalIndicators: boolean;
}

interface Props {
  settings: Settings;
  onChange(next: Settings): void;
}

export function SettingsCard({ settings, onChange }: Props) {
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onChange({ ...settings, [key]: value });

  return (
    <section className="card settings" aria-label="Timing and encoding">
      <div className="card__head">
        <span className="eyebrow">Timing</span>
        <span className="small muted">Until the hardware clock takes over</span>
      </div>

      <div className="field">
        <div className="field__row">
          <label htmlFor="cell-ms">Hold per cell</label>
          <span className="mono">{settings.cellMs} ms</span>
        </div>
        <input
          id="cell-ms"
          type="range"
          min={200}
          max={2000}
          step={50}
          value={settings.cellMs}
          onChange={(e) => set('cellMs', Number(e.target.value))}
        />
      </div>

      <div className="field">
        <div className="field__row">
          <label htmlFor="space-ms">Hold per space</label>
          <span className="mono">{settings.spaceMs} ms</span>
        </div>
        <input
          id="space-ms"
          type="range"
          min={100}
          max={1500}
          step={50}
          value={settings.spaceMs}
          onChange={(e) => set('spaceMs', Number(e.target.value))}
        />
      </div>

      <div className="switch-row">
        <label className="switch" htmlFor="loop">
          <input id="loop" type="checkbox" checked={settings.loop} onChange={(e) => set('loop', e.target.checked)} />
          <span className="switch__track" aria-hidden><span className="switch__knob" /></span>
          <span>Repeat message</span>
        </label>
        <label className="switch" htmlFor="caps">
          <input
            id="caps"
            type="checkbox"
            checked={settings.capitalIndicators}
            onChange={(e) => set('capitalIndicators', e.target.checked)}
          />
          <span className="switch__track" aria-hidden><span className="switch__knob" /></span>
          <span>Capital indicators</span>
        </label>
      </div>
    </section>
  );
}
