import { useCallback, useEffect, useState } from 'react';
import type { BrailleCell } from '../lib/braille';

/**
 * Plays a list of cells one at a time on a timer, the way the finger
 * hardware will: raise the pins for one cell, hold, move to the next.
 *
 * `index` is -1 while idle, 0..n-1 while a cell is up, and n once the
 * message has finished (all pins down).
 */

export interface StreamOptions {
  /** How long each cell stays raised. */
  cellMs: number;
  /** How long a space (all pins down) is held, also the gap before a loop restarts. */
  spaceMs: number;
  loop: boolean;
  /** Start playing as soon as a new message arrives. */
  autoPlay: boolean;
}

export interface CellStream {
  index: number;
  total: number;
  current: BrailleCell | null;
  playing: boolean;
  finished: boolean;
  /** Hold time of the cell currently shown. */
  holdMs: number;
  play(): void;
  pause(): void;
  toggle(): void;
  next(): void;
  prev(): void;
  restart(): void;
  seek(i: number): void;
  /** Stop and go idle (index -1, nothing shown). */
  stop(): void;
}

export function useCellStream(cells: BrailleCell[], opts: StreamOptions): CellStream {
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const total = cells.length;

  // A new message arrives: start from its first cell.
  useEffect(() => {
    setIndex(cells.length > 0 ? 0 : -1);
    setPlaying(cells.length > 0 && opts.autoPlay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells]);

  const current = index >= 0 && index < total ? cells[index] : null;
  const finished = total > 0 && index >= total;
  const holdMs = current?.kind === 'space' ? opts.spaceMs : opts.cellMs;

  useEffect(() => {
    if (!playing || index < 0 || total === 0) return;
    const atEnd = index >= total;
    if (atEnd && !opts.loop) {
      setPlaying(false);
      return;
    }
    const delay = atEnd ? opts.spaceMs : holdMs;
    const timer = window.setTimeout(() => {
      setIndex(atEnd ? 0 : index + 1);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [playing, index, total, holdMs, opts.loop, opts.spaceMs]);

  const play = useCallback(() => {
    if (total === 0) return;
    if (index < 0 || index >= total) setIndex(0);
    setPlaying(true);
  }, [index, total]);

  const pause = useCallback(() => setPlaying(false), []);

  const toggle = useCallback(() => {
    if (playing) pause();
    else play();
  }, [playing, play, pause]);

  // Stepping by hand pauses playback so a cell can be inspected.
  const next = useCallback(() => {
    setPlaying(false);
    setIndex((i) => Math.min(Math.max(i, -1) + 1, total));
  }, [total]);

  const prev = useCallback(() => {
    setPlaying(false);
    setIndex((i) => Math.max(i - 1, 0));
  }, []);

  const restart = useCallback(() => {
    if (total === 0) return;
    setIndex(0);
    setPlaying(true);
  }, [total]);

  const seek = useCallback(
    (i: number) => {
      setPlaying(false);
      setIndex(Math.min(Math.max(i, 0), total));
    },
    [total],
  );

  const stop = useCallback(() => {
    setPlaying(false);
    setIndex(-1);
  }, []);

  return { index, total, current, playing, finished, holdMs, play, pause, toggle, next, prev, restart, seek, stop };
}
