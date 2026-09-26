import { useEffect, useState, type FormEvent } from 'react';
import { DOTS, dotsToMask, dotsToUnicode, maskToBinary, maskToDots, maskToHex, type BrailleCell } from '../lib/braille';
import type { Hardware } from '../hooks/useHardware';

export interface Frame {
  id: number;
  at: number;
  mask: number;
  label: string;
  /** True when this frame was actually sent to the Pi, false when simulated. */
  sent: boolean;
}

interface Props {
  cell: BrailleCell | null;
  frames: Frame[];
  hardware: Hardware;
}

/** Pin states as the controller sees them, the last frames sent, and the link to the real Pi. */
export function PinPanel({ cell, frames, hardware }: Props) {
  const dots = cell?.dots ?? [];
  const raised = new Set(dots);
  const mask = dotsToMask(dots);
  const pins = hardware.status?.pins ?? [];

  return (
    <section className="card pins" aria-label="Pin hardware">
      <div className="card__head pins__head">
        <span className="eyebrow">Pin actuator</span>
        <span className="small muted hw__status">
          <span className={`status__dot ${hardware.live ? 'status__dot--streaming' : hardware.online ? 'status__dot--paused' : ''}`} aria-hidden />
          {hardware.live
            ? `Live · Pi at ${hardware.host}`
            : hardware.online
              ? `Pi at ${hardware.host} · real pins off`
              : `Pi not reachable at ${hardware.host} · simulating`}
        </span>
      </div>

      <div className="pins__body">
        <svg className="finger" viewBox="0 0 120 150" aria-label={`Finger module, ${dots.length} of 6 pins raised`} role="img">
          <rect x="24" y="6" width="72" height="170" rx="36" className="finger__skin" />
          <rect x="37" y="24" width="46" height="66" rx="9" className="finger__plate" />
          {[
            [1, 50, 39], [4, 70, 39],
            [2, 50, 57], [5, 70, 57],
            [3, 50, 75], [6, 70, 75],
          ].map(([d, cx, cy]) => (
            <circle key={d} cx={cx} cy={cy} r="6" className={raised.has(d as 1) ? 'finger__pin finger__pin--up' : 'finger__pin'} />
          ))}
          <text x="60" y="112" textAnchor="middle" className="finger__text">{dotsToUnicode(dots)}</text>
        </svg>

        <div className="pins__right">
          <div className="pinlist">
            {DOTS.map((d) => (
              <div key={d} className={`pin ${raised.has(d) ? 'is-up' : ''}`} title={pins[d - 1] !== undefined ? `GPIO ${pins[d - 1]}` : undefined}>
                <span className="pin__led" aria-hidden />
                <span>P{d}</span>
                <span className="pin__state">{raised.has(d) ? 'UP' : 'down'}</span>
              </div>
            ))}
          </div>

          <div className="mask">
            <div><span className="muted">mask</span> <span className="mono">{maskToBinary(mask)}</span></div>
            <div><span className="muted">byte</span> <span className="mono">{maskToHex(mask)}</span></div>
            <div><span className="muted">raised</span> <span className="mono">{maskToDots(mask).join(',') || '—'}</span></div>
          </div>

          <div className="log" aria-label="Recent frames">
            <table>
              <tbody>
                {frames.map((f) => (
                  <tr key={f.id}>
                    <td className="muted">{formatTime(f.at)}</td>
                    <td>{f.sent ? 'TX' : 'SIM'}</td>
                    <td>{maskToBinary(f.mask)}</td>
                    <td>{maskToHex(f.mask)}</td>
                    <td className="log__glyph">{String.fromCodePoint(0x2800 + f.mask)}</td>
                    <td className="log__label">{f.label === ' ' ? 'space' : f.label || 'all down'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <HardwareControls hardware={hardware} />
        </div>
      </div>
    </section>
  );
}

function HardwareControls({ hardware }: { hardware: Hardware }) {
  const [draft, setDraft] = useState(hardware.baseUrl);
  useEffect(() => setDraft(hardware.baseUrl), [hardware.baseUrl]);

  function connect(e: FormEvent) {
    e.preventDefault();
    hardware.setBaseUrl(draft);
  }

  return (
    <div className="hw">
      <label className="switch" htmlFor="hw-enabled">
        <input id="hw-enabled" type="checkbox" checked={hardware.enabled} onChange={(e) => hardware.setEnabled(e.target.checked)} />
        <span className="switch__track" aria-hidden><span className="switch__knob" /></span>
        <span>Drive real pins</span>
      </label>

      {!hardware.fixedAddress && (
        <form className="hw__addr" onSubmit={connect}>
          <input
            className="input"
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Pi address, e.g. 169.254.10.10:8080"
            spellCheck={false}
            autoComplete="off"
            aria-label="Pi controller address"
          />
          <button type="submit" className="btn" disabled={draft.trim() === hardware.baseUrl}>Connect</button>
        </form>
      )}

      <button type="button" className="btn" onClick={hardware.allOff} disabled={!hardware.live}>All pins down</button>
    </div>
  );
}

function formatTime(t: number) {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}
