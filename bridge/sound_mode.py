"""Name-triggered microphone pipeline used by ``detect_bridge.py --recognizer sound``."""

from __future__ import annotations

import collections
import dataclasses
import math
import queue
import re
import threading
import time
import unicodedata
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence

import numpy as np

RATE = 16_000
FRAME = 512  # 32 ms at 16 kHz; Silero's streaming frame size.


class SoundSetupError(RuntimeError):
    pass


def words(text: str) -> tuple[str, ...]:
    folded = unicodedata.normalize("NFKC", text).casefold().replace("’", "'")
    return tuple(re.findall(r"[^\W_]+(?:'[^\W_]+)*", folded, re.UNICODE))


class NameGate:
    """Allows full utterances containing an exact name/alias and suppresses repeats."""

    def __init__(self, name: str, aliases: Sequence[str] = (), cooldown: float = 10.0) -> None:
        self.names = tuple(dict.fromkeys(filter(None, (words(value) for value in (name, *aliases)))))
        if not self.names:
            raise ValueError("wake name must contain a letter or number")
        self.cooldown = cooldown
        self.recent: dict[tuple[str, ...], float] = {}

    def check(self, transcript: str, now: float | None = None) -> tuple[str | None, str]:
        text = " ".join(str(transcript).split()).strip()
        tokens = words(text)
        if not text:
            return None, "empty"
        matched = any(
            tokens[i : i + len(name)] == name
            for name in self.names
            for i in range(len(tokens) - len(name) + 1)
        )
        if not matched:
            return None, "name not found"
        current = time.monotonic() if now is None else now
        if tokens in self.recent and current - self.recent[tokens] < self.cooldown:
            return None, "duplicate"
        self.recent = {key: seen for key, seen in self.recent.items() if current - seen < self.cooldown}
        self.recent[tokens] = current
        return text, "accepted"


def resolve_device(devices: Sequence[Mapping[str, Any]], requested: str) -> tuple[int, str, int]:
    inputs = [(i, item) for i, item in enumerate(devices) if int(item.get("max_input_channels", 0)) > 0]
    if requested.isdigit():
        matches = [(i, item) for i, item in inputs if i == int(requested)]
    else:
        matches = [(i, item) for i, item in inputs if str(item.get("name", "")).casefold() == requested.casefold()]
    if len(matches) != 1:
        available = ", ".join(f"{i}: {item.get('name')}" for i, item in inputs) or "none"
        raise SoundSetupError(f"microphone {requested!r} not found; available inputs: {available}")
    index, device = matches[0]
    rate = int(round(float(device.get("default_samplerate", 0))))
    if rate <= 0:
        raise SoundSetupError(f"microphone {device.get('name')!r} has no sample rate")
    return index, str(device["name"]), rate


class Segmenter:
    """Collects VAD frames into utterances with pre-roll and trailing silence."""

    def __init__(self, pre_ms=300, silence_ms=600, min_ms=300, max_seconds=10.0, threshold=0.5) -> None:
        self.pre = collections.deque(maxlen=math.ceil(pre_ms / 32))
        self.silence_limit = int(silence_ms * RATE / 1000)
        self.min_voice = int(min_ms * RATE / 1000)
        self.max_samples = int(max_seconds * RATE)
        self.threshold = threshold
        self.reset()

    def reset(self) -> None:
        self.active = False
        self.parts: list[np.ndarray] = []
        self.silent = 0
        self.voiced = 0
        if hasattr(self, "pre"):
            self.pre.clear()

    def push(self, frame: np.ndarray, probability: float) -> np.ndarray | None:
        frame = np.asarray(frame, dtype=np.float32).reshape(-1).copy()
        voice = probability >= self.threshold
        if not self.active:
            self.pre.append(frame)
            if not voice:
                return None
            self.active = True
            self.parts = list(self.pre)
            self.pre.clear()
            self.voiced = frame.size
        else:
            self.parts.append(frame)
            if voice:
                self.voiced += frame.size
                self.silent = 0
            else:
                self.silent += frame.size
        total = sum(part.size for part in self.parts)
        if total < self.max_samples and self.silent < self.silence_limit:
            return None
        utterance = np.concatenate(self.parts)[: self.max_samples]
        keep = self.voiced >= self.min_voice
        self.reset()
        return utterance if keep else None


@dataclass(frozen=True)
class SoundConfig:
    wake_name: str
    aliases: tuple[str, ...] = ()
    microphone: str = "MacBook Air Microphone"
    api_key: str = ""
    model: str = "gpt-transcribe"
    request_timeout: float = 15.0


