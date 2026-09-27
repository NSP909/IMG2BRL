/**
 * The 21 MediaPipe hand points drawn the way Bragi's CNN sees them: the same
 * colour per finger and the same connections as the skeleton image it was
 * trained on (bridge/asl_cnn.py), so what's on screen is what the model reads.
 */

const RED = 'rgb(255,48,48)';
const PEACH = 'rgb(255,229,180)';
const PURPLE = 'rgb(128,64,128)';
const YELLOW = 'rgb(255,204,0)';
const GREEN = 'rgb(48,255,48)';
const BLUE = 'rgb(21,101,192)';
const GRAY = 'rgb(128,128,128)';

const JOINT: string[] = [
  RED, RED, PEACH, PEACH, PEACH, RED, PURPLE, PURPLE, PURPLE, RED, YELLOW, YELLOW, YELLOW,
  RED, GREEN, GREEN, GREEN, RED, BLUE, BLUE, BLUE,
];

const BONES: [number, number, string][] = [
  [0, 1, GRAY], [0, 5, GRAY], [0, 17, GRAY], [5, 9, GRAY], [9, 13, GRAY], [13, 17, GRAY],
  [1, 2, PEACH], [2, 3, PEACH], [3, 4, PEACH],
  [5, 6, PURPLE], [6, 7, PURPLE], [7, 8, PURPLE],
  [9, 10, YELLOW], [10, 11, YELLOW], [11, 12, YELLOW],
  [13, 14, GREEN], [14, 15, GREEN], [15, 16, GREEN],
  [17, 18, BLUE], [18, 19, BLUE], [19, 20, BLUE],
];

interface Props {
  /** 21 points, 0-1 within the drawing area. */
  points: [number, number][];
  /** Drawing area in viewBox units (the <svg viewBox="0 0 w h">), so joints stay round. */
  w?: number;
  h?: number;
  /** Joint radius as a fraction of the shorter side. */
  size?: number;
}

export function HandSkeleton({ points: raw, w = 1, h = 1, size = 0.012 }: Props) {
  if (raw.length !== 21) return null;
  const points = raw.map(([x, y]) => [x * w, y * h]);
  size *= Math.min(w, h);
  return (
    <g>
      {BONES.map(([a, b, color]) => (
        <line
          key={`${a}-${b}`}
          x1={points[a][0]}
          y1={points[a][1]}
          x2={points[b][0]}
          y2={points[b][1]}
          stroke={color}
          strokeWidth={color === GRAY ? size * 0.7 : size * 0.5}
          strokeLinecap="round"
        />
      ))}
      {points.map(([x, y], i) => (
        <g key={i}>
          <circle cx={x} cy={y} r={size * 1.25} fill="rgb(224,224,224)" />
          <circle cx={x} cy={y} r={size} fill={JOINT[i]} />
        </g>
      ))}
    </g>
  );
}
