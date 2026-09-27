#!/usr/bin/env python3
"""Detection bridge: Pi camera -> YOLO + OCR on this laptop -> queue -> braille.

  camera (Pi, MJPEG tcp 8555) --> capture thread --> latest frame
  latest frame --> detect thread (YOLO objects + Tesseract text) --> best detection
  best detection --> queue (auto: when stable & new; manual: on /capture)
  queue --> the web app pops items (POST /next) and plays them on the pins,
            or, with --direct, this bridge plays them on the Pi itself.

HTTP on :8765 (CORS open):
  GET  /state                 detections, best, queue, mode, stats
  GET  /frame.jpg             latest annotated frame
  GET  /stream.mjpg           live annotated MJPEG stream
  POST /next                  pop the next queued item ({"item": null} when empty)
  POST /capture               queue the current best detection now
  POST /queue?text=..&kind=.. queue arbitrary text
  POST /clear                 empty the queue
  POST /mode?value=auto|manual
  POST /engine?value=tesseract|vlm|both|none   text/classification engine (vlm = Claude, or OpenAI)
  POST /analyze               run one vision-model pass right now
"""
import argparse, collections, json, os, re, subprocess, sys, tempfile, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, quote
from urllib.request import Request, urlopen

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--pi", default="169.254.10.10", help="Pi address (solenoid server :8080, camera :8555)")
ap.add_argument("--camera", default=None, help="camera source; default tcp://<pi>:8555, or a webcam index like 0")
ap.add_argument("--port", type=int, default=8765)
ap.add_argument("--weights", default=os.path.join(HERE, "..", "pi", "models", "yolo26n-seg.pt"))
ap.add_argument("--device", default="mps")
ap.add_argument("--conf", type=float, default=0.45, help="object confidence threshold")
ap.add_argument("--ocr-conf", type=float, default=65, help="Tesseract word confidence threshold (0-100)")
ap.add_argument("--interval", type=float, default=0.6, help="seconds between detection passes")
ap.add_argument("--ocr-every", type=int, default=2, help="run OCR every N passes (0 = never)")
ap.add_argument("--mode", choices=["auto", "manual"], default="auto")
ap.add_argument("--stable", type=int, default=2, help="auto: passes a label must persist before queueing")
ap.add_argument("--cooldown", type=float, default=5, help="auto: minimum seconds before a label that left and came back may queue again")
ap.add_argument("--max-queue", type=int, default=8)
ap.add_argument("--direct", action="store_true", help="play the queue on the Pi from here (no web app needed)")
ap.add_argument("--cell-ms", type=int, default=900)
ap.add_argument("--space-ms", type=int, default=500)
ap.add_argument("--ocr", choices=["tesseract", "vlm", "both", "none"], default=None,
                help="text/classification engine; default: both when a Claude (or OpenAI) key is available, else tesseract")
ap.add_argument("--vlm-provider", choices=["auto", "anthropic", "openai"], default="auto",
                help="vision model provider; auto = Claude when ANTHROPIC_API_KEY is set, else OpenAI")
ap.add_argument("--vlm-model", default="auto", help="vision model id; auto = claude-opus-5 (Claude) or newest gpt (OpenAI)")
ap.add_argument("--vlm-every", type=float, default=3.0, help="seconds between vision-model passes")
ap.add_argument("--prompt", default=os.path.join(HERE, "prompt.txt"), help="prompt file for the vision-model pass")
args = ap.parse_args()


