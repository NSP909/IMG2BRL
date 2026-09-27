import type { Bridge } from '../hooks/useBridge';
import type { Hardware } from '../hooks/useHardware';
import type { BrailleCell } from '../lib/braille';
import { ComposeCard } from './ComposeCard';
import { PinPanel, type Frame } from './PinPanel';
import { SettingsCard, type Settings } from './SettingsCard';
import { SoundPanel } from './SoundPanel';

interface Props {
  bridge: Bridge;
  hasMic: boolean;
  onSend(text: string): void;
  sendDisabled: boolean;
  cell: BrailleCell | null;
  frames: Frame[];
  hardware: Hardware;
  settings: Settings;
  onSettingsChange(next: Settings): void;
}

/**
 * Everything here is operating the device, not demonstrating it: a raw
 * text-injection bypass for testing, GPIO pin states, and timing knobs.
 * Kept off the main Finger screen so that view stays what a demo audience
 * should actually see. The queue itself moved back to the Finger view --
 * seeing what's lined up next is part of the demo, not just operating it.
 */
export function SettingsView({ bridge, hasMic, onSend, sendDisabled, cell, frames, hardware, settings, onSettingsChange }: Props) {
  return (
    <main className="layout lab">
      <div className="col" aria-label="Input">
        {hasMic && <SoundPanel bridge={bridge} />}
        <ComposeCard onSend={onSend} disabled={sendDisabled} />
      </div>
      <div className="col" aria-label="Hardware and timing">
        <PinPanel cell={cell} frames={frames} hardware={hardware} />
        <SettingsCard settings={settings} onChange={onSettingsChange} />
      </div>
    </main>
  );
}
