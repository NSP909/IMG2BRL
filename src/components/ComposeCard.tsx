import { useState, type FormEvent } from 'react';
import { unsupportedChars } from '../lib/braille';
import { SendIcon } from './Icons';

interface Props {
  onSend(text: string): void;
  disabled?: boolean;
}

export function ComposeCard({ onSend, disabled }: Props) {
  const [text, setText] = useState('');
  const dropped = unsupportedChars(text);

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
  }

  return (
    <section className="card" aria-label="Send custom text">
      <div className="card__head">
        <span className="eyebrow">Send text</span>
        <span className="small muted">Bypass the camera for testing</span>
      </div>
      <form className="compose" onSubmit={submit}>
        <input
          id="compose-text"
          className="input"
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a word or phrase, e.g. Hello 42"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          aria-label="Text to send to the pins"
        />
        <button type="submit" className="btn btn--primary btn--icon" disabled={disabled || !text.trim()} aria-label="Send to pins">
          <SendIcon />
        </button>
      </form>
      <p className="small muted compose__hint">
        {dropped.length > 0
          ? `No cell for ${dropped.map((c) => `“${c}”`).join(' ')} — these will be skipped.`
          : 'Letters, digits, space and . , ; : ! ? \' - are supported.'}
      </p>
    </section>
  );
}
