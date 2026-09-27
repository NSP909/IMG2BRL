"""Small skeleton-CNN runtime used by Bragi's ``cnn`` classifier.

The renderer, smoothing, motion rules, and model were adapted from
punpuniacitizen/MediaPipe-ASL-sign-language-recognition v1.1.  See
``THIRD_PARTY_NOTICES.md`` for its MIT notice and model-data provenance.
"""

from __future__ import annotations

import base64
from collections import deque
import os
import time

import cv2
import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(HERE, "models", "asl_cnn_model.onnx")
CLASS_NAMES = tuple("abcdefghijklmnopqrstuvwxyz")
CONFIDENCE_FLOOR = 0.50
COMMIT_CONFIDENCE = 0.75
SCORE_WINDOW = 8

CANVAS_SIZE = 192
MODEL_INPUT_SIZE = 96
HAND_FILL = 0.7
REFERENCE_CANVAS = 400

_WHITE = (224, 224, 224)
_RED, _PEACH, _PURPLE = (255, 48, 48), (255, 229, 180), (128, 64, 128)
_YELLOW, _GREEN, _BLUE, _GRAY = (255, 204, 0), (48, 255, 48), (21, 101, 192), (128, 128, 128)
_LANDMARK_STYLE = {
    0: (_RED, 5), 1: (_RED, 5), 5: (_RED, 5), 9: (_RED, 5), 13: (_RED, 5), 17: (_RED, 5),
    2: (_PEACH, 5), 3: (_PEACH, 5), 4: (_PEACH, 5),
    6: (_PURPLE, 5), 7: (_PURPLE, 5), 8: (_PURPLE, 5),
    10: (_YELLOW, 5), 11: (_YELLOW, 5), 12: (_YELLOW, 5),
    14: (_GREEN, 5), 15: (_GREEN, 5), 16: (_GREEN, 5),
    18: (_BLUE, 5), 19: (_BLUE, 5), 20: (_BLUE, 5),
}
_CONNECTION_STYLE = {
    (0, 1): (_GRAY, 3), (0, 5): (_GRAY, 3), (0, 17): (_GRAY, 3),
    (5, 9): (_GRAY, 3), (9, 13): (_GRAY, 3), (13, 17): (_GRAY, 3),
    (1, 2): (_PEACH, 2), (2, 3): (_PEACH, 2), (3, 4): (_PEACH, 2),
    (5, 6): (_PURPLE, 2), (6, 7): (_PURPLE, 2), (7, 8): (_PURPLE, 2),
    (9, 10): (_YELLOW, 2), (10, 11): (_YELLOW, 2), (11, 12): (_YELLOW, 2),
    (13, 14): (_GREEN, 2), (14, 15): (_GREEN, 2), (15, 16): (_GREEN, 2),
    (17, 18): (_BLUE, 2), (18, 19): (_BLUE, 2), (19, 20): (_BLUE, 2),
}


def normalize_landmarks(points_px: np.ndarray) -> np.ndarray:
    """Center a hand and preserve its aspect ratio on a normalized canvas."""
    points = np.asarray(points_px, dtype=np.float32)
    lo, hi = points.min(axis=0), points.max(axis=0)
    extent = hi - lo
    box_size = float(extent.max()) / HAND_FILL or 1.0
    origin = lo + extent / 2.0 - box_size / 2.0
    return ((points - origin) / box_size).astype(np.float32)


def _scaled(value: int, canvas_size: int) -> int:
    return max(1, int(round(value * canvas_size / REFERENCE_CANVAS)))


def render_skeleton(norm_points: np.ndarray, size: int = MODEL_INPUT_SIZE) -> np.ndarray:
    """Render the exact RGB skeleton representation used during CNN training."""
    canvas = np.zeros((CANVAS_SIZE, CANVAS_SIZE, 3), dtype=np.uint8)
    points = np.rint(np.asarray(norm_points, dtype=np.float32) * CANVAS_SIZE).astype(np.int32)
    for (start, end), (color, thickness) in _CONNECTION_STYLE.items():
        cv2.line(canvas, tuple(points[start]), tuple(points[end]), color,
                 _scaled(thickness, CANVAS_SIZE), cv2.LINE_AA)
    for index, (color, radius) in _LANDMARK_STYLE.items():
        center = tuple(points[index])
        radius = _scaled(radius, CANVAS_SIZE)
        cv2.circle(canvas, center, max(radius + 1, int(radius * 1.2)), _WHITE, -1, cv2.LINE_AA)
        cv2.circle(canvas, center, radius, color, -1, cv2.LINE_AA)
    return cv2.resize(canvas, (size, size), interpolation=cv2.INTER_AREA)


def _alpha(cutoff, dt):
    tau = 1.0 / (2.0 * np.pi * cutoff)
    return 1.0 / (1.0 + tau / dt)


class OneEuroFilter:
    """Adaptive landmark smoothing: steady at rest, responsive in motion."""

    def __init__(self, min_cutoff=0.8, beta=0.02, d_cutoff=1.0):
        self.min_cutoff, self.beta, self.d_cutoff = min_cutoff, beta, d_cutoff
        self.reset()

    def reset(self):
        self._x_prev = self._dx_prev = self._t_prev = None

    def __call__(self, value):
        value = np.asarray(value, dtype=np.float32)
        now = time.perf_counter()
        if self._x_prev is None:
            self._x_prev = value.copy()
            self._dx_prev = np.zeros_like(value)
            self._t_prev = now
            return value.copy()
        dt = float(np.clip(now - self._t_prev, 1e-3, 1.0))
        derivative = (value - self._x_prev) / dt
        derivative_alpha = _alpha(self.d_cutoff, dt)
        derivative_hat = derivative_alpha * derivative + (1.0 - derivative_alpha) * self._dx_prev
        cutoff = self.min_cutoff + self.beta * np.linalg.norm(derivative_hat, axis=-1, keepdims=True)
        alpha = _alpha(cutoff, dt)
        filtered = alpha * value + (1.0 - alpha) * self._x_prev
        self._x_prev, self._dx_prev, self._t_prev = filtered, derivative_hat, now
        return filtered


