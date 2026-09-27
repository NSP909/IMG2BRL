"""ASL fingerspelling -> speech, used by ``detect_bridge.py`` when the camera
is switched into ``asl`` mode. Same camera as Rune's object/text detection;
this module just interprets the frame differently and speaks locally instead
of enqueueing braille -- Bragi answers to a bystander near the wearer, not to
the wearer's own finger, so it never touches the braille queue.

One MediaPipe HandLandmarker pass per frame feeds one of three selectable
classifiers: a small ONNX skeleton CNN (26 letters, J/Z from motion; see
asl_cnn.py), the personal KNN over recorded samples, or the geometric rules.
Whichever is active, a recorded SPACE sign is checked first against the KNN
samples, so every classifier can end a word the same way.
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import threading
import time
import urllib.request
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(HERE, "models", "hand_landmarker.task")
MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
SAMPLES_PATH = os.path.join(HERE, "models", "asl_samples.json")
# Recorded through the bridge's own feed (the Pi camera on the rig), so they
# match what the classifier actually sees in use. See AslRecognizer.start_recording.
PI_SAMPLES_PATH = os.path.join(HERE, "models", "asl_samples_pi.json")
LETTERS = list("ABCDEFGHIKLMNOPQRSTUVWXY")  # the 24 static letters; J and Z need motion
SPACE = "SPACE"  # a recorded sign (the open "5" hand by default) that ends a word
RECORDABLE = LETTERS + [SPACE]
SAMPLE_SETS = ("laptop", "pi", "both")

# MediaPipe Hands landmark indices (same across every language binding).
WRIST = 0
THUMB_TIP, THUMB_IP = 4, 3
INDEX_MCP, INDEX_PIP, INDEX_TIP = 5, 6, 8
MIDDLE_MCP, MIDDLE_PIP, MIDDLE_TIP = 9, 10, 12
RING_MCP, RING_PIP, RING_TIP = 13, 14, 16
PINKY_MCP, PINKY_PIP, PINKY_TIP = 17, 18, 20


class AslSetupError(RuntimeError):
    pass


def _dist(a, b) -> float:
    return math.dist((a.x, a.y, a.z), (b.x, b.y, b.z))


def _angle_deg(a, vertex, b) -> float:
    v1 = np.array([a.x - vertex.x, a.y - vertex.y, a.z - vertex.z])
    v2 = np.array([b.x - vertex.x, b.y - vertex.y, b.z - vertex.z])
    denom = np.linalg.norm(v1) * np.linalg.norm(v2) or 1.0
    cos = np.clip(np.dot(v1, v2) / denom, -1.0, 1.0)
    return math.degrees(math.acos(cos))


def _curl_state(mcp, pip, tip) -> str:
    """'E' extended, 'H' half-bent, 'C' curled -- same thresholds as the browser version."""
    angle = _angle_deg(mcp, pip, tip)
    if angle > 155:
        return "E"
    if angle < 95:
        return "C"
    return "H"


def normalize_vector(landmarks) -> list[float]:
    """Wrist-relative, scaled by wrist->middle-MCP distance. Matches
    normalizeVector() in the browser app exactly, so the recorded samples
    (captured there) are directly comparable here."""
    wrist = landmarks[WRIST]
    scale = _dist(wrist, landmarks[MIDDLE_MCP]) or 1.0
    vec: list[float] = []
    for p in landmarks:
        vec.append((p.x - wrist.x) / scale)
        vec.append((p.y - wrist.y) / scale)
        vec.append((p.z - wrist.z) / scale)
    return vec


def heuristic_classify(landmarks) -> Optional[str]:
    """The zero-training-data fallback: 19 letters from finger-curl geometry.
    Direct port of heuristicClassify() in the browser app."""
    wrist = landmarks[WRIST]
    scale = _dist(wrist, landmarks[MIDDLE_MCP]) or 1.0

    idx = _curl_state(landmarks[INDEX_MCP], landmarks[INDEX_PIP], landmarks[INDEX_TIP])
    mid = _curl_state(landmarks[MIDDLE_MCP], landmarks[MIDDLE_PIP], landmarks[MIDDLE_TIP])
    ring = _curl_state(landmarks[RING_MCP], landmarks[RING_PIP], landmarks[RING_TIP])
    pinky = _curl_state(landmarks[PINKY_MCP], landmarks[PINKY_PIP], landmarks[PINKY_TIP])

    thumb_out = _dist(landmarks[THUMB_TIP], landmarks[INDEX_MCP]) / scale > 1.0
    index_middle_spread = _dist(landmarks[INDEX_TIP], landmarks[MIDDLE_TIP]) / scale
    thumb_index_touch = _dist(landmarks[THUMB_TIP], landmarks[INDEX_TIP]) / scale < 0.4

    col_dists = [
        abs(landmarks[THUMB_TIP].x - landmarks[INDEX_PIP].x),
        abs(landmarks[THUMB_TIP].x - landmarks[MIDDLE_PIP].x),
        abs(landmarks[THUMB_TIP].x - landmarks[RING_PIP].x),
    ]
    nearest_col = col_dists.index(min(col_dists))
    thumb_rel_y = (landmarks[THUMB_TIP].y - landmarks[INDEX_PIP].y) / scale
    thumb_ahead = landmarks[THUMB_TIP].z < landmarks[INDEX_PIP].z - 0.02

    dx = landmarks[MIDDLE_MCP].x - wrist.x
    dy = landmarks[MIDDLE_MCP].y - wrist.y
    hand_sideways = abs(math.degrees(math.atan2(dx, -dy))) > 45

    if idx == "E" and mid == "E" and ring == "E" and pinky == "E":
        return None if thumb_out else "B"
    if idx == "H" and mid == "H" and ring == "H" and pinky == "H":
        return "O" if thumb_index_touch else "C"
    if idx == "H" and mid == "C" and ring == "C" and pinky == "C":
        return "X"
    if thumb_index_touch and mid == "E" and ring == "E" and pinky == "E":
        return "F"
    if idx == "E" and mid == "E" and ring == "C" and pinky == "C":
        if thumb_out:
            return "K"
        if hand_sideways:
            return "H"
        return "V" if index_middle_spread > 0.5 else "U"
    if idx == "E" and mid == "E" and ring == "E" and pinky == "C":
        return "W"
    if idx == "E" and mid == "C" and ring == "C" and pinky == "C":
        return "L" if thumb_out else "D"
    if idx == "C" and mid == "C" and ring == "C" and pinky == "E":
        return "Y" if thumb_out else "I"
    if idx == "C" and mid == "C" and ring == "C" and pinky == "C" and not thumb_out:
        if nearest_col == 0:
            return "A" if thumb_rel_y > 0.15 else "S"
        if nearest_col == 1:
            return "T" if thumb_ahead else "N"
        return "M"
    return None


@dataclass
class AslState:
    label: Optional[str] = None
    stable_count: int = 0
    # Last sign confirmed (a letter or SPACE). A sign isn't confirmed twice in
    # a row, so a held shape doesn't repeat; doubled letters are left for the
    # word decoder to restore ("HELO" -> hello).
    last_letter: Optional[str] = None
    error: Optional[str] = None
    available: bool = False
    hand_visible: bool = False
    # The CNN's smoothed confidence, and whether the hand is mid-motion (the
    # CNN won't commit a letter while it moves, which is also how it reads J/Z).
    confidence: float = 0.0
    moving: bool = False
    # The 21 hand points in the upright displayed frame (0-1), for the camera
    # overlay; the exact skeleton image the CNN sees (a PNG data URL); and the
    # top guesses as {"label", "confidence"}.
    hand: Optional[list] = None
    skeleton_image: Optional[str] = None
    predictions: list = field(default_factory=list)
    # The word being spelled: letters since the last SPACE.
    word_letters: list = field(default_factory=list)
    recording: Optional[str] = None
    record_progress: int = 0
    record_target: int = 0
    record_into: str = "pi"
    sample_set: str = "laptop"
    pi_counts: dict = field(default_factory=dict)
    laptop_counts: dict = field(default_factory=dict)


class AslRecognizer:
    """Owns the MediaPipe HandLandmarker, the selectable letter classifier,
    the KNN sample sets, and per-pass stability: a sign is only confirmed once
    it has held for a few passes. Letters build up a word; SPACE ends it."""

    CLASSIFIERS = ("cnn", "knn", "geometric")
    CNN_SHOW, CNN_COMMIT = 0.50, 0.75  # confidence to display a letter / to count it

    def __init__(self, classifier: str = "cnn", stable_passes: int = 2,
                 cnn_stable_passes: int = 3, k: int = 5):
        if classifier not in self.CLASSIFIERS:
            raise ValueError(f"unknown ASL classifier: {classifier}")
        self.classifier = classifier
        self.stable_passes = stable_passes
        self.cnn_stable_passes = cnn_stable_passes
        self.k = k
        self.state = AslState()
        self._landmarker = None
        self._cnn = None
        self._samples: list[dict] = []
        self._vecs = np.zeros((0, 63), dtype=np.float32)
        self._labels: list[str] = []
        self._laptop_samples: list[dict] = []
        self._pi_samples: list[dict] = []
        self._record_buffer: list[list[float]] = []
        self._last_ts_ms = 0
        self._display_filter = None  # One-Euro smoothing for the on-screen skeleton only
        self._lock = threading.RLock()

    @property
    def stable_needed(self) -> int:
        """The CNN runs several times faster, so it needs more passes for the same hold."""
        return self.cnn_stable_passes if self.classifier == "cnn" else self.stable_passes

    # -- setup ---------------------------------------------------------
    def ensure_loaded(self) -> None:
        with self._lock:
            self._ensure_loaded_locked()

    def _ensure_loaded_locked(self) -> None:
        if self._landmarker is not None:
            return
        try:
            _download_model_if_missing()
            from mediapipe.tasks.python import BaseOptions
            from mediapipe.tasks.python.vision import (
                HandLandmarker,
                HandLandmarkerOptions,
                RunningMode,
            )

            options = HandLandmarkerOptions(
                # CPU, explicitly: the GPU/Metal delegate crashed outright in
                # testing on this machine (mediapipe 1.0.1's macOS GPU path),
                # so don't leave it to the (GPU-leaning) default.
                base_options=BaseOptions(model_asset_path=MODEL_PATH, delegate=BaseOptions.Delegate.CPU),
                # VIDEO mode tracks the hand between frames instead of finding
                # it from scratch each time: steadier landmarks, and faster.
                running_mode=RunningMode.VIDEO,
                num_hands=1,
            )
            self._landmarker = HandLandmarker.create_from_options(options)
            self._laptop_samples = _load_samples(SAMPLES_PATH)
            self._pi_samples = _load_samples(PI_SAMPLES_PATH)
            # The bridge then matches this to the active camera
            # (detect_bridge.match_asl_samples_to_camera).
            self.state.sample_set = "pi" if self._pi_samples else "laptop"
            self._rebuild_samples()
            if self.classifier == "cnn":
                self._load_cnn()
            self.state.available = True
            self.state.error = None
        except Exception as exc:  # surfaced to STATE["asl"]["error"], not raised into detect_loop
            self.state.available = False
            self.state.error = str(exc)

    def _load_cnn(self) -> None:
        if self._cnn is None:
            try:
                from .asl_cnn import CnnClassifier
            except ImportError:  # detect_bridge.py runs as a plain script too
                from asl_cnn import CnnClassifier
            self._cnn = CnnClassifier()

    def reload_cnn(self) -> None:
        """Pick up a newly trained model file (e.g. after teaching it SPACE)."""
        with self._lock:
            self._cnn = None
            self._load_cnn()
            self._reset_reading()

    def set_classifier(self, classifier: str) -> bool:
        """Load and switch atomically; a model that fails to load leaves the old one active."""
        if classifier not in self.CLASSIFIERS:
            raise ValueError(f"unknown ASL classifier: {classifier}")
        with self._lock:
            try:
                if classifier == "cnn":
                    self._load_cnn()
            except Exception as exc:
                self.state.error = str(exc)
                return False
            self.classifier = classifier
            self._reset_reading()
            self.state.error = None
            return True

    def _reset_reading(self) -> None:
        self.state.label, self.state.stable_count, self.state.last_letter = None, 0, None
        self.state.confidence, self.state.moving = 0.0, False
        self.state.hand, self.state.skeleton_image, self.state.predictions = None, None, []
        if self._display_filter is not None:
            self._display_filter.reset()
        if self._cnn is not None:
            self._cnn.reset()

    # -- per-frame -------------------------------------------------------
    def process(self, frame_bgr, rotate: int = 0) -> Optional[tuple[str, object]]:
        """One camera frame in. Returns ("letter", "H") when a letter is
        confirmed, ("word", ["H", "E", ...]) when SPACE ends a word, or None
        most passes. Also updates self.state for the status panel.

        `rotate` is how far clockwise this frame must turn to be upright (the
        Pi's raw frames are sideways). Detection, the KNN and recording use the
        frame as given, which is how the samples were recorded; only the CNN,
        trained on upright hands, gets its points turned upright."""
        if self._landmarker is None:
            self.ensure_loaded()
        if self._landmarker is None:
            return None
        import mediapipe as mp

        rgb = frame_bgr[:, :, ::-1].copy()
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        # VIDEO mode needs strictly increasing timestamps, whichever camera feeds it.
        self._last_ts_ms = max(self._last_ts_ms + 1, int(time.monotonic() * 1000))
        result = self._landmarker.detect_for_video(image, self._last_ts_ms)
        self.state.hand_visible = bool(result.hand_landmarks)
        if not result.hand_landmarks:
            # Dropping the hand out of view and back is how to sign a doubled
            # letter on purpose, so it clears the no-repeat rule.
            self._reset_reading()
            return None

        landmarks = result.hand_landmarks[0]
        self._publish_hand(landmarks, frame_bgr.shape, rotate)
        if self.state.recording:
            self._record(normalize_vector(landmarks))
            return None
        sign, confidence, moving = self._classify(landmarks, frame_bgr.shape, rotate)
        # The CNN's own readings, SPACE included, go through its confidence
        # and stillness gate; the recorded-SPACE override arrives at 1.0.
        cnn = self.classifier == "cnn"
        shown = sign if not cnn or confidence >= self.CNN_SHOW else None
        counted = shown if not cnn or (confidence >= self.CNN_COMMIT and not moving) else None
        self.state.confidence, self.state.moving = confidence, moving

        if counted and counted == self.state.label:
            self.state.stable_count += 1
        elif counted:
            self.state.stable_count = 1
        else:
            self.state.stable_count = 0
        self.state.label = shown

        if not shown:
            self.state.last_letter = None
            return None
        sign = counted
        if not sign or self.state.stable_count != self.stable_needed or sign == self.state.last_letter:
            return None
        self.state.last_letter = sign
        if sign == SPACE:
            return ("word", self.take_word()) if self.state.word_letters else None
        with self._lock:
            self.state.word_letters = self.state.word_letters + [sign]
        return ("letter", sign)

    def _publish_hand(self, landmarks, frame_shape, rotate: int) -> None:
        h, w = frame_shape[:2]
        if self._display_filter is None:
            try:
                from .asl_cnn import OneEuroFilter
            except ImportError:
                from asl_cnn import OneEuroFilter
            self._display_filter = OneEuroFilter()
        # Smoothed for display (steady at rest, quick in motion), like the CNN's own input.
        pts = self._display_filter(_upright_points(landmarks, frame_shape, rotate))
        disp_w, disp_h = (h, w) if rotate in (90, 270) else (w, h)
        self.state.hand = [[round(float(x) / disp_w, 4), round(float(y) / disp_h, 4)] for x, y in pts]

    def _classify(self, landmarks, frame_shape, rotate: int) -> tuple[Optional[str], float, bool]:
        vec = normalize_vector(landmarks)
        # The recorded SPACE sign wins regardless of classifier, so any of them
        # can end a word. KNN over the whole active set, so SPACE only wins
        # when it's closer than every letter, not just close-ish.
        cnn = None
        if self.classifier == "cnn":
            # Always run it, even when SPACE wins, so its smoothing and motion
            # tracking stay continuous and the AI view keeps updating.
            cnn = self._cnn.classify_points(_upright_points(landmarks, frame_shape, rotate))
            self.state.skeleton_image = getattr(self._cnn, "skeleton_image", None)
            self.state.predictions = list(getattr(self._cnn, "predictions", []))
        else:
            self.state.skeleton_image = None
        if SPACE in self._labels:
            votes = self._knn_votes(vec)
            if votes and votes[0][0] == SPACE:
                self.state.predictions = _as_predictions(votes)
                return SPACE, 1.0, False
        if cnn is not None:
            letter, confidence, moving = cnn
            return letter.upper(), confidence, moving
        if self.classifier == "geometric":
            letter = heuristic_classify(landmarks)
            self.state.predictions = _as_predictions([[letter, 1.0]] if letter else [])
            return letter, 1.0, False
        votes = self._knn_votes(vec)
        self.state.predictions = _as_predictions(votes)
        return (votes[0][0] if votes else None), 1.0, False

    def _knn_votes(self, vec: list[float]) -> list:
        """Nearest-neighbour vote shares, best first: [[sign, share], ...]."""
        if not self._labels:
            return []
        d = np.linalg.norm(self._vecs - np.asarray(vec, dtype=np.float32), axis=1)
        votes: dict[str, int] = {}
        nearest = np.argsort(d)[: self.k]
        for i in nearest:
            votes[self._labels[i]] = votes.get(self._labels[i], 0) + 1
        ranked = sorted(votes.items(), key=lambda kv: -kv[1])
        return [[label, round(n / len(nearest), 3)] for label, n in ranked]

    def _knn(self, vec: list[float]) -> Optional[str]:
        votes = self._knn_votes(vec)
        return votes[0][0] if votes else None

    # -- the word being spelled -------------------------------------------
    def take_word(self) -> list[str]:
        with self._lock:
            letters, self.state.word_letters = self.state.word_letters, []
        return letters

    def backspace(self) -> None:
        with self._lock:
            self.state.word_letters = self.state.word_letters[:-1]
            self.state.last_letter = None

    # -- recording -------------------------------------------------------
    def start_recording(self, sign: str, count: int, into: str = "pi") -> None:
        if sign not in RECORDABLE:
            raise ValueError(f"{sign!r} is not one of the 24 static letters or SPACE")
        if into not in ("pi", "laptop"):
            raise ValueError("record into 'pi' or 'laptop'")
        with self._lock:
            self._record_buffer = []
            self.state.record_progress, self.state.record_target = 0, count
            self.state.label, self.state.stable_count = None, 0
            self.state.record_into = into
            self.state.recording = sign

    def cancel_recording(self) -> None:
        with self._lock:
            self._record_buffer = []
            self.state.recording, self.state.record_progress = None, 0

    def set_sample_set(self, name: str) -> None:
        if name not in SAMPLE_SETS:
            raise ValueError(f"sample set must be one of {SAMPLE_SETS}")
        with self._lock:
            self.state.sample_set = name
            self._rebuild_samples()

    def clear_recorded(self, sign: Optional[str] = None) -> None:
        """Drop Pi samples for one sign, or all of them."""
        with self._lock:
            self._pi_samples = [s for s in self._pi_samples if sign and s["label"] != sign]
            _save_samples(PI_SAMPLES_PATH, self._pi_samples)
            self._rebuild_samples()

    def _record(self, vec: list[float]) -> None:
        with self._lock:
            sign = self.state.recording
            if not sign:
                return
            self._record_buffer.append(vec)
            self.state.record_progress = len(self._record_buffer)
            if self.state.record_progress < self.state.record_target:
                return
            # A fresh take replaces the old one for that sign, never mixes with it.
            fresh = [{"label": sign, "vector": v} for v in self._record_buffer]
            if self.state.record_into == "laptop":
                self._laptop_samples = [s for s in self._laptop_samples if s["label"] != sign] + fresh
                _save_samples(SAMPLES_PATH, self._laptop_samples)
            else:
                self._pi_samples = [s for s in self._pi_samples if s["label"] != sign] + fresh
                _save_samples(PI_SAMPLES_PATH, self._pi_samples)
            self._record_buffer = []
            self.state.recording = None
            self._rebuild_samples()

    def _rebuild_samples(self) -> None:
        sets = {"laptop": self._laptop_samples, "pi": self._pi_samples,
                "both": self._laptop_samples + self._pi_samples}
        self._samples = sets[self.state.sample_set]
        self._vecs = np.asarray([s["vector"] for s in self._samples], dtype=np.float32).reshape(-1, 63)
        self._labels = [s["label"] for s in self._samples]
        self.state.pi_counts = _count(self._pi_samples)
        self.state.laptop_counts = _count(self._laptop_samples)


def _count(samples: list[dict]) -> dict:
    counts: dict[str, int] = {}
    for s in samples:
        counts[s["label"]] = counts.get(s["label"], 0) + 1
    return counts


def _as_predictions(votes: list) -> list:
    return [{"label": label, "confidence": share} for label, share in votes[:3]]


def _upright_points(landmarks, frame_shape, rotate: int) -> np.ndarray:
    """Landmarks as pixel points, turned `rotate` degrees clockwise (like cv2.rotate)."""
    h, w = frame_shape[:2]
    x = np.asarray([p.x for p in landmarks], dtype=np.float32) * w
    y = np.asarray([p.y for p in landmarks], dtype=np.float32) * h
    if rotate == 90:
        x, y = h - y, x
    elif rotate == 180:
        x, y = w - x, h - y
    elif rotate == 270:
        x, y = y, w - x
    return np.stack([x, y], axis=1)


def _load_samples(path: str) -> list[dict]:
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return []


def _save_samples(path: str, samples: list[dict]) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(samples, f)
    os.replace(tmp, path)


def _download_model_if_missing() -> None:
    if os.path.exists(MODEL_PATH):
        return
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)


def speak(text: str) -> None:
    """Fire-and-forget local speech via macOS `say` -- zero cost, no network,
    and never blocks detect_loop waiting for the utterance to finish."""
    try:
        subprocess.Popen(["say", text], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except FileNotFoundError:
        pass  # not on macOS; ASL mode still runs, it just won't speak
