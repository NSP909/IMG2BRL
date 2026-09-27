import unittest
from unittest import mock

import numpy as np

from bridge.asl_cnn import normalize_landmarks, render_skeleton
from bridge.asl_mode import AslRecognizer


class _FakeCnn:
    def __init__(self):
        self.resets = 0

    def reset(self):
        self.resets += 1


class AslClassifierSelectorTests(unittest.TestCase):
    def test_switches_to_cnn_without_removing_legacy_state(self):
        recognizer = AslRecognizer(classifier="knn")
        recognizer._landmarker = object()
        recognizer._samples = [{"label": "a", "vector": [0.0]}]
        recognizer._cnn = _FakeCnn()
        recognizer.state.label = "a"
        recognizer.state.last_spoken = "a"

        self.assertTrue(recognizer.set_classifier("cnn"))
        self.assertEqual(recognizer.classifier, "cnn")
        self.assertEqual(recognizer.stable_needed, 4)
        self.assertIsNone(recognizer.state.label)
        self.assertIsNone(recognizer.state.last_spoken)
        self.assertEqual(recognizer._cnn.resets, 1)
        self.assertTrue(recognizer._samples)

    def test_failed_switch_leaves_old_classifier_active(self):
        recognizer = AslRecognizer(classifier="knn")
        recognizer._landmarker = object()
        recognizer.state.available = True

        with mock.patch.object(recognizer, "_ensure_classifier_locked", side_effect=RuntimeError("missing model")):
            self.assertFalse(recognizer.set_classifier("cnn"))

        self.assertEqual(recognizer.classifier, "knn")
        self.assertTrue(recognizer.state.available)
        self.assertEqual(recognizer.state.error, "missing model")

    def test_rejects_unknown_classifier(self):
        with self.assertRaises(ValueError):
            AslRecognizer(classifier="unknown")


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
