"""ASL fingerspelling -> speech, used by ``detect_bridge.py`` when the camera
is switched into ``asl`` mode. Same camera as Rune's object/text detection;
this module just interprets the frame differently and speaks locally instead
of enqueueing braille -- Bragi answers to a bystander near the wearer, not to
the wearer's own finger, so it never touches the braille queue.

MediaPipe hand landmarks feed three selectable classifiers: the original
1,440-sample personal KNN, the original geometric rules, and a small ONNX CNN
that sees a normalized rendering of the 21 landmarks. Only one classifier is
active at a time; switching never removes or rewrites the older implementations.
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import threading
import urllib.request
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(HERE, "models", "hand_landmarker.task")
MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
SAMPLES_PATH = os.path.join(HERE, "models", "asl_samples.json")

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
    last_spoken: Optional[str] = None
    speaking: bool = False
    error: Optional[str] = None
    available: bool = False
    confidence: float = 0.0
    moving: bool = False


class AslRecognizer:
    """Shared hand detector plus a live-selectable letter classifier."""

    CLASSIFIERS = ("cnn", "knn", "geometric")

    def __init__(self, classifier: str = "cnn", stable_passes: int = 2,
                 cnn_stable_passes: int = 4, k: int = 5):
        if classifier not in self.CLASSIFIERS:
            raise ValueError(f"unknown ASL classifier: {classifier}")
        self.classifier = classifier
        self.stable_passes = stable_passes
        self.cnn_stable_passes = cnn_stable_passes
        self.k = k
        self.state = AslState()
        self._landmarker = None
        self._cnn_hands = None
        self._samples: list[dict] = []
        self._cnn = None
        self._lock = threading.RLock()

    @property
    def stable_needed(self) -> int:
        return self.cnn_stable_passes if self.classifier == "cnn" else self.stable_passes

    # -- setup ---------------------------------------------------------
    def ensure_loaded(self) -> None:
        with self._lock:
            try:
                self._ensure_detector_locked(self.classifier)
                self._ensure_classifier_locked(self.classifier)
                self.state.available = True
                self.state.error = None
            except Exception as exc:  # surfaced to STATE["asl"]["error"], not raised into detect_loop
                self.state.available = False
                self.state.error = str(exc)

    def _ensure_loaded_locked(self) -> None:
        if self._landmarker is not None:
            return
        _download_model_if_missing()
        from mediapipe.tasks.python import BaseOptions
        from mediapipe.tasks.python.vision import HandLandmarker, HandLandmarkerOptions, RunningMode

        options = HandLandmarkerOptions(
            # CPU, explicitly: the GPU/Metal delegate crashed outright in
            # testing on this machine (mediapipe 1.0.1's macOS GPU path).
            base_options=BaseOptions(model_asset_path=MODEL_PATH, delegate=BaseOptions.Delegate.CPU),
            running_mode=RunningMode.IMAGE,
            num_hands=1,
        )
        self._landmarker = HandLandmarker.create_from_options(options)

    def _ensure_detector_locked(self, classifier: str) -> None:
        if classifier != "cnn":
            self._ensure_loaded_locked()
            return
        if self._cnn_hands is not None:
            return
        import mediapipe as mp
        if not hasattr(mp, "solutions"):
            raise RuntimeError("Small CNN needs mediapipe==0.10.21; reinstall bridge/requirements.txt")
        self._cnn_hands = mp.solutions.hands.Hands(
            model_complexity=1,
            max_num_hands=1,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        )

    def _ensure_classifier_locked(self, classifier: str) -> None:
        if classifier == "knn" and not self._samples:
            self._samples = _load_samples()
        elif classifier == "cnn" and self._cnn is None:
            try:
                from .asl_cnn import CnnClassifier
            except ImportError:  # detect_bridge.py is also supported as a direct script
                from asl_cnn import CnnClassifier
            self._cnn = CnnClassifier()

    def set_classifier(self, classifier: str) -> bool:
        """Load and switch atomically. A failed new model leaves the old one active."""
        if classifier not in self.CLASSIFIERS:
            raise ValueError(f"unknown ASL classifier: {classifier}")
        with self._lock:
            try:
                self._ensure_detector_locked(classifier)
                self._ensure_classifier_locked(classifier)
            except Exception as exc:
                self.state.error = str(exc)
                return False
            self.classifier = classifier
            self._reset_state_locked()
            self.state.available = True
            self.state.error = None
            return True

    def _reset_state_locked(self) -> None:
        self.state.label = None
        self.state.stable_count = 0
        self.state.last_spoken = None
        self.state.confidence = 0.0
        self.state.moving = False
        if self._cnn is not None:
            self._cnn.reset()

    # -- per-frame -------------------------------------------------------
    def process(self, frame_bgr) -> Optional[str]:
        """One camera frame in, a newly-*confirmed* stable letter out (or
        None most passes). Also updates self.state for the status panel."""
        with self._lock:
            detector = self._cnn_hands if self.classifier == "cnn" else self._landmarker
            if detector is None:
                self.ensure_loaded()
                detector = self._cnn_hands if self.classifier == "cnn" else self._landmarker
            if detector is None or not self.state.available:
                return None

            rgb = frame_bgr[:, :, ::-1].copy()
            if self.classifier == "cnn":
                result = self._cnn_hands.process(rgb)
                hands = result.multi_hand_landmarks or []
                landmarks = hands[0].landmark if hands else None
            else:
                import mediapipe as mp
                image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                result = self._landmarker.detect(image)
                landmarks = result.hand_landmarks[0] if result.hand_landmarks else None
            if landmarks is None:
                self._reset_state_locked()
                return None

            letter, confidence, moving = self._classify(landmarks, frame_bgr.shape)
            visible = letter if confidence >= (0.50 if self.classifier == "cnn" else 0.0) else None
            candidate = visible if confidence >= (0.75 if self.classifier == "cnn" else 0.0) and not moving else None
            previous = self.state.label
            self.state.label = visible
            self.state.confidence = confidence
            self.state.moving = moving

            if candidate and candidate == previous:
                self.state.stable_count += 1
            elif candidate:
                self.state.stable_count = 1
            else:
                self.state.stable_count = 0

            if candidate and self.state.stable_count == self.stable_needed and candidate != self.state.last_spoken:
                self.state.last_spoken = candidate
                return candidate
            if not visible:
                self.state.last_spoken = None
            return None

    def _classify(self, landmarks, frame_shape) -> tuple[Optional[str], float, bool]:
        if self.classifier == "cnn":
            return self._cnn.classify(landmarks, frame_shape)
        if self.classifier == "geometric":
            return heuristic_classify(landmarks), 1.0, False
        vec = normalize_vector(landmarks)
        return _knn_classify(vec, self._samples, self.k), 1.0, False


def _knn_classify(vec: list[float], samples: list[dict], k: int) -> Optional[str]:
    if not samples:
        return None
    arr = np.asarray(vec)
    ranked = sorted(samples, key=lambda s: float(np.linalg.norm(arr - np.asarray(s["vector"]))))
    top = ranked[: min(k, len(ranked))]
    votes: dict[str, int] = {}
    for s in top:
        votes[s["label"]] = votes.get(s["label"], 0) + 1
    return max(votes.items(), key=lambda kv: kv[1])[0]


def _load_samples() -> list[dict]:
    with open(SAMPLES_PATH) as f:
        return json.load(f)


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
