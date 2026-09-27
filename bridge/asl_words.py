"""Fingerspelled letters -> the word the signer meant.

The letter classifier is noisy in predictable ways: doubled letters come out
once ("HELO"), a hand passing between shapes can add a stray letter
("HELLWO"), and some shapes get swapped for each other from the Pi's angle
(M/E, U/R, X/N, B/F, and the closed-fist letters). So the decoder is a
weighted edit distance (Levenshtein with adjacent swaps) over a 10k
common-English word list plus conversational words, known terms and the
wearer's own names, with those specific mistakes made cheap and ties going to
the more common word. Local, a few milliseconds, no network.

If no word is close enough, the raw letters are kept, so names and unusual
words survive. (Measured on simulated noisy spellings, single words: 80%
correct; a GPT-2 rescorer added under one point, so it was left out.)
"""

from __future__ import annotations

import math
import os
import time

HERE = os.path.dirname(os.path.abspath(__file__))
WORDS_PATH = os.path.join(HERE, "models", "words.txt")
MAX_CANDIDATES = 12

# Everyday words a demo is likely to need that a web-frequency list ranks low.
EXTRA_WORDS = [
    "hi", "hey", "hello", "bye", "yes", "no", "ok", "okay", "please", "thanks", "thank", "sorry",
    "help", "water", "food", "bathroom", "name", "my", "is", "me", "you", "love", "good", "bad",
    "friend", "family", "where", "what", "who", "how", "why", "when", "stop", "wait", "go", "come",
]

# Terms that aren't in any dictionary but matter to this wearer. Acronyms are
# spoken letter by letter.
TERMS = {
    "UMBC": "UMBC, the University of Maryland, Baltimore County (the wearer's university)",
}

# Letter pairs the Pi-camera classifier actually confuses (measured on held-out
# recordings), plus the closed-fist family, which differs only by thumb position.
CONFUSED = {frozenset(p) for p in [
    ("M", "E"), ("U", "R"), ("X", "N"), ("B", "F"),
    ("A", "S"), ("S", "T"), ("T", "N"), ("N", "M"), ("M", "S"), ("A", "E"),
    ("U", "V"), ("H", "U"), ("K", "V"), ("G", "H"), ("O", "C"), ("I", "Y"),
]}
SUB_CONFUSED, SUB_OTHER = 0.35, 1.0
EXTRA_LETTER = 0.7       # a stray letter in what was signed
MISSING_LETTER = 0.9     # a letter the classifier never caught
MISSING_DOUBLE = 0.15    # the second of a doubled letter, which it can't produce
SWAPPED = 0.5            # two neighbouring letters caught in the wrong order


def _cost(signed: str, word: str, alts: list | None = None) -> float:
    """Weighted edit distance (with adjacent swaps) from the signed letters to a word.
    alts[i], when given, is the letter model's guesses for position i as {letter: p};
    swapping to a runner-up it seriously considered is cheap."""
    n, m = len(signed), len(word)

    def sub_cost(i: int, a: str, b: str) -> float:
        if a == b:
            return 0.0
        base = SUB_CONFUSED if frozenset((a, b)) in CONFUSED else SUB_OTHER
        if alts and i < len(alts) and alts[i]:
            p_b, p_a = alts[i].get(b, 0.0), max(alts[i].get(a, 0.0), 1e-3)
            if p_b > 0:
                base = min(base, max(0.05, 0.5 * math.log(p_a / p_b) + 0.1))
        return base

    def missing(j: int) -> float:
        return MISSING_DOUBLE if j > 1 and word[j - 1] == word[j - 2] else MISSING_LETTER

    d = [[0.0] * (m + 1) for _ in range(n + 1)]
    for j in range(1, m + 1):
        d[0][j] = d[0][j - 1] + missing(j)
    for i in range(1, n + 1):
        d[i][0] = d[i - 1][0] + EXTRA_LETTER
        for j in range(1, m + 1):
            a, b = signed[i - 1], word[j - 1]
            sub = sub_cost(i - 1, a, b)
            best = min(d[i - 1][j - 1] + sub, d[i - 1][j] + EXTRA_LETTER, d[i][j - 1] + missing(j))
            if i > 1 and j > 1 and a == word[j - 2] and signed[i - 2] == b and a != b:
                best = min(best, d[i - 2][j - 2] + SWAPPED)
            d[i][j] = best
    return d[n][m]


class WordDecoder:
    def __init__(self, api_key: str | None = None, extra_vocab: list[str] | None = None):
        # api_key is accepted and ignored so older callers keep working.
        self.names: list[str] = []
        self._rank: dict[str, int] = {}
        try:
            with open(WORDS_PATH) as f:
                for i, line in enumerate(f):
                    w = line.strip().upper()
                    if w.isalpha():
                        self._rank.setdefault(w, i)
        except FileNotFoundError:
            pass
        for w in EXTRA_WORDS + list(TERMS) + (extra_vocab or []):
            self._rank.setdefault(w.upper(), 50)

    def set_names(self, names: list[str]) -> None:
        """Names the wearer uses (the wake name and aliases) become candidates."""
        self.names = [n for n in names if n and n.isalpha()]
        for n in self.names:
            self._rank.setdefault(n.upper(), 50)

    def candidates(self, letters: list[str], alts: list | None = None) -> list[tuple[str, float]]:
        signed = "".join(letters).upper()
        if not signed:
            return []
        scored = []
        for w, rank in self._rank.items():
            if abs(len(w) - len(signed)) > 3:
                continue
            c = _cost(signed, w, alts)
            if c <= max(1.6, 0.45 * len(signed)):
                scored.append((w, c + rank / 40000))    # common words win ties
        scored.sort(key=lambda t: t[1])
        return scored[:MAX_CANDIDATES]

    def decode(self, letters: list[str], previous_words: list[str] | None = None, alts: list | None = None) -> dict:
        """previous_words is accepted for API compatibility; single words are the common case."""
        t0 = time.time()
        signed = "".join(letters).upper()
        cands = self.candidates(letters, alts)
        result = {"raw": signed, "word": signed.lower(), "source": "raw", "confidence": 0.0,
                  "candidates": [_display(w) for w, _ in cands[:5]], "ms": 0, "error": None}
        if cands and cands[0][1] <= max(1.0, 0.3 * len(signed)):
            result.update(word=_display(cands[0][0]), source="local", confidence=round(1 / (1 + cands[0][1]), 2))
        result["ms"] = int((time.time() - t0) * 1000)
        return result


def _display(word: str) -> str:
    """Dictionary words lower-case, known terms (acronyms) as written."""
    return word if word in TERMS else word.lower()


def spoken_form(word: str) -> str:
    """What to hand to `say`: acronyms letter by letter ("U M B C"), the rest as is."""
    return " ".join(word) if word.upper() in TERMS and word.isupper() else word
