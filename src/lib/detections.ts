/**
 * Simulated camera detections. The real pipeline will replace `SAMPLES`
 * with results from the object detector / OCR running on the Pi; the
 * shape of `Detection` is the contract the rest of the UI relies on.
 */

export type DetectionKind = 'object' | 'text';
export type DetectionSource = 'simulated' | 'manual';

/** Normalised bounding box, all values 0–1 relative to the frame. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DetectionSample {
  kind: DetectionKind;
  label: string;
  confidence: number;
  box: Box;
}

export interface Detection extends DetectionSample {
  id: string;
  source: DetectionSource;
  at: number;
}

export const SAMPLES: DetectionSample[] = [
  { kind: 'object', label: 'coffee cup', confidence: 0.94, box: { x: 0.34, y: 0.3, w: 0.3, h: 0.44 } },
  { kind: 'text', label: 'EXIT', confidence: 0.97, box: { x: 0.28, y: 0.18, w: 0.44, h: 0.2 } },
  { kind: 'object', label: 'door', confidence: 0.91, box: { x: 0.36, y: 0.08, w: 0.28, h: 0.84 } },
  { kind: 'text', label: 'Room 204', confidence: 0.89, box: { x: 0.22, y: 0.4, w: 0.56, h: 0.18 } },
  { kind: 'object', label: 'keys', confidence: 0.86, box: { x: 0.4, y: 0.46, w: 0.22, h: 0.2 } },
  { kind: 'text', label: 'Pull', confidence: 0.93, box: { x: 0.36, y: 0.36, w: 0.28, h: 0.16 } },
  { kind: 'object', label: 'chair', confidence: 0.92, box: { x: 0.26, y: 0.22, w: 0.46, h: 0.66 } },
  { kind: 'text', label: 'Wet floor', confidence: 0.88, box: { x: 0.2, y: 0.5, w: 0.6, h: 0.22 } },
];

let counter = 0;

export function makeDetection(sample: DetectionSample, source: DetectionSource): Detection {
  counter += 1;
  return { ...sample, id: `det-${counter}`, source, at: Date.now() };
}

export function manualDetection(text: string): Detection {
  return makeDetection(
    { kind: 'text', label: text, confidence: 1, box: { x: 0.14, y: 0.4, w: 0.72, h: 0.2 } },
    'manual',
  );
}
