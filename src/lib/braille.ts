/**
 * Six-dot braille model for a single 3x2 cell.
 *
 * Standard dot numbering (as felt under the finger):
 *
 *   1 • • 4
 *   2 • • 5
 *   3 • • 6
 *
 * A cell is described by the set of raised dots. The hardware receives
 * the same information as a 6-bit mask where bit (n-1) is dot n.
 */

export type Dot = 1 | 2 | 3 | 4 | 5 | 6;

export const DOTS: readonly Dot[] = [1, 2, 3, 4, 5, 6];

/** Dots in row-major order for a two-column layout: 1 4 / 2 5 / 3 6. */
export const GRID_ORDER: readonly Dot[] = [1, 4, 2, 5, 3, 6];

export type CellKind = 'letter' | 'digit' | 'punctuation' | 'indicator' | 'space';

export interface BrailleCell {
  dots: Dot[];
  /** The source character, or a short name for an indicator cell. */
  label: string;
  kind: CellKind;
  /** Index into the source string this cell was produced from. */
  sourceIndex: number;
  /** Plain-language description, e.g. "Letter c" or "Capital indicator". */
  description: string;
}

const LETTERS: Record<string, Dot[]> = {
  a: [1],
  b: [1, 2],
  c: [1, 4],
  d: [1, 4, 5],
  e: [1, 5],
  f: [1, 2, 4],
  g: [1, 2, 4, 5],
  h: [1, 2, 5],
  i: [2, 4],
  j: [2, 4, 5],
  k: [1, 3],
  l: [1, 2, 3],
  m: [1, 3, 4],
  n: [1, 3, 4, 5],
  o: [1, 3, 5],
  p: [1, 2, 3, 4],
  q: [1, 2, 3, 4, 5],
  r: [1, 2, 3, 5],
  s: [2, 3, 4],
  t: [2, 3, 4, 5],
  u: [1, 3, 6],
  v: [1, 2, 3, 6],
  w: [2, 4, 5, 6],
  x: [1, 3, 4, 6],
  y: [1, 3, 4, 5, 6],
  z: [1, 3, 5, 6],
};

const PUNCTUATION: Record<string, Dot[]> = {
  ',': [2],
  ';': [2, 3],
  ':': [2, 5],
  '.': [2, 5, 6],
  '!': [2, 3, 5],
  '?': [2, 3, 6],
  "'": [3],
  '-': [3, 6],
};

/** Dot 6 before a letter marks it as a capital. Two in a row capitalise the whole word. */
export const CAPITAL_SIGN: Dot[] = [6];
/** Dots 3-4-5-6 announce that the following a–j cells are the digits 1–0. */
export const NUMBER_SIGN: Dot[] = [3, 4, 5, 6];
/**
 * Message-kind indicators, sent as the first cell so the finger knows what is
 * coming. Both patterns are unused anywhere else in this encoder:
 * the full cell (all six dots) for speech, the "square" (2-3-5-6) for text.
 * Objects carry no indicator.
 */
export const SPEECH_SIGN: Dot[] = [1, 2, 3, 4, 5, 6];
export const TEXT_SIGN: Dot[] = [2, 3, 5, 6];
export type MessageKind = 'object' | 'text' | 'speech';

/** Digit n is written with the letter at this index once the number sign is active. */
const DIGIT_LETTERS = 'jabcdefghi';

const isLetter = (ch: string) => /^[a-zA-Z]$/.test(ch);
const isDigit = (ch: string) => /^[0-9]$/.test(ch);

export function isSupported(ch: string): boolean {
  return isLetter(ch) || isDigit(ch) || ch === ' ' || ch in PUNCTUATION;
}

/** Unique characters in `text` that have no cell and will be dropped by the encoder. */
export function unsupportedChars(text: string): string[] {
  const out: string[] = [];
  for (const ch of text) {
    if (!isSupported(ch) && !out.includes(ch)) out.push(ch);
  }
  return out;
}

export function dotsToMask(dots: readonly Dot[]): number {
  return dots.reduce((mask, d) => mask | (1 << (d - 1)), 0);
}

