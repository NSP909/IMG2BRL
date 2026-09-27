"""Fingerspelled letters -> the word the signer meant.

The letter classifier is noisy in predictable ways: doubled letters come out
once ("HELO"), a hand passing between shapes can add a stray letter
("HELLWO"), and some shapes get swapped for each other from the Pi's angle
(M/E, U/R, X/N, B/F, and the closed-fist letters). So decoding is two steps:

1. Candidates, locally and instantly: an edit distance where those specific
   mistakes are cheap, run over a 10k common-English word list plus a few
   conversational words and the wearer's own name.
2. A pick, by Jev (TypeSafe's typed-decision model): given the letters, the
   words already said and the candidates, which word was meant? Jev answers
   a choice question with probabilities, which is exactly this. "Keep as
   spelled" is always an option, so names and unknown words survive.

If Jev is unreachable or slow, the best local candidate is used when it's
close enough, and otherwise the raw letters are spoken.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
WORDS_PATH = os.path.join(HERE, "models", "words.txt")
JEV_URL = "https://api.typesafe.ai/v1/systemone"
JEV_MODEL = "jev-latest"
JEV_TIMEOUT_S = 3.0
MAX_CANDIDATES = 12

# Everyday words a demo is likely to need that a web-frequency list ranks low.
EXTRA_WORDS = [
    "hi", "hey", "hello", "bye", "yes", "no", "ok", "okay", "please", "thanks", "thank", "sorry",
    "help", "water", "food", "bathroom", "name", "my", "is", "me", "you", "love", "good", "bad",
    "friend", "family", "where", "what", "who", "how", "why", "when", "stop", "wait", "go", "come",
]

# Terms that aren't in any dictionary but matter to this wearer. Jev is told
# what each one means, and acronyms are spoken letter by letter.
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


def _cost(signed: str, word: str) -> float:
    """Weighted edit distance (with adjacent swaps) from the signed letters to a word."""
    n, m = len(signed), len(word)

    def missing(j: int) -> float:
        return MISSING_DOUBLE if j > 1 and word[j - 1] == word[j - 2] else MISSING_LETTER

    d = [[0.0] * (m + 1) for _ in range(n + 1)]
    for j in range(1, m + 1):
        d[0][j] = d[0][j - 1] + missing(j)
    for i in range(1, n + 1):
        d[i][0] = d[i - 1][0] + EXTRA_LETTER
        for j in range(1, m + 1):
            a, b = signed[i - 1], word[j - 1]
            sub = 0.0 if a == b else SUB_CONFUSED if frozenset((a, b)) in CONFUSED else SUB_OTHER
            best = min(d[i - 1][j - 1] + sub, d[i - 1][j] + EXTRA_LETTER, d[i][j - 1] + missing(j))
            if i > 1 and j > 1 and a == word[j - 2] and signed[i - 2] == b and a != b:
                best = min(best, d[i - 2][j - 2] + SWAPPED)
            d[i][j] = best
    return d[n][m]


class WordDecoder:
    def __init__(self, api_key: str | None, extra_vocab: list[str] | None = None):
        self.api_key = api_key
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
        """Names the wearer uses (the wake name and aliases): candidates, and a hint for Jev."""
        self.names = [n for n in names if n and n.isalpha()]
        for n in self.names:
            self._rank.setdefault(n.upper(), 50)

    def candidates(self, letters: list[str]) -> list[tuple[str, float]]:
        signed = "".join(letters).upper()
        if not signed:
            return []
        scored = []
        for w, rank in self._rank.items():
            if abs(len(w) - len(signed)) > 3:
                continue
            c = _cost(signed, w)
            if c <= max(1.6, 0.45 * len(signed)):
                # Common words win ties: a tiny nudge by frequency rank.
                scored.append((w, c + rank / 40000))
        scored.sort(key=lambda t: t[1])
        return scored[:MAX_CANDIDATES]

    def decode(self, letters: list[str], previous_words: list[str]) -> dict:
        t0 = time.time()
        signed = "".join(letters).upper()
        cands = self.candidates(letters)
        result = {"raw": signed, "word": signed.lower(), "source": "raw", "confidence": 0.0,
                  "candidates": [_display(w) for w, _ in cands[:5]], "ms": 0, "error": None}
        if cands and self.api_key:
            try:
                word, conf = self._ask_jev(signed, [w for w, _ in cands], previous_words)
                result.update(word=word, source="jev", confidence=conf)
            except Exception as exc:  # network, 429, 529, timeout: fall back, never go silent
                result["error"] = f"jev: {exc}"
        if result["source"] == "raw" and cands and cands[0][1] <= max(1.0, 0.3 * len(signed)):
            result.update(word=_display(cands[0][0]), source="local", confidence=round(1 / (1 + cands[0][1]), 2))
        result["ms"] = int((time.time() - t0) * 1000)
        return result

    def _ask_jev(self, signed: str, cands: list[str], previous: list[str]) -> tuple[str, float]:
        keep = "__as_spelled__"
        criteria = {_display(w): (TERMS[w] if w in TERMS else f'the word "{w.lower()}"') for w in cands}
        criteria[keep] = f'none of these: keep the letters exactly as signed, "{signed.lower()}" (a name or an unusual word)'
        body = {
            "model": JEV_MODEL,
            "state": {
                "signed_letters": " ".join(signed),
                "words_already_said": " ".join(previous[-8:]) or "(start of the conversation)",
                "names_this_person_uses": ", ".join(self.names) or "(none known)",
                "places_and_terms_this_person_uses": "; ".join(TERMS.values()),
                "about_the_letters": (
                    "Letters come from a camera reading someone's fingerspelling, one letter at a time. "
                    "Doubled letters usually come out once, a stray letter can appear while the hand moves "
                    "between shapes, and similar handshapes get swapped (M/E, U/R, X/N, B/F, A/S/T/N/M)."
                ),
            },
            "questions": {"word": {
                "type": "choice",
                "instructions": (
                    "Which word was the signer most likely spelling, given the letters and what was already said? "
                    "If the letters spell a real word exactly, that word is almost always right. "
                    "Only choose a person's name when the letters are closer to it than to any word, or the sentence is introducing someone."
                ),
                "criteria": criteria,
            }},
        }
        req = urllib.request.Request(JEV_URL, data=json.dumps(body).encode(), headers={
            "Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=JEV_TIMEOUT_S) as r:
            ans = json.loads(r.read())["answers"]["word"]
        choice = ans["choice"]
        word = signed.lower() if choice == keep else choice
        return word, float(ans.get("probabilities", {}).get(choice, ans.get("confidence", 0.0)))


def _display(word: str) -> str:
    """Dictionary words lower-case, known terms (acronyms) as written."""
    return word if word in TERMS else word.lower()


def spoken_form(word: str) -> str:
    """What to hand to `say`: acronyms letter by letter ("U M B C"), the rest as is."""
    return " ".join(word) if word.upper() in TERMS and word.isupper() else word
