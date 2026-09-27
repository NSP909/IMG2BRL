import unittest
from types import SimpleNamespace
from unittest import mock

import numpy as np

from bridge.asl_cnn import normalize_landmarks, render_skeleton
from bridge.asl_mode import SPACE, AslRecognizer, _upright_points


class _FakeCnn:
    def __init__(self, letter="b", confidence=0.9, moving=False):
        self.resets = 0
        self.result = (letter, confidence, moving)

    def reset(self):
        self.resets += 1

    def classify_points(self, points):
        return self.result


def _hand(offset=0.0):
    return [SimpleNamespace(x=0.3 + 0.01 * i + offset, y=0.6 - 0.02 * i, z=0.0) for i in range(21)]


class AslClassifierSelectorTests(unittest.TestCase):
    def test_switches_to_cnn_without_removing_legacy_state(self):
        recognizer = AslRecognizer(classifier="knn")
        recognizer._landmarker = object()
        recognizer._samples = [{"label": "A", "vector": [0.0]}]
        recognizer._cnn = _FakeCnn()
        recognizer.state.label = "A"
        recognizer.state.last_letter = "A"

        self.assertTrue(recognizer.set_classifier("cnn"))
        self.assertEqual(recognizer.classifier, "cnn")
        self.assertEqual(recognizer.stable_needed, 3)
        self.assertIsNone(recognizer.state.label)
        self.assertIsNone(recognizer.state.last_letter)
        self.assertEqual(recognizer._cnn.resets, 1)
        self.assertTrue(recognizer._samples)

    def test_failed_switch_leaves_old_classifier_active(self):
        recognizer = AslRecognizer(classifier="knn")
        recognizer._landmarker = object()
        recognizer.state.available = True

        with mock.patch.object(recognizer, "_load_cnn", side_effect=RuntimeError("missing model")):
            self.assertFalse(recognizer.set_classifier("cnn"))

        self.assertEqual(recognizer.classifier, "knn")
        self.assertTrue(recognizer.state.available)
        self.assertEqual(recognizer.state.error, "missing model")

    def test_rejects_unknown_classifier(self):
        with self.assertRaises(ValueError):
            AslRecognizer(classifier="unknown")


class CnnWiringTests(unittest.TestCase):
    def test_cnn_letters_are_uppercased_for_the_word_buffer(self):
        recognizer = AslRecognizer(classifier="cnn")
        recognizer._cnn = _FakeCnn("h", 0.95)
        self.assertEqual(recognizer._classify(_hand(), (720, 1280, 3), 90)[0], "H")

    def test_recorded_space_wins_over_the_cnn(self):
        recognizer = AslRecognizer(classifier="cnn", k=3)
        recognizer._cnn = _FakeCnn("b", 0.99)
        from bridge.asl_mode import normalize_vector
        space = normalize_vector(_hand())
        letter = normalize_vector(_hand(offset=0.2))
        recognizer._laptop_samples = [{"label": SPACE, "vector": space}] * 5 + [{"label": "B", "vector": [v * 3 for v in letter]}] * 5
        recognizer.state.sample_set = "laptop"
        recognizer._rebuild_samples()
        self.assertEqual(recognizer._classify(_hand(), (720, 1280, 3), 0)[0], SPACE)

    def test_points_turn_upright_like_cv2_rotate(self):
        hand = [SimpleNamespace(x=0.25, y=0.5, z=0.0)] * 21
        # A 1280x720 frame rotated 90 clockwise is 720x1280: (320, 360) -> (720-360, 320).
        np.testing.assert_allclose(_upright_points(hand, (720, 1280, 3), 90)[0], [360.0, 320.0])
        np.testing.assert_allclose(_upright_points(hand, (720, 1280, 3), 0)[0], [320.0, 360.0])


class SkeletonRendererTests(unittest.TestCase):
    def test_renderer_produces_model_input(self):
        points = np.stack((np.linspace(10, 90, 21), np.linspace(20, 80, 21)), axis=1)
        normalized = normalize_landmarks(points)
        image = render_skeleton(normalized)

        self.assertEqual(image.shape, (96, 96, 3))
        self.assertEqual(image.dtype, np.uint8)
        self.assertGreater(int(image.max()), 0)


if __name__ == "__main__":
    unittest.main()