def load_env_key(name):
    """Read a key from the environment or from bridge/.env (never committed)."""
    key = os.environ.get(name)
    if key:
        return key
    for path in (os.path.join(HERE, ".env"), os.path.join(HERE, "..", ".env")):
        try:
            for line in open(path):
                line = line.strip()
                if line.startswith(name + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
        except OSError:
            pass
    return None


ANTHROPIC_KEY = load_env_key("ANTHROPIC_API_KEY")
OPENAI_KEY = load_env_key("OPENAI_API_KEY")
VLM_PROVIDER = args.vlm_provider
if VLM_PROVIDER == "auto":
    VLM_PROVIDER = "anthropic" if ANTHROPIC_KEY else ("openai" if OPENAI_KEY else None)
VLM_KEY = ANTHROPIC_KEY if VLM_PROVIDER == "anthropic" else OPENAI_KEY if VLM_PROVIDER == "openai" else None
if args.ocr is None:
    args.ocr = "both" if VLM_KEY else "tesseract"
CAMERA = args.camera if args.camera is not None else f"tcp://{args.pi}:8555"
PI_URL = f"http://{args.pi}:8080"

LOCK = threading.Lock()
STATE = {
    "frame": None, "jpeg": None, "frame_at": 0.0, "camera_ok": False,
    "detections": [], "best": None, "mode": args.mode, "queue": collections.deque(),
    "playing": None, "seq": 0, "last_next_at": 0.0,
    "stats": {"fps": 0.0, "infer_ms": 0, "ocr_ms": 0, "model": os.path.basename(args.weights), "device": args.device, "passes": 0},
    "log": collections.deque(maxlen=40),
    "engine": args.ocr,
    "tesseract": [],            # last Tesseract lines
    "vlm": {"available": bool(VLM_KEY), "provider": VLM_PROVIDER, "model": None, "kind": None, "label": "", "text": "", "object": "",
            "confidence": 0.0, "latency_ms": 0, "at": 0, "raw": "", "error": None, "passes": 0},
}
ANALYZE_NOW = threading.Event()
COOLDOWN = {}          # label -> last queued time
STABLE = {"label": None, "count": 0}
PRESENT = {}           # label -> time it (re)entered the view
ABSENT = {}            # label -> consecutive passes it has been missing
ABSENT_PASSES = 3      # missing this many passes counts as having left the view


def log(msg):
    line = time.strftime("%H:%M:%S ") + msg
    STATE["log"].append(line)
    print(line, flush=True)


# ------------------------------------------------------------------ capture
def capture_loop():
    while True:
        src = int(CAMERA) if CAMERA.isdigit() else CAMERA
        cap = cv2.VideoCapture(src, cv2.CAP_FFMPEG if isinstance(src, str) else cv2.CAP_ANY)
        if not cap.isOpened():
            with LOCK:
                STATE["camera_ok"] = False
            time.sleep(1.0)
            continue
        log(f"camera connected: {CAMERA}")
        n, t0 = 0, time.time()
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            n += 1
            with LOCK:
                STATE["frame"] = frame
                STATE["frame_at"] = time.time()
                STATE["camera_ok"] = True
                if n % 10 == 0:
                    STATE["stats"]["fps"] = round(10 / max(1e-6, time.time() - t0), 1)
                    t0 = time.time()
        cap.release()
        with LOCK:
            STATE["camera_ok"] = False
        log("camera stream ended, reconnecting")
        time.sleep(1.0)


# ------------------------------------------------------------------ detection
def load_model():
    from ultralytics import YOLO
    try:
        m = YOLO(args.weights)
        m.predict(np.zeros((320, 320, 3), np.uint8), device=args.device, verbose=False)   # warm-up / device check
        return m
    except Exception as e:  # fall back to any yolov8n around
        log(f"could not load {args.weights} on {args.device}: {e}")
        fallback = os.path.expanduser("~/Desktop/haptic/yolov8n.pt")
        m = YOLO(fallback if os.path.exists(fallback) else "yolov8n.pt")
        STATE["stats"]["model"] = os.path.basename(str(m.ckpt_path or "yolov8n.pt"))
        return m


def run_yolo(model, frame):
    H, W = frame.shape[:2]
    r = model.predict(frame, conf=args.conf, device=args.device, verbose=False)[0]
    out = []
    for b in r.boxes:
        x1, y1, x2, y2 = b.xyxy[0].tolist()
        out.append({"kind": "object", "label": model.names[int(b.cls)], "confidence": round(float(b.conf), 3),
                    "box": {"x": round(x1 / W, 4), "y": round(y1 / H, 4), "w": round((x2 - x1) / W, 4), "h": round((y2 - y1) / H, 4)}})
    return out


WORD_OK = re.compile(r"^[A-Za-z0-9][A-Za-z0-9'&.,:!?-]*$")


def run_ocr(frame):
    """Tesseract sparse-text pass; returns text-line detections with normalised boxes."""
    H, W = frame.shape[:2]
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        path = f.name
    cv2.imwrite(path, gray)
    try:   # bytes, not text=: tesseract's stderr is not always valid UTF-8
        tsv = subprocess.run(["tesseract", path, "-", "--psm", "11", "-l", "eng", "tsv"],
                             capture_output=True, timeout=8).stdout.decode("utf-8", "replace")
    except Exception as e:
        log(f"ocr failed: {e}")
        return []
    finally:
        try: os.unlink(path)
        except OSError: pass
    lines = {}
    for row in tsv.splitlines()[1:]:
        p = row.split("\t")
        if len(p) != 12 or p[10] in ("-1", ""):
            continue
        conf, text = float(p[10]), p[11].strip()
        if conf < args.ocr_conf or len(text) < 2 or not WORD_OK.match(text):
            continue
        key = (p[2], p[3], p[4])   # block, paragraph, line
        x, y, w, h = map(int, p[6:10])
        L = lines.setdefault(key, {"words": [], "confs": [], "x1": x, "y1": y, "x2": x + w, "y2": y + h})
        L["words"].append(text); L["confs"].append(conf)
        L["x1"], L["y1"], L["x2"], L["y2"] = min(L["x1"], x), min(L["y1"], y), max(L["x2"], x + w), max(L["y2"], y + h)
    out = []
    for L in lines.values():
        text = " ".join(L["words"])
        if sum(c.isalnum() for c in text) < 3:
            continue
        out.append({"kind": "text", "label": text, "confidence": round(sum(L["confs"]) / len(L["confs"]) / 100, 3),
                    "box": {"x": round(L["x1"] / W, 4), "y": round(L["y1"] / H, 4),
                            "w": round((L["x2"] - L["x1"]) / W, 4), "h": round((L["y2"] - L["y1"]) / H, 4)}})
    return out


PREFERRED_MODELS = ["gpt-5.6", "gpt-5.5", "gpt-5.4", "gpt-5.3", "gpt-5.2", "gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o"]
BAD_MODEL_WORDS = ("mini", "nano", "audio", "realtime", "search", "transcribe", "tts", "codex", "pro", "chat")


def openai_request(path, payload=None, timeout=30):
    req = Request("https://api.openai.com/v1" + path, method="POST" if payload is not None else "GET",
                  headers={"Authorization": f"Bearer {OPENAI_KEY}", "Content-Type": "application/json"},
                  data=json.dumps(payload).encode() if payload is not None else None)
    try:
        with urlopen(req, timeout=timeout) as r:
            return json.load(r), None
    except Exception as e:  # HTTPError carries the API's message
        body = ""
        try:
            body = json.load(e).get("error", {}).get("message", "")  # type: ignore[arg-type]
        except Exception:
            body = str(e)
        return None, body or str(e)


def pick_vlm_model():
    if args.vlm_model != "auto":
        return args.vlm_model, None
    if VLM_PROVIDER == "anthropic":
        return "claude-opus-5", None
    data, err = openai_request("/models")
    if err:
        return None, err
    ids = {m["id"] for m in data.get("data", [])}
    for pref in PREFERRED_MODELS:
        if pref in ids:
            return pref, None
        cands = sorted(i for i in ids if i.startswith(pref + "-") and not any(w in i for w in BAD_MODEL_WORDS))
        if cands:
            return cands[-1], None
    return None, "no vision-capable gpt model available to this key"


VLM_SCHEMA = {
    "type": "object",
    "properties": {
        "text": {"type": "string"},
        "object": {"type": "string"},
        "kind": {"type": "string", "enum": ["text", "object"]},
        "confidence": {"type": "number"},
    },
    "required": ["text", "object", "kind", "confidence"],
    "additionalProperties": False,
}


def frame_to_b64(frame):
    H, W = frame.shape[:2]
    scale = 768 / max(W, 1)
    small = cv2.resize(frame, (768, int(H * scale))) if scale < 1 else frame
    ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 70])
    if not ok:
        return None
    import base64
    return base64.b64encode(buf.tobytes()).decode()


