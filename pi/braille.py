"""Uncontracted (Grade 1) English braille encoder.

Mirrors src/lib/braille.ts in the visualizer so both sides produce the
same cell sequence for the same text.

Dot numbering:  1 4
                2 5
                3 6
Mask: bit (n-1) is dot n, so mask 0b000001 is dot 1 and 0b100000 is dot 6.
"""

LETTERS = {
    'a': [1], 'b': [1, 2], 'c': [1, 4], 'd': [1, 4, 5], 'e': [1, 5],
    'f': [1, 2, 4], 'g': [1, 2, 4, 5], 'h': [1, 2, 5], 'i': [2, 4], 'j': [2, 4, 5],
    'k': [1, 3], 'l': [1, 2, 3], 'm': [1, 3, 4], 'n': [1, 3, 4, 5], 'o': [1, 3, 5],
    'p': [1, 2, 3, 4], 'q': [1, 2, 3, 4, 5], 'r': [1, 2, 3, 5], 's': [2, 3, 4], 't': [2, 3, 4, 5],
    'u': [1, 3, 6], 'v': [1, 2, 3, 6], 'w': [2, 4, 5, 6], 'x': [1, 3, 4, 6], 'y': [1, 3, 4, 5, 6],
    'z': [1, 3, 5, 6],
}
PUNCTUATION = {
    ',': [2], ';': [2, 3], ':': [2, 5], '.': [2, 5, 6], '!': [2, 3, 5],
    '?': [2, 3, 6], "'": [3], '-': [3, 6],
}
CAPITAL_SIGN = [6]
NUMBER_SIGN = [3, 4, 5, 6]
DIGIT_LETTERS = 'jabcdefghi'   # digit n -> letter at index n


def dots_to_mask(dots):
    m = 0
    for d in dots:
        m |= 1 << (d - 1)
    return m


def mask_to_dots(mask):
    return [d for d in range(1, 7) if mask & (1 << (d - 1))]


def dots_to_unicode(dots):
    return chr(0x2800 + dots_to_mask(dots))


def is_supported(ch):
    return ch.isascii() and (ch.isalpha() or ch.isdigit() or ch == ' ' or ch in PUNCTUATION)


def _cell(dots, label, kind, source_index, description):
    return {"dots": list(dots), "mask": dots_to_mask(dots), "glyph": dots_to_unicode(dots),
            "label": label, "kind": kind, "sourceIndex": source_index, "description": description}


def encode_text(text, capital_indicators=True):
    """Text -> ordered list of cells. Unsupported characters are dropped."""
    cells = []
    i, n = 0, len(text)
    number_mode = False
    while i < n:
        ch = text[i]
        if ch.isascii() and ch.isalpha():
            number_mode = False
            j = i
            while j < n and text[j].isascii() and text[j].isalpha():
                j += 1
            word = text[i:j]
            whole_word_caps = len(word) >= 2 and word == word.upper()
            if capital_indicators and whole_word_caps:
                cells.append(_cell(CAPITAL_SIGN, 'Caps', 'indicator', i, 'Capital word indicator'))
                cells.append(_cell(CAPITAL_SIGN, 'Caps', 'indicator', i, 'Capital word indicator'))
            for k in range(i, j):
                c = text[k]
                lower = c.lower()
                if capital_indicators and not whole_word_caps and c != lower:
                    cells.append(_cell(CAPITAL_SIGN, 'Cap', 'indicator', k, 'Capital indicator'))
                cells.append(_cell(LETTERS[lower], c, 'letter', k, f'Letter {c}'))
            i = j
            continue
        if ch.isascii() and ch.isdigit():
            if not number_mode:
                cells.append(_cell(NUMBER_SIGN, 'Num', 'indicator', i, 'Number indicator'))
                number_mode = True
            cells.append(_cell(LETTERS[DIGIT_LETTERS[int(ch)]], ch, 'digit', i, f'Digit {ch}'))
            i += 1
            continue
        number_mode = False
        if ch == ' ':
            cells.append(_cell([], ' ', 'space', i, 'Space'))
        elif ch in PUNCTUATION:
            cells.append(_cell(PUNCTUATION[ch], ch, 'punctuation', i, f'Punctuation {ch}'))
        i += 1
    return cells


if __name__ == "__main__":
    import sys
    txt = " ".join(sys.argv[1:]) or "Hello 42"
    for c in encode_text(txt):
        print(f"{c['glyph']}  {c['label']!r:6} dots={c['dots']} mask=0b{c['mask']:06b}  {c['description']}")