export function maskToDots(mask: number): Dot[] {
  return DOTS.filter((d) => (mask & (1 << (d - 1))) !== 0);
}

/** The Unicode braille pattern for these dots (U+2800 block shares the same bit layout). */
export function dotsToUnicode(dots: readonly Dot[]): string {
  return String.fromCodePoint(0x2800 + dotsToMask(dots));
}

export function maskToBinary(mask: number): string {
  return '0b' + mask.toString(2).padStart(6, '0');
}

export function maskToHex(mask: number): string {
  return '0x' + mask.toString(16).toUpperCase().padStart(2, '0');
}

export function describeDots(dots: readonly Dot[]): string {
  if (dots.length === 0) return 'no dots raised';
  if (dots.length === 1) return `dot ${dots[0]}`;
  return `dots ${dots.slice(0, -1).join(', ')} and ${dots[dots.length - 1]}`;
}

export interface EncodeOptions {
  /** Emit capital indicators (dot 6) for uppercase letters. Default true. */
  capitalIndicators?: boolean;
  /** Prefix the message with its kind indicator (speech: full cell, text: 2-3-5-6). */
  kind?: MessageKind;
}

/**
 * Turn a string into the ordered list of cells the finger will feel,
 * one cell at a time. Uncontracted (Grade 1) braille with capital and
 * number indicators. Characters with no cell are skipped.
 */
export function encodeText(text: string, opts: EncodeOptions = {}): BrailleCell[] {
  const caps = opts.capitalIndicators ?? true;
  const cells: BrailleCell[] = [];
  let i = 0;
  let numberMode = false;

  if (text.length > 0 && opts.kind === 'speech') cells.push(indicator('Speech', 'Speech indicator', SPEECH_SIGN, 0));
  if (text.length > 0 && opts.kind === 'text') cells.push(indicator('Text', 'Text indicator', TEXT_SIGN, 0));

  while (i < text.length) {
    const ch = text[i];

    if (isLetter(ch)) {
      numberMode = false;
      let j = i;
      while (j < text.length && isLetter(text[j])) j++;
      const word = text.slice(i, j);
      const wholeWordCaps = word.length >= 2 && word === word.toUpperCase();

      if (caps && wholeWordCaps) {
        cells.push(indicator('Caps', 'Capital word indicator', CAPITAL_SIGN, i));
        cells.push(indicator('Caps', 'Capital word indicator', CAPITAL_SIGN, i));
      }
      for (let k = i; k < j; k++) {
        const c = text[k];
        const lower = c.toLowerCase();
        if (caps && !wholeWordCaps && c !== lower) {
          cells.push(indicator('Cap', 'Capital indicator', CAPITAL_SIGN, k));
        }
        cells.push({
          dots: [...LETTERS[lower]],
          label: c,
          kind: 'letter',
          sourceIndex: k,
          description: `Letter ${c}`,
        });
      }
      i = j;
      continue;
    }

    if (isDigit(ch)) {
      if (!numberMode) {
        cells.push(indicator('Num', 'Number indicator', NUMBER_SIGN, i));
        numberMode = true;
      }
      cells.push({
        dots: [...LETTERS[DIGIT_LETTERS[Number(ch)]]],
        label: ch,
        kind: 'digit',
        sourceIndex: i,
        description: `Digit ${ch}`,
      });
      i++;
      continue;
    }

    numberMode = false;

    if (ch === ' ') {
      cells.push({ dots: [], label: ' ', kind: 'space', sourceIndex: i, description: 'Space' });
      i++;
      continue;
    }

    if (ch in PUNCTUATION) {
      cells.push({
        dots: [...PUNCTUATION[ch]],
        label: ch,
        kind: 'punctuation',
        sourceIndex: i,
        description: `Punctuation ${ch}`,
      });
      i++;
      continue;
    }

    // No cell for this character: drop it.
    i++;
  }

  return cells;
}

function indicator(label: string, description: string, dots: Dot[], sourceIndex: number): BrailleCell {
  return { dots: [...dots], label, kind: 'indicator', sourceIndex, description };
}