def read_prompt():
    try:
        return open(args.prompt).read().strip()
    except OSError:
        return "Describe the most important object or readable text in one short phrase as JSON {text, object, kind, confidence}."


def parse_vlm_json(text, latency):
    m = re.search(r"\{.*\}", text, re.S)
    try:
        j = json.loads(m.group(0) if m else text)
    except Exception:
        return {"raw": text[:400], "latency_ms": latency, "error": "unparseable reply"}
    kind = "text" if str(j.get("kind", "")).lower() == "text" and str(j.get("text", "")).strip() else "object"
    label = str(j.get("text", "") if kind == "text" else j.get("object", "")).strip()[:60]
    try:
        conf = max(0.0, min(1.0, float(j.get("confidence", 0.5))))
    except (TypeError, ValueError):
        conf = 0.5
    return {"kind": kind, "label": label, "text": str(j.get("text", "")).strip()[:60], "object": str(j.get("object", "")).strip()[:60],
            "confidence": round(conf, 3), "latency_ms": latency, "raw": text[:400], "error": None}


def run_claude(model, frame):
    """One Claude vision pass (Messages API over HTTPS); returns (result dict or None, error)."""
    b64 = frame_to_b64(frame)
    if not b64:
        return None, "jpeg encode failed"
    payload = {
        "model": model,
        "max_tokens": 1500,
        "fallbacks": "default",
        "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": VLM_SCHEMA}},
        "messages": [{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}},
            {"type": "text", "text": read_prompt()},
        ]}],
    }
    req = Request("https://api.anthropic.com/v1/messages", method="POST", data=json.dumps(payload).encode(),
                  headers={"x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01",
                           "anthropic-beta": "server-side-fallback-2026-07-01", "content-type": "application/json"})
    t = time.time()
    try:
        with urlopen(req, timeout=45) as r:
            data = json.load(r)
    except Exception as e:
        msg = str(e)
        try:
            msg = json.load(e).get("error", {}).get("message", msg)  # type: ignore[arg-type]
        except Exception:
            pass
        return None, msg[:200]
    latency = int((time.time() - t) * 1000)
    if data.get("stop_reason") == "refusal":
        return {"raw": "", "latency_ms": latency, "error": "declined by safety classifier"}, None
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()
    return parse_vlm_json(text, latency), None


