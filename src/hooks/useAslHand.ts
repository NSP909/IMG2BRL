import { useEffect, useRef, useState } from 'react';
import { fetchAslHand, type AslHand } from '../lib/bridge';

const HAND_POLL_MS = 50;

/** Bragi's hand points, skeleton and top-3, polled ~20x/s while `enabled`. */
export function useAslHand(baseUrl: string, enabled: boolean): AslHand | null {
  const [hand, setHand] = useState<AslHand | null>(null);
  useEffect(() => {
    if (!enabled) {
      setHand(null);
      return;
    }
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      const h = await fetchAslHand(baseUrl);
      if (cancelled) return;
      if (h) setHand(h);
      timer = window.setTimeout(tick, HAND_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [baseUrl, enabled]);
  return hand;
}

/** Glides drawn points toward the latest ones every animation frame, so a
 * skeleton updated ~20x/s moves at the screen's refresh rate instead of stepping. */
export function useSmoothedPoints(target: [number, number][] | null, follow = 0.35): [number, number][] | null {
  const [points, setPoints] = useState<[number, number][] | null>(target);
  const current = useRef<[number, number][] | null>(target);
  const goal = useRef(target);
  goal.current = target;

  useEffect(() => {
    let raf = 0;
    const step = () => {
      const g = goal.current;
      const c = current.current;
      if (!g || g.length !== 21) {
        if (c !== null) setPoints((current.current = null));
      } else if (!c || c.length !== 21) {
        setPoints((current.current = g));
      } else {
        let moved = false;
        const next = c.map(([x, y], i) => {
          const nx = x + (g[i][0] - x) * follow;
          const ny = y + (g[i][1] - y) * follow;
          if (Math.abs(nx - x) > 1e-4 || Math.abs(ny - y) > 1e-4) moved = true;
          return [nx, ny] as [number, number];
        });
        if (moved) setPoints((current.current = next));
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [follow]);
  return points;
}
