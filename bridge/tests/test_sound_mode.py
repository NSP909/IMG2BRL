import unittest

import numpy as np

from bridge.sound_mode import (
    NameGate,
    Segmenter,
    SoundConfig,
    SoundService,
    SoundSetupError,
    resolve_device,
)


FRAME = np.ones(512, np.float32) * 0.05


class NameGateTests(unittest.TestCase):
    def test_returns_full_original_utterance(self):
        text, reason = NameGate("Ritesh").check("  RITESH,   your ride is here.  ", now=1)
        self.assertEqual((text, reason), ("RITESH, your ride is here.", "accepted"))

    def test_alias_and_multiword_names(self):
        gate = NameGate("Mary Jane", ("MJ", "Reetesh"))
        self.assertIsNotNone(gate.check("Hey MJ", now=1)[0])
        self.assertIsNotNone(gate.check("This is for Mary Jane", now=2)[0])

    def test_requires_whole_words(self):
        text, reason = NameGate("Ann").check("The annual meeting", now=1)
        self.assertIsNone(text)
        self.assertEqual(reason, "name not found")

    def test_suppresses_duplicate_for_ten_seconds(self):
        gate = NameGate("Ritesh")
        self.assertIsNotNone(gate.check("Ritesh hello", now=1)[0])
        self.assertEqual(gate.check("RITESH, hello", now=10.9), (None, "duplicate"))
        self.assertIsNotNone(gate.check("Ritesh hello", now=11)[0])


class SegmenterTests(unittest.TestCase):
    def test_closes_after_silence_and_keeps_preroll(self):
        segmenter = Segmenter(pre_ms=64, silence_ms=64, min_ms=64)
        segmenter.push(FRAME, 0)
        segmenter.push(FRAME, 0.9)
        segmenter.push(FRAME, 0.9)
        segmenter.push(FRAME, 0)
        result = segmenter.push(FRAME, 0)
        self.assertEqual(result.size, 5 * 512)

    def test_discards_too_short_speech(self):
        segmenter = Segmenter(pre_ms=32, silence_ms=64, min_ms=96)
        segmenter.push(FRAME, 0.9)
        segmenter.push(FRAME, 0.9)
        segmenter.push(FRAME, 0)
        self.assertIsNone(segmenter.push(FRAME, 0))


class UtilityTests(unittest.TestCase):
    def test_requested_mac_mic_never_falls_back_to_iphone(self):
        devices = [
            {"name": "iPhone Microphone", "max_input_channels": 1, "default_samplerate": 48000},
            {"name": "MacBook Air Microphone", "max_input_channels": 1, "default_samplerate": 48000},
        ]
        self.assertEqual(resolve_device(devices, "MacBook Air Microphone")[:2], (1, "MacBook Air Microphone"))
        with self.assertRaisesRegex(SoundSetupError, "iPhone.*MacBook"):
            resolve_device(devices, "Missing")

    def test_pause_invalidates_and_clears_pending_audio(self):
        service = SoundService(
            SoundConfig("Ritesh"), on_result=lambda *_: None,
            on_status=lambda _change: None, logger=lambda _line: None,
        )
        old_generation = service.generation
        service.audio.put((old_generation, FRAME))
        service.utterances.put((old_generation, FRAME))
        service.set_paused(True)
        self.assertFalse(service._current(old_generation))
        self.assertTrue(service.audio.empty())
        self.assertTrue(service.utterances.empty())


if __name__ == "__main__":
    unittest.main()