def run_vlm(model, frame):
    if VLM_PROVIDER == "anthropic":
        return run_claude(model, frame)
    return run_openai(model, frame)


def run_openai(model, frame):
    """One OpenAI vision pass; returns (result dict or None, error)."""
    b64 = frame_to_b64(frame)
    if not b64:
        return None, "jpeg encode failed"
    prompt = read_prompt()
    payload = {
        "model": model,
        "input": [{"role": "user", "content": [
            {"type": "input_text", "text": prompt},
            {"type": "input_image", "image_url": f"data:image/jpeg;base64,{b64}", "detail": "low"},
        ]}],
        "max_output_tokens": 400,
    }
    if model.startswith("gpt-5"):
        payload["reasoning"] = {"effort": "low"}
    t = time.time()
    data, err = openai_request("/responses", payload)
    latency = int((time.time() - t) * 1000)
    if err:
        return None, err
    text = ""
    for item in data.get("output", []):
        if item.get("type") == "message":
            for c in item.get("content", []):
                if c.get("type") == "output_text":
                    text += c.get("text", "")
    return parse_vlm_json(text.strip(), latency), None


def vlm_loop():
    if not VLM_KEY:
        log("vision model: no ANTHROPIC_API_KEY / OPENAI_API_KEY in bridge/.env -> text via tesseract only")
        return
    model, err = pick_vlm_model()
    with LOCK:
        STATE["vlm"]["model"] = model
        STATE["vlm"]["error"] = err
        STATE["vlm"]["available"] = model is not None
    if err:
        log(f"vision model unavailable: {err}")
        return
    log(f"vision model: {VLM_PROVIDER} {model}")
    while True:
        forced = ANALYZE_NOW.wait(timeout=args.vlm_every)
        ANALYZE_NOW.clear()
        with LOCK:
            frame = STATE["frame"]
            engine = STATE["engine"]
        if frame is None or (engine not in ("vlm", "both") and not forced):
            continue
        res, err = run_vlm(model, frame)
        with LOCK:
            v = STATE["vlm"]
            v["passes"] += 1
            v["at"] = int(time.time() * 1000)
            if err:
                v["error"] = err
            else:
                v.update(res)
                v["error"] = res.get("error")
        if err:
            log(f"vision model error: {err[:120]}")
            time.sleep(5)
        elif res.get("error"):
            log(f"vision model: {res['error']}")
        elif res.get("label"):
            log(f"{VLM_PROVIDER} {res['latency_ms']} ms: {res['kind']} {res['label']!r} ({int(res['confidence'] * 100)}%)")