def _reversals(values, deadzone):
    sign = count = 0
    for value in values:
        if abs(value) < deadzone:
            continue
        current = 1 if value > 0 else -1
        if sign and current != sign:
            count += 1
        sign = current
    return count


class MotionTracker:
    """Rule-based J/Z trajectories from roughly 1.5 seconds of Bragi frames."""

    def __init__(self):
        self.buffer = deque(maxlen=15)

    def reset(self):
        self.buffer.clear()

    def update(self, points_px):
        points = np.asarray(points_px, dtype=np.float32)
        hand_size = float((points.max(axis=0) - points.min(axis=0)).max())
        if hand_size > 0:
            self.buffer.append(points / hand_size)

    def speed(self):
        if len(self.buffer) < 2:
            return 0.0
        wrists = np.stack([frame[0] for frame in list(self.buffer)[-4:]])
        return float(np.linalg.norm(np.diff(wrists, axis=0), axis=1).mean())

    def is_moving(self):
        return self.speed() > 0.035

    def _stats(self, index):
        if len(self.buffer) < 6:
            return None
        track = np.stack([frame[index] for frame in self.buffer])
        if len(track) >= 5:
            padded = np.pad(track, ((2, 2), (0, 0)), mode="edge")
            kernel = np.ones(5) / 5
            track = np.stack([np.convolve(padded[:, 0], kernel, "valid"),
                              np.convolve(padded[:, 1], kernel, "valid")], axis=1)[:len(track)]
        track -= track[0]
        steps = np.diff(track, axis=0)
        path = float(np.linalg.norm(steps, axis=1).sum())
        return {
            "path": path,
            "descent": float(track[:, 1].max() - track[0, 1]),
            "hook": float(abs(track[-1, 0] - track[np.argmax(track[:, 1]), 0])),
            "horizontal": float(track[:, 0].max() - track[:, 0].min()),
            "reversals": _reversals(steps[:, 0], max(path / 40.0, 1e-3)),
        }

    def resolve(self, static_label):
        label = (static_label or "").lower()
        if label in ("i", "j"):
            stats = self._stats(20)
            if stats and stats["path"] >= 0.55 and stats["descent"] >= 0.20 and stats["hook"] >= 0.12:
                return "j"
            return "i" if label == "j" and stats and stats["path"] < 0.55 else None
        if label in ("d", "z"):
            stats = self._stats(8)
            if stats and stats["path"] >= 0.55 and stats["reversals"] >= 2 and stats["horizontal"] >= 0.30:
                return "z"
            return "d" if label == "z" and stats and stats["path"] < 0.55 else None
        return None


class CnnClassifier:
    """ONNX inference over skeletons built from MediaPipe's 21 landmarks."""

    def __init__(self, model_path: str = MODEL_PATH):
        if not os.path.exists(model_path):
            raise FileNotFoundError(f"ASL CNN model not found: {model_path}")
        try:
            import onnxruntime as ort
        except ImportError as exc:
            raise RuntimeError("CNN classifier needs onnxruntime; install bridge/requirements.txt") from exc
        self.session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = "logits" if any(o.name == "logits" for o in self.session.get_outputs()) else self.session.get_outputs()[0].name
        input_size = self.session.get_inputs()[0].shape[1]
        self.input_size = input_size if isinstance(input_size, int) else MODEL_INPUT_SIZE
        self.scores = deque(maxlen=SCORE_WINDOW)
        self.smoother = OneEuroFilter()
        self.motion = MotionTracker()
        self.skeleton_image = None
        self.predictions = []

    def reset(self):
        self.scores.clear()
        self.smoother.reset()
        self.motion.reset()
        self.skeleton_image = None
        self.predictions = []

    def classify(self, landmarks, frame_shape):
        height, width = frame_shape[:2]
        points = np.asarray([(p.x * width, p.y * height) for p in landmarks], dtype=np.float32)
        points = self.smoother(points)
        self.motion.update(points)
        image = render_skeleton(normalize_landmarks(points), self.input_size)
        ok, encoded = cv2.imencode(".png", cv2.cvtColor(image, cv2.COLOR_RGB2BGR))
        self.skeleton_image = (
            "data:image/png;base64," + base64.b64encode(encoded).decode("ascii")
            if ok else None
        )
        logits = self.session.run([self.output_name], {self.input_name: image.astype(np.float32)[None, ...]})[0][0]
        exponentials = np.exp(logits - logits.max())
        self.scores.append(exponentials / exponentials.sum())
        scores = np.mean(self.scores, axis=0)
        index = int(np.argmax(scores))
        self.predictions = [
            {"label": CLASS_NAMES[int(i)].upper(), "confidence": round(float(scores[int(i)]), 3)}
            for i in np.argsort(scores)[::-1][:3]
        ]
        letter, confidence = CLASS_NAMES[index], float(scores[index])
        resolved = self.motion.resolve(letter)
        return resolved or letter, confidence, self.motion.is_moving()