class SoundService:
    """Two bounded workers: microphone/VAD and cloud transcription."""

    def __init__(
        self,
        config: SoundConfig,
        *,
        on_result: Callable[[str, float], None],
        on_status: Callable[[Mapping[str, Any]], None],
        logger: Callable[[str], None],
    ) -> None:
        self.config = config
        self.on_result, self.on_status, self.log = on_result, on_status, logger
        self.gate = NameGate(config.wake_name, config.aliases)
        self.segmenter = Segmenter()
        self.audio: queue.Queue[tuple[int, np.ndarray]] = queue.Queue(maxsize=8)
        self.utterances: queue.Queue[tuple[int, np.ndarray]] = queue.Queue(maxsize=3)
        self.stop_event = threading.Event()
        self.vad_ready, self.asr_ready = threading.Event(), threading.Event()
        self.lock, self.pipeline_lock = threading.Lock(), threading.Lock()
        self.generation = 0
        self.paused = False
        self.stream = None
        self.input_rate = RATE
        self.vad_model = None
        self.openai = None
        self.accepted = self.discarded = self.dropped = 0

    def status(self, **values: Any) -> None:
        self.on_status(values)

    def names(self) -> tuple[str, ...]:
        return tuple(dict.fromkeys((self.config.wake_name, *self.config.aliases)))

    def set_names(self, wake_name: str, aliases: Sequence[str] = ()) -> None:
        """Change the wearer name and aliases while running (used by the website)."""
        gate = NameGate(wake_name, aliases)          # validates before anything is swapped
        with self.lock:
            self.config = dataclasses.replace(self.config, wake_name=wake_name, aliases=tuple(aliases))
            self.gate = gate
        self.status(wake_name=wake_name, aliases=list(aliases))
        self.log(f"now listening for {wake_name!r}" + (f" (aliases: {', '.join(aliases)})" if aliases else ""))

    def start(self) -> None:
        if not self.config.api_key:
            raise SoundSetupError("OPENAI_API_KEY missing; add it to bridge/.env")
        try:
            import sounddevice as sd
            from openai import OpenAI
        except ImportError as exc:
            raise SoundSetupError(f"sound dependency missing ({exc}); install bridge/requirements.txt in .venv") from exc
        self.openai = OpenAI(
            api_key=self.config.api_key,
            timeout=self.config.request_timeout,
            max_retries=0,
        )
        index, name, self.input_rate = resolve_device(list(sd.query_devices()), self.config.microphone)
        try:
            self.stream = sd.InputStream(
                device=index, samplerate=self.input_rate, channels=1, dtype="float32",
                blocksize=round(self.input_rate * FRAME / RATE), callback=self._capture,
            )
            self.stream.start()
        except Exception as exc:
            raise SoundSetupError(
                f"could not open {name!r}: {exc}. Allow Terminal/Python in System Settings > "
                "Privacy & Security > Microphone."
            ) from exc
        self.status(device=name, sample_rate=self.input_rate, available=True, state="loading", error=None)
        threading.Thread(target=self._vad_loop, daemon=True, name="sound-vad").start()
        threading.Thread(target=self._asr_loop, daemon=True, name="sound-asr").start()
        self.log(f"sound input: {name} at {self.input_rate} Hz; starting speech workers")

    def _put_latest(self, target: queue.Queue, item: Any) -> None:
        try:
            target.put_nowait(item)
        except queue.Full:
            try:
                target.get_nowait()
            except queue.Empty:
                pass
            target.put_nowait(item)
            self.dropped += 1
            self.status(dropped_count=self.dropped)

    def _capture(self, data: np.ndarray, _frames: int, _timing: Any, warning: Any) -> None:
        if self.paused or self.stop_event.is_set():
            return
        if warning:
            self.status(error=f"microphone warning: {warning}")
        self._put_latest(self.audio, (self.generation, np.asarray(data[:, 0], dtype=np.float32).copy()))

    def _set_ready(self) -> None:
        if self.vad_ready.is_set() and self.asr_ready.is_set() and not self.paused:
            self.status(state="listening", listening=True, error=None)

    def _vad_loop(self) -> None:
        try:
            import torch
            from scipy.signal import resample_poly
            from silero_vad import load_silero_vad
            torch.set_num_threads(1)
            self.vad_model = load_silero_vad()
        except Exception as exc:
            self._fail(f"could not load Silero VAD: {exc}")
            return
        self.vad_ready.set()
        self._set_ready()
        pending = np.empty(0, np.float32)
        pending_generation = -1
        while not self.stop_event.is_set():
            try:
                generation, native = self.audio.get(timeout=0.2)
            except queue.Empty:
                continue
            if not self._current(generation):
                continue
            if generation != pending_generation:
                pending, pending_generation = np.empty(0, np.float32), generation
            if self.input_rate == RATE:
                converted = native
            else:
                divisor = math.gcd(self.input_rate, RATE)
                converted = resample_poly(native, RATE // divisor, self.input_rate // divisor).astype(np.float32)
            pending = np.concatenate((pending, converted))
            rms = float(np.sqrt(np.mean(native * native))) if native.size else 0.0
            self.status(level_dbfs=round(max(-120.0, 20 * math.log10(max(rms, 1e-6))), 1))
            while pending.size >= FRAME and self._current(generation):
                frame, pending = pending[:FRAME], pending[FRAME:]
                try:
                    with self.pipeline_lock:
                        probability = float(self.vad_model(torch.from_numpy(frame), RATE).item())
                        utterance = self.segmenter.push(frame, probability)
                        speaking = self.segmenter.active
                except Exception as exc:
                    self._fail(f"speech detector failed: {exc}")
                    return
                self.status(vad_probability=round(probability, 3), state="speech" if speaking else "listening")
                if utterance is not None:
                    self._put_latest(self.utterances, (generation, utterance))

    def _asr_loop(self) -> None:
        import io
        import wave

        def transcribe(audio: np.ndarray) -> str:
            names = self.names()                      # read live: the name can change at runtime
            prompt = f"Expected name spellings: {', '.join(names)}."
            pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
            wav = io.BytesIO()
            with wave.open(wav, "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(RATE)
                output.writeframes(pcm.tobytes())
            result = self.openai.audio.transcriptions.create(
                model=self.config.model,
                file=("speech.wav", wav.getvalue(), "audio/wav"),
                prompt=prompt,
                extra_body={"keywords": list(names), "languages": ["en"]},
            )
            return str(result.text)

        self.asr_ready.set()
        self._set_ready()
        self.log(f"cloud speech recognizer ready; listening for {self.config.wake_name!r}")
        while not self.stop_event.is_set():
            try:
                generation, audio = self.utterances.get(timeout=0.2)
            except queue.Empty:
                continue
            if not self._current(generation):
                continue
            self.status(state="transcribing")
            started = time.monotonic()
            try:
                transcript = transcribe(audio)
            except Exception as exc:
                self.status(state="listening", error=f"transcription failed: {exc}")
                continue
            latency = int((time.monotonic() - started) * 1000)
            if not self._current(generation):
                continue
            with self.lock:
                gate = self.gate
            accepted, reason = gate.check(transcript)
            transcript = ""
            if accepted:
                self.accepted += 1
                self.on_result(accepted, 1.0)
                self.status(state="listening", latency_ms=latency, accepted_count=self.accepted,
                            last_text=accepted, error=None)
                self.log(f"accepted speech ({latency} ms): {accepted!r}")
            else:
                self.discarded += 1
                self.status(state="listening", latency_ms=latency, discarded_count=self.discarded, error=None)
                self.log(f"speech discarded ({reason}); transcript not retained")

    def _current(self, generation: int) -> bool:
        with self.lock:
            return generation == self.generation and not self.paused and not self.stop_event.is_set()

    @staticmethod
    def _drain(target: queue.Queue) -> None:
        while True:
            try:
                target.get_nowait()
            except queue.Empty:
                return

    def clear_pending(self) -> None:
        with self.lock:
            self.generation += 1
        self._drain(self.audio)
        self._drain(self.utterances)
        with self.pipeline_lock:
            self.segmenter.reset()
            if self.vad_model is not None:
                self.vad_model.reset_states()

    def set_paused(self, paused: bool) -> None:
        with self.lock:
            self.paused = paused
            self.generation += 1
        self._drain(self.audio)
        self._drain(self.utterances)
        with self.pipeline_lock:
            self.segmenter.reset()
            if self.vad_model is not None:
                self.vad_model.reset_states()
        ready = self.vad_ready.is_set() and self.asr_ready.is_set()
        self.status(paused=paused, listening=ready and not paused,
                    state="paused" if paused else "listening" if ready else "loading")
        self.log("MICROPHONE PAUSED" if paused else "microphone resumed")

    def _fail(self, message: str) -> None:
        with self.lock:
            self.paused = True
            self.generation += 1
        self.status(state="error", available=False, listening=False, error=message)
        self.log(f"sound mode error: {message}")

    def stop(self) -> None:
        self.stop_event.set()
        self.clear_pending()
        if self.stream is not None:
            try:
                self.stream.stop()
                self.stream.close()
            except Exception:
                pass
        self.status(state="stopped", listening=False, paused=True)