def vlm_detections():
    """Turn the last fresh OpenAI answer into detections (no real box: centred)."""
    with LOCK:
        v = dict(STATE["vlm"])
        engine = STATE["engine"]
    if engine not in ("vlm", "both") or not v.get("label") or time.time() * 1000 - v.get("at", 0) > 10000:
        return []
    # Honour the model's own judgement: only when it says the frame is about text does
    # the text become a candidate; otherwise the object/scene label is what gets sent.
    out = []
    if v.get("kind") == "text" and v.get("text"):
        out.append({"kind": "text", "label": v["text"], "confidence": v["confidence"],
                    "box": {"x": 0.15, "y": 0.4, "w": 0.7, "h": 0.2}, "engine": "vlm"})
    elif v.get("object"):
        out.append({"kind": "object", "label": v["object"], "confidence": v["confidence"],
                    "box": {"x": 0.05, "y": 0.05, "w": 0.9, "h": 0.9}, "engine": "vlm"})
    return out


def choose_best(dets):
    """Prefer readable text; otherwise the most confident, largest object."""
    texts = [d for d in dets if d["kind"] == "text"]
    if texts:
        return max(texts, key=lambda d: (d.get("engine") == "vlm", d["confidence"] * len(d["label"])))
    objs = [d for d in dets if d["kind"] == "object"]
    if objs:
        return max(objs, key=lambda d: (d.get("engine") == "vlm", d["confidence"] * (d["box"]["w"] * d["box"]["h"]) ** 0.5))
    return None


def annotate(frame, dets, best):
    img = frame.copy()
    H, W = img.shape[:2]
    for d in dets:
        b = d["box"]; x1, y1 = int(b["x"] * W), int(b["y"] * H); x2, y2 = int((b["x"] + b["w"]) * W), int((b["y"] + b["h"]) * H)
        col = (60, 220, 60) if d["kind"] == "text" else (255, 180, 40)
        thick = 3 if best is d else 1
        cv2.rectangle(img, (x1, y1), (x2, y2), col, thick)
        cv2.putText(img, f'{d["label"]} {int(d["confidence"] * 100)}%', (x1, max(14, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, col, 2)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 75])
    return buf.tobytes() if ok else None


def enqueue(det, reason):
    with LOCK:
        if len(STATE["queue"]) >= args.max_queue:
            STATE["queue"].popleft()
        STATE["seq"] += 1
        item = dict(det, id=f"cam-{STATE['seq']}", at=int(time.time() * 1000), source="camera")
        STATE["queue"].append(item)
    COOLDOWN[det["label"].lower()] = time.time()
    log(f"queued [{reason}] {det['kind']}: {det['label']!r} ({int(det['confidence'] * 100)}%)  queue={len(STATE['queue'])}")
    return item


def detect_loop():
    model = load_model()
    log(f"model ready: {STATE['stats']['model']} on {args.device}; mode={STATE['mode']}")
    passes = 0
    while True:
        with LOCK:
            frame = STATE["frame"]
        if frame is None:
            time.sleep(0.2)
            continue
        t = time.time()
        dets = run_yolo(model, frame)
        infer_ms = int((time.time() - t) * 1000)
        ocr_ms = 0
        passes += 1
        with LOCK:
            engine = STATE["engine"]
        if engine in ("tesseract", "both") and args.ocr_every and passes % args.ocr_every == 0:
            t = time.time()
            lines = run_ocr(frame)
            ocr_ms = int((time.time() - t) * 1000)
            with LOCK:
                STATE["tesseract"] = lines
            dets += lines
        elif engine in ("tesseract", "both"):
            with LOCK:
                dets += list(STATE["tesseract"])     # reuse last OCR lines between passes
        dets += vlm_detections()
        best = choose_best(dets)
        jpeg = annotate(frame, [d for d in dets if d.get("engine") != "vlm"], best)
        with LOCK:
            STATE["detections"] = dets
            STATE["best"] = best
            STATE["jpeg"] = jpeg
            STATE["stats"].update(infer_ms=infer_ms, ocr_ms=ocr_ms or STATE["stats"]["ocr_ms"], passes=passes)
            mode = STATE["mode"]
        # Track what is in view so a label is queued when it arrives, not continuously while it stays.
        now = time.time()
        seen = {d["label"].lower() for d in dets}
        for lbl in seen:
            ABSENT[lbl] = 0
            PRESENT.setdefault(lbl, now)
        for lbl in list(PRESENT):
            if lbl not in seen:
                ABSENT[lbl] = ABSENT.get(lbl, 0) + 1
                if ABSENT[lbl] >= ABSENT_PASSES:
                    del PRESENT[lbl]
        # auto mode: queue the best label once it has been stable for `stable` passes, and only
        # if it has not been queued since it (re)entered the view and its cooldown has passed.
        label = best["label"].lower() if best else None
        if label == STABLE["label"]:
            STABLE["count"] += 1
        else:
            STABLE["label"], STABLE["count"] = label, 1
        if mode == "auto" and best and STABLE["count"] >= args.stable:
            queued_at = COOLDOWN.get(label, 0)
            arrived = PRESENT.get(label, now)
            if arrived > queued_at and now - queued_at > args.cooldown:
                enqueue(best, "auto")
        time.sleep(max(0.0, args.interval - (infer_ms + ocr_ms) / 1000.0))


# ------------------------------------------------------------------ direct playback on the Pi
def pi(path, method="POST"):
    with urlopen(Request(PI_URL + path, method=method), timeout=4) as r:
        return json.load(r)


def direct_loop():
    log("direct mode: this bridge plays the queue on the Pi")
    while True:
        try:
            st = pi("/state", "GET")
            if not st["braille"]["playing"]:
                item = pop_next()
                if item:
                    pi(f"/braille?text={quote(item['label'])}&cell_ms={args.cell_ms}&space_ms={args.space_ms}")
                    log(f"playing on Pi: {item['label']!r}")
        except Exception as e:
            log(f"pi unreachable: {e}")
            time.sleep(2)
        time.sleep(0.3)


def pop_next():
    with LOCK:
        STATE["last_next_at"] = time.time()
        item = STATE["queue"].popleft() if STATE["queue"] else None
        if item:
            STATE["playing"] = item
    return item


# ------------------------------------------------------------------ http
def snapshot():
    with LOCK:
        return {
            "camera_ok": STATE["camera_ok"], "frame_age_ms": int((time.time() - STATE["frame_at"]) * 1000) if STATE["frame_at"] else None,
            "detections": STATE["detections"], "best": STATE["best"], "mode": STATE["mode"],
            "queue": list(STATE["queue"]), "playing": STATE["playing"], "stats": dict(STATE["stats"]),
            "direct": args.direct, "log": list(STATE["log"])[-8:],
            "engine": STATE["engine"], "vlm": dict(STATE["vlm"]), "tesseract": list(STATE["tesseract"]),
        }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _headers(self, code, ctype, length=None, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        if length is not None:
            self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()

    def _json(self, code, body):
        data = json.dumps(body).encode()
        self._headers(code, "application/json", len(data))
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._headers(204, "text/plain", 0)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/state":
            return self._json(200, snapshot())
        if u.path == "/frame.jpg":
            with LOCK:
                jpeg = STATE["jpeg"]
            if not jpeg:
                return self._json(503, {"error": "no frame yet"})
            self._headers(200, "image/jpeg", len(jpeg))
            return self.wfile.write(jpeg)
        if u.path == "/stream.mjpg":
            self._headers(200, "multipart/x-mixed-replace; boundary=frame")
            last = None
            try:
                while True:
                    with LOCK:
                        jpeg = STATE["jpeg"]
                    if jpeg and jpeg is not last:
                        last = jpeg
                        self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(jpeg))
                        self.wfile.write(jpeg + b"\r\n")
                        self.wfile.flush()
                    time.sleep(0.12)
            except (BrokenPipeError, ConnectionResetError):
                return
        return self._json(404, {"error": "unknown path"})

    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/next":
            return self._json(200, {"item": pop_next(), "remaining": len(STATE["queue"])})
        if u.path == "/capture":
            with LOCK:
                best = STATE["best"]
            if not best:
                return self._json(200, {"item": None, "error": "nothing detected in the current frame"})
            return self._json(200, {"item": enqueue(best, "capture")})
        if u.path == "/queue":
            text = q.get("text", [""])[0].strip()
            if not text:
                return self._json(400, {"error": "text required"})
            kind = q.get("kind", ["text"])[0]
            return self._json(200, {"item": enqueue({"kind": kind, "label": text, "confidence": 1.0,
                                                     "box": {"x": 0.14, "y": 0.4, "w": 0.72, "h": 0.2}}, "manual")})
        if u.path == "/clear":
            with LOCK:
                STATE["queue"].clear()
            log("queue cleared")
            return self._json(200, snapshot())
        if u.path == "/analyze":
            ANALYZE_NOW.set()
            return self._json(200, {"ok": True})
        if u.path == "/engine":
            v = q.get("value", [""])[0]
            if v not in ("tesseract", "vlm", "both", "none"):
                return self._json(400, {"error": "value must be tesseract, vlm, both or none"})
            with LOCK:
                STATE["engine"] = v
            log(f"engine -> {v}")
            return self._json(200, snapshot())
        if u.path == "/mode":
            v = q.get("value", [""])[0]
            if v not in ("auto", "manual"):
                return self._json(400, {"error": "value must be auto or manual"})
            with LOCK:
                STATE["mode"] = v
            log(f"mode -> {v}")
            return self._json(200, snapshot())
        return self._json(404, {"error": "unknown path"})


if __name__ == "__main__":
    threading.Thread(target=capture_loop, daemon=True).start()
    threading.Thread(target=detect_loop, daemon=True).start()
    threading.Thread(target=vlm_loop, daemon=True).start()
    if args.direct:
        threading.Thread(target=direct_loop, daemon=True).start()
    log(f"bridge on http://0.0.0.0:{args.port}  camera={CAMERA}  pi={PI_URL}")
    try:
        ThreadingHTTPServer(("0.0.0.0", args.port), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
