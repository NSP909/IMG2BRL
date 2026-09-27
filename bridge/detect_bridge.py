#!/usr/bin/env python3
"""Detection bridge: Pi camera -> laptop -> queue -> braille finger.

  camera (Pi, MJPEG tcp 8555) ---> latest frame
  latest frame --every 0.5 s--> YOLO26 (objects, filtered to a short list of venue objects)
                            \\-> EAST text detector (is there text? where?)
  text present & >= 5 s since the last Claude request --> Claude reads the text (one request)
  best = the text if any was read, otherwise the top object
  best --> queue (auto: when it arrives in view; manual: on /capture)
  queue --> the web app pops items (POST /next) and plays them on the pins,
            or, with --direct, this bridge plays them on the Pi itself.

HTTP on :8765 (CORS open):
  GET  /state                  detections, text gate, claude, queue, mode, stats
  GET  /frame.jpg              latest annotated frame
  GET  /stream.mjpg            live annotated MJPEG stream
  POST /next                   pop the next queued item ({"item": null} when empty)
  POST /capture                queue the current best detection now
  POST /queue?text=..&kind=..  queue arbitrary text
  POST /clear                  empty the queue
  POST /mode?value=auto|manual
  POST /engine?value=vlm|tesseract|none   who reads text: Claude (default), Tesseract (offline), nobody
  POST /analyze                read the text now, ignoring the 5 s gap
  POST /pause?value=1|0        camera lock: stop detection, reads and queueing
"""
import argparse, collections, json, os, re, subprocess, tempfile, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, quote
from urllib.request import Request, urlopen

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--pi", default="169.254.10.10", help="Pi address (solenoid server :8080, camera :8555)")
ap.add_argument("--camera", default=None, help="camera source; default tcp://<pi>:8555, a webcam index like 0, or an image file")
ap.add_argument("--port", type=int, default=8765)
ap.add_argument("--weights", default=os.path.join(HERE, "..", "pi", "models", "yolo26n-seg.pt"))
ap.add_argument("--device", default="mps")
ap.add_argument("--conf", type=float, default=0.5, help="object confidence threshold")
ap.add_argument("--classes", default="person,cell phone,laptop,bottle,chair,couch,dining table,cup,backpack,handbag,book,keyboard,mouse,tv,clock,scissors,potted plant,bench",
                help="comma-separated COCO classes to keep")
ap.add_argument("--interval", type=float, default=0.5, help="seconds between detection passes")
ap.add_argument("--east", default=os.path.join(HERE, "models", "frozen_east_text_detection.pb"), help="EAST text detector weights")
ap.add_argument("--text-conf", type=float, default=0.6, help="EAST score for a cell to count as text")
ap.add_argument("--text-cells", type=int, default=4, help="EAST cells needed to call the frame 'has text'")
ap.add_argument("--engine", choices=["vlm", "tesseract", "none"], default=None,
                help="who reads text once the gate opens; default: vlm when a Claude/OpenAI key exists, else tesseract")
ap.add_argument("--vlm-provider", choices=["auto", "anthropic", "openai"], default="auto")
ap.add_argument("--vlm-model", default="auto", help="vision model id; auto = claude-opus-5 (Claude) or newest gpt (OpenAI)")
ap.add_argument("--read-gap", type=float, default=5.0, help="minimum seconds between two Claude requests")
ap.add_argument("--prompt", default=os.path.join(HERE, "prompt.txt"), help="prompt file for the text read")
ap.add_argument("--mode", choices=["auto", "manual"], default="auto")
ap.add_argument("--stable", type=int, default=2, help="auto: passes an object must persist before queueing")
ap.add_argument("--cooldown", type=float, default=5, help="auto: minimum seconds before a label that left and came back may queue again")
ap.add_argument("--max-queue", type=int, default=8)
ap.add_argument("--direct", action="store_true", help="play the queue on the Pi from here (no web app needed)")
ap.add_argument("--cell-ms", type=int, default=900)
ap.add_argument("--space-ms", type=int, default=500)
args = ap.parse_args()
CAMERA = args.camera if args.camera is not None else f"tcp://{args.pi}:8555"
PI_URL = f"http://{args.pi}:8080"

# COCO name -> what the finger should feel
RELABEL = {"cell phone": "phone", "dining table": "table", "tv": "screen", "potted plant": "plant", "handbag": "bag"}
KEEP = {c.strip() for c in args.classes.split(",") if c.strip()}


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
if args.engine is None:
    args.engine = "vlm" if VLM_KEY else "tesseract"

LOCK = threading.Lock()
STATE = {
    "frame": None, "jpeg": None, "frame_at": 0.0, "camera_ok": False,
    "detections": [], "best": None, "mode": args.mode, "queue": collections.deque(),
    "playing": None, "seq": 0, "paused": False, "engine": args.engine,
    "text": {"present": False, "cells": 0, "score": 0.0, "box": None, "since": 0.0},
    "read": {"available": bool(VLM_KEY) or True, "provider": VLM_PROVIDER, "model": None, "text": "", "confidence": 0.0,
             "latency_ms": 0, "at": 0, "requested_at": 0.0, "passes": 0, "raw": "", "error": None, "engine": None},
    "stats": {"fps": 0.0, "infer_ms": 0, "gate_ms": 0, "model": os.path.basename(args.weights), "device": args.device, "passes": 0},
    "log": collections.deque(maxlen=40),
}
COOLDOWN = {}          # label -> last queued time
STABLE = {"label": None, "count": 0}
PRESENT = {}           # label -> time it (re)entered the view
ABSENT = {}            # label -> consecutive passes it has been missing
ABSENT_PASSES = 3
READ_NOW = threading.Event()   # set by the gate (or /analyze) to trigger one text read
FORCE_READ = threading.Event()
LAST_QUEUED_TEXT = {"text": "", "at": 0.0}


def log(msg):
    line = time.strftime("%H:%M:%S ") + msg
    STATE["log"].append(line)
    print(line, flush=True)


# ------------------------------------------------------------------ capture
def capture_loop():
    while True:
        src = int(CAMERA) if CAMERA.isdigit() else CAMERA
        is_image = isinstance(src, str) and src.lower().endswith((".jpg", ".jpeg", ".png"))
        if is_image:   # a still image as a fake camera, handy for tests
            frame = cv2.imread(src)
            with LOCK:
                STATE["frame"], STATE["frame_at"], STATE["camera_ok"] = frame, time.time(), frame is not None
            time.sleep(0.5)
            continue
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


# ------------------------------------------------------------------ objects (YOLO, filtered)
def load_model():
    from ultralytics import YOLO
    try:
        m = YOLO(args.weights)
        m.predict(np.zeros((320, 320, 3), np.uint8), device=args.device, verbose=False)
        return m
    except Exception as e:
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
        name = model.names[int(b.cls)]
        if KEEP and name not in KEEP:
            continue
        x1, y1, x2, y2 = b.xyxy[0].tolist()
        out.append({"kind": "object", "label": RELABEL.get(name, name), "confidence": round(float(b.conf), 3),
                    "box": {"x": round(x1 / W, 4), "y": round(y1 / H, 4), "w": round((x2 - x1) / W, 4), "h": round((y2 - y1) / H, 4)}})
    return out


# ------------------------------------------------------------------ text gate (EAST)
EAST = None


def load_east():
    global EAST
    if os.path.exists(args.east):
        EAST = cv2.dnn.readNet(args.east)
        log(f"text detector: EAST ({os.path.basename(args.east)})")
    else:
        log(f"!! EAST weights missing at {args.east}; text gate disabled (objects only)")


def text_gate(frame, size=320):
    """Is there text in the frame? Returns (cells, max score, normalised union box or None)."""
    if EAST is None:
        return 0, 0.0, None
    H, W = frame.shape[:2]
    blob = cv2.dnn.blobFromImage(frame, 1.0, (size, size), (123.68, 116.78, 103.94), swapRB=True, crop=False)
    EAST.setInput(blob)
    scores, geo = EAST.forward(["feature_fusion/Conv_7/Sigmoid", "feature_fusion/concat_3"])
    sc = scores[0, 0]
    ys, xs = np.where(sc >= args.text_conf)
    if len(xs) == 0:
        return 0, float(sc.max()), None
    rx, ry = W / size, H / size
    x1 = max(0.0, (xs.min() * 4 - geo[0, 3, ys, xs].max()) * rx); x2 = min(W, (xs.max() * 4 + geo[0, 1, ys, xs].max()) * rx)
    y1 = max(0.0, (ys.min() * 4 - geo[0, 0, ys, xs].max()) * ry); y2 = min(H, (ys.max() * 4 + geo[0, 2, ys, xs].max()) * ry)
    box = {"x": round(x1 / W, 4), "y": round(y1 / H, 4), "w": round((x2 - x1) / W, 4), "h": round((y2 - y1) / H, 4)}
    return int(len(xs)), float(sc.max()), box


# ------------------------------------------------------------------ text readers
def frame_to_b64(frame, box=None):
    """JPEG the frame (or a padded crop around the text box) at <= 768 px wide."""
    H, W = frame.shape[:2]
    if box and box["w"] * W > 60 and box["h"] * H > 20:
        px, py = int(box["w"] * W * 0.15) + 12, int(box["h"] * H * 0.3) + 12
        x1, y1 = max(0, int(box["x"] * W) - px), max(0, int(box["y"] * H) - py)
        x2, y2 = min(W, int((box["x"] + box["w"]) * W) + px), min(H, int((box["y"] + box["h"]) * H) + py)
        frame = frame[y1:y2, x1:x2]
        H, W = frame.shape[:2]
    scale = 768 / max(W, 1)
    small = cv2.resize(frame, (768, max(1, int(H * scale)))) if scale < 1 else frame
    ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 75])
    if not ok:
        return None
    import base64
    return base64.b64encode(buf.tobytes()).decode()


def read_prompt():
    try:
        return open(args.prompt).read().strip()
    except OSError:
        return 'Transcribe the most prominent readable text in this photo as JSON {"text": "...", "confidence": 0-1}. Empty text if nothing is legible.'


def parse_read_json(text, latency):
    m = re.search(r"\{.*\}", text, re.S)
    try:
        j = json.loads(m.group(0) if m else text)
    except Exception:
        return {"text": "", "confidence": 0.0, "latency_ms": latency, "raw": text[:300], "error": "unparseable reply"}
    try:
        conf = max(0.0, min(1.0, float(j.get("confidence", 0.5))))
    except (TypeError, ValueError):
        conf = 0.5
    return {"text": str(j.get("text", "")).strip()[:60], "confidence": round(conf, 3), "latency_ms": latency, "raw": text[:300], "error": None}


READ_SCHEMA = {"type": "object", "properties": {"text": {"type": "string"}, "confidence": {"type": "number"}},
               "required": ["text", "confidence"], "additionalProperties": False}


def read_with_claude(model, frame, box):
    b64 = frame_to_b64(frame, box)
    if not b64:
        return None, "jpeg encode failed"
    payload = {
        "model": model, "max_tokens": 1200, "fallbacks": "default",
        "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": READ_SCHEMA}},
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
        return {"text": "", "confidence": 0.0, "latency_ms": latency, "raw": "", "error": "declined by safety classifier"}, None
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()
    return parse_read_json(text, latency), None


def openai_request(path, payload=None, timeout=30):
    req = Request("https://api.openai.com/v1" + path, method="POST" if payload is not None else "GET",
                  headers={"Authorization": f"Bearer {OPENAI_KEY}", "Content-Type": "application/json"},
                  data=json.dumps(payload).encode() if payload is not None else None)
    try:
        with urlopen(req, timeout=timeout) as r:
            return json.load(r), None
    except Exception as e:
        try:
            return None, json.load(e).get("error", {}).get("message", str(e))  # type: ignore[arg-type]
        except Exception:
            return None, str(e)


def read_with_openai(model, frame, box):
    b64 = frame_to_b64(frame, box)
    if not b64:
        return None, "jpeg encode failed"
    payload = {"model": model, "max_output_tokens": 300,
               "input": [{"role": "user", "content": [{"type": "input_text", "text": read_prompt()},
                                                       {"type": "input_image", "image_url": f"data:image/jpeg;base64,{b64}", "detail": "low"}]}]}
    if model.startswith("gpt-5"):
        payload["reasoning"] = {"effort": "low"}
    t = time.time()
    data, err = openai_request("/responses", payload)
    if err:
        return None, err
    text = "".join(c.get("text", "") for item in data.get("output", []) if item.get("type") == "message"
                   for c in item.get("content", []) if c.get("type") == "output_text")
    return parse_read_json(text.strip(), int((time.time() - t) * 1000)), None


WORD_OK = re.compile(r"^[A-Za-z0-9][A-Za-z0-9'&.,:!?-]*$")


def read_with_tesseract(frame, box):
    """Offline reader: Tesseract on the text region."""
    H, W = frame.shape[:2]
    if box:
        x1, y1 = max(0, int(box["x"] * W) - 10), max(0, int(box["y"] * H) - 10)
        x2, y2 = min(W, int((box["x"] + box["w"]) * W) + 10), min(H, int((box["y"] + box["h"]) * H) + 10)
        frame = frame[y1:y2, x1:x2]
    gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        path = f.name
    cv2.imwrite(path, gray)
    t = time.time()
    try:
        tsv = subprocess.run(["tesseract", path, "-", "--psm", "6", "-l", "eng", "tsv"], capture_output=True, timeout=8).stdout.decode("utf-8", "replace")
    except Exception as e:
        return None, f"tesseract failed: {e}"
    finally:
        try: os.unlink(path)
        except OSError: pass
    words, confs = [], []
    for row in tsv.splitlines()[1:]:
        p = row.split("\t")
        if len(p) == 12 and p[10] not in ("-1", "") and float(p[10]) >= 60 and len(p[11].strip()) >= 2 and WORD_OK.match(p[11].strip()):
            words.append(p[11].strip()); confs.append(float(p[10]))
    text = " ".join(words)[:60]
    return {"text": text if sum(c.isalnum() for c in text) >= 3 else "", "confidence": round(sum(confs) / len(confs) / 100, 3) if confs else 0.0,
            "latency_ms": int((time.time() - t) * 1000), "raw": text, "error": None}, None


def pick_vlm_model():
    if args.vlm_model != "auto":
        return args.vlm_model, None
    if VLM_PROVIDER == "anthropic":
        return "claude-opus-5", None
    if VLM_PROVIDER == "openai":
        data, err = openai_request("/models")
        if err:
            return None, err
        ids = {m["id"] for m in data.get("data", [])}
        for pref in ["gpt-5.6", "gpt-5.5", "gpt-5.4", "gpt-5.2", "gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o"]:
            if pref in ids:
                return pref, None
        return None, "no vision-capable gpt model available to this key"
    return None, "no ANTHROPIC_API_KEY / OPENAI_API_KEY in bridge/.env"


def reader_loop():
    """Waits for the gate; performs at most one cloud read per --read-gap seconds."""
    model, err = pick_vlm_model()
    with LOCK:
        STATE["read"]["model"] = model
        STATE["read"]["error"] = err
    if err:
        log(f"cloud reader unavailable ({err}); Tesseract will read text")
    else:
        log(f"text reader: {VLM_PROVIDER} {model}; gate = EAST, min gap {args.read_gap:.0f} s")
    while True:
        READ_NOW.wait()
        READ_NOW.clear()
        forced = FORCE_READ.is_set()
        FORCE_READ.clear()
        with LOCK:
            frame, box, engine, paused = STATE["frame"], STATE["text"]["box"], STATE["engine"], STATE["paused"]
            since = time.time() - STATE["read"]["requested_at"]
        if frame is None or paused or engine == "none":
            continue
        if not forced and since < args.read_gap:
            continue
        use_cloud = engine == "vlm" and model is not None
        with LOCK:
            STATE["read"]["requested_at"] = time.time()
        if use_cloud:
            res, rerr = read_with_claude(model, frame, box) if VLM_PROVIDER == "anthropic" else read_with_openai(model, frame, box)
            eng = VLM_PROVIDER
        else:
            res, rerr = read_with_tesseract(frame, box)
            eng = "tesseract"
        with LOCK:
            r = STATE["read"]
            r["passes"] += 1
            r["at"] = int(time.time() * 1000)
            r["engine"] = eng
            if rerr:
                r["error"] = rerr
            else:
                r.update(res)
        if rerr:
            log(f"read error ({eng}): {rerr[:120]}")
        elif res.get("error"):
            log(f"read ({eng}): {res['error']}")
        else:
            log(f"read ({eng}, {res['latency_ms']} ms): {res['text']!r} ({int(res['confidence'] * 100)}%)")
            if res["text"] and len(res["text"].strip()) >= 2:
                maybe_queue_text(res["text"].strip(), res["confidence"])


# ------------------------------------------------------------------ choosing + queueing
def current_text_detection():
    """The last read text, while text is still in view and the read is fresh."""
    with LOCK:
        r, tg = dict(STATE["read"]), dict(STATE["text"])
    if not r.get("text") or not tg["present"] or time.time() * 1000 - r.get("at", 0) > 15000:
        return None
    return {"kind": "text", "label": r["text"], "confidence": r["confidence"], "box": tg["box"] or {"x": 0.15, "y": 0.4, "w": 0.7, "h": 0.2},
            "engine": r.get("engine") or "vlm"}


def choose_best(dets):
    """Text always wins; otherwise the most confident, largest listed object."""
    texts = [d for d in dets if d["kind"] == "text" and d.get("engine") != "east"]
    if texts:
        return texts[0]
    objs = [d for d in dets if d["kind"] == "object"]
    if objs:
        return max(objs, key=lambda d: d["confidence"] * (d["box"]["w"] * d["box"]["h"]) ** 0.5)
    return None


def annotate(frame, dets, best):
    img = frame.copy()
    H, W = img.shape[:2]
    for d in dets:
        b = d["box"]; x1, y1 = int(b["x"] * W), int(b["y"] * H); x2, y2 = int((b["x"] + b["w"]) * W), int((b["y"] + b["h"]) * H)
        col = (60, 220, 60) if d["kind"] == "text" else (255, 180, 40)
        thick = 3 if best is d else 1
        cv2.rectangle(img, (x1, y1), (x2, y2), col, thick)
        tag = f'{d["label"]} {int(d["confidence"] * 100)}%' if d.get("engine") != "east" else "text?"
        cv2.putText(img, tag, (x1, max(14, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, col, 2)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 75])
    return buf.tobytes() if ok else None


def enqueue(det, reason):
    with LOCK:
        if len(STATE["queue"]) >= args.max_queue:
            STATE["queue"].popleft()
        STATE["seq"] += 1
        item = dict(det, id=f"cam-{STATE['seq']}", at=int(time.time() * 1000), source="camera")
        item.pop("engine", None)
        STATE["queue"].append(item)
    COOLDOWN[det["label"].lower()] = time.time()
    log(f"queued [{reason}] {det['kind']}: {det['label']!r} ({int(det['confidence'] * 100)}%)  queue={len(STATE['queue'])}")
    return item


def maybe_queue_text(text, conf):
    with LOCK:
        mode, box = STATE["mode"], STATE["text"]["box"]
    if mode != "auto":
        return
    if text.lower() == LAST_QUEUED_TEXT["text"].lower() and time.time() - LAST_QUEUED_TEXT["at"] < 30:
        return
    LAST_QUEUED_TEXT.update(text=text, at=time.time())
    enqueue({"kind": "text", "label": text, "confidence": conf, "box": box or {"x": 0.15, "y": 0.4, "w": 0.7, "h": 0.2}}, "auto text")


def detect_loop():
    model = load_model()
    load_east()
    log(f"objects: {STATE['stats']['model']} on {args.device}, keeping {len(KEEP)} classes; mode={STATE['mode']}")
    passes = 0
    text_streak = 0
    while True:
        with LOCK:
            frame, paused = STATE["frame"], STATE["paused"]
        if frame is None:
            time.sleep(0.2)
            continue
        if paused:
            ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
            with LOCK:
                STATE["detections"], STATE["best"] = [], None
                STATE["text"].update(present=False, cells=0, box=None)
                if ok:
                    STATE["jpeg"] = buf.tobytes()
            time.sleep(0.3)
            continue
        t = time.time()
        dets = run_yolo(model, frame)
        infer_ms = int((time.time() - t) * 1000)
        t = time.time()
        cells, score, box = text_gate(frame)
        gate_ms = int((time.time() - t) * 1000)
        present = cells >= args.text_cells
        text_streak = text_streak + 1 if present else 0
        passes += 1
        with LOCK:
            tg = STATE["text"]
            if present and not tg["present"]:
                tg["since"] = time.time()
            tg.update(present=present, cells=cells, score=round(score, 3), box=box if present else None)
        if present:
            dets.append({"kind": "text", "label": "text", "confidence": round(score, 3), "box": box, "engine": "east"})
            if text_streak >= 2:
                READ_NOW.set()          # the reader enforces the 5 s gap
        td = current_text_detection()
        if td:
            dets.insert(0, td)
        best = choose_best(dets)
        jpeg = annotate(frame, dets, best)
        with LOCK:
            STATE["detections"] = dets
            STATE["best"] = best
            STATE["jpeg"] = jpeg
            STATE["stats"].update(infer_ms=infer_ms, gate_ms=gate_ms, passes=passes)
            mode = STATE["mode"]
        # object arrival tracking (text is queued by the reader when it comes back)
        now = time.time()
        seen = {d["label"].lower() for d in dets if d["kind"] == "object"}
        for lbl in seen:
            ABSENT[lbl] = 0
            PRESENT.setdefault(lbl, now)
        for lbl in list(PRESENT):
            if lbl not in seen:
                ABSENT[lbl] = ABSENT.get(lbl, 0) + 1
                if ABSENT[lbl] >= ABSENT_PASSES:
                    del PRESENT[lbl]
        label = best["label"].lower() if best and best["kind"] == "object" else None
        if label == STABLE["label"]:
            STABLE["count"] += 1
        else:
            STABLE["label"], STABLE["count"] = label, 1
        if mode == "auto" and best and best["kind"] == "object" and STABLE["count"] >= args.stable and not present:
            if PRESENT.get(label, now) > COOLDOWN.get(label, 0) and now - COOLDOWN.get(label, 0) > args.cooldown:
                enqueue(best, "auto")
        time.sleep(max(0.0, args.interval - (infer_ms + gate_ms) / 1000.0))


# ------------------------------------------------------------------ direct playback on the Pi
def pi(path, method="POST"):
    with urlopen(Request(PI_URL + path, method=method), timeout=4) as r:
        return json.load(r)


def direct_loop():
    log("direct mode: this bridge plays the queue on the Pi")
    while True:
        try:
            st = pi("/state", "GET")
            if not st["braille"]["playing"] and not st.get("locked"):
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
        item = STATE["queue"].popleft() if STATE["queue"] else None
        if item:
            STATE["playing"] = item
    return item


# ------------------------------------------------------------------ http
def snapshot():
    with LOCK:
        r = dict(STATE["read"])
        gap_left = max(0.0, args.read_gap - (time.time() - r["requested_at"]))
        return {
            "camera_ok": STATE["camera_ok"], "frame_age_ms": int((time.time() - STATE["frame_at"]) * 1000) if STATE["frame_at"] else None,
            "detections": STATE["detections"], "best": STATE["best"], "mode": STATE["mode"], "paused": STATE["paused"], "engine": STATE["engine"],
            "queue": list(STATE["queue"]), "playing": STATE["playing"], "stats": dict(STATE["stats"]),
            "text": dict(STATE["text"]), "read": dict(r, gap_left_ms=int(gap_left * 1000), read_gap_ms=int(args.read_gap * 1000)),
            "classes": sorted(RELABEL.get(c, c) for c in KEEP), "direct": args.direct, "log": list(STATE["log"])[-8:],
        }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _headers(self, code, ctype, length=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        if length is not None:
            self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
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
                best, paused = STATE["best"], STATE["paused"]
            if paused:
                return self._json(423, {"item": None, "error": "camera is paused"})
            if not best:
                return self._json(200, {"item": None, "error": "nothing detected in the current frame"})
            return self._json(200, {"item": enqueue(best, "capture")})
        if u.path == "/queue":
            text = q.get("text", [""])[0].strip()
            if not text:
                return self._json(400, {"error": "text required"})
            return self._json(200, {"item": enqueue({"kind": q.get("kind", ["text"])[0], "label": text, "confidence": 1.0,
                                                     "box": {"x": 0.14, "y": 0.4, "w": 0.72, "h": 0.2}}, "manual")})
        if u.path == "/clear":
            with LOCK:
                STATE["queue"].clear()
            log("queue cleared")
            return self._json(200, snapshot())
        if u.path == "/analyze":
            FORCE_READ.set(); READ_NOW.set()
            return self._json(200, {"ok": True})
        if u.path == "/engine":
            v = q.get("value", [""])[0]
            if v not in ("vlm", "tesseract", "none"):
                return self._json(400, {"error": "value must be vlm, tesseract or none"})
            with LOCK:
                STATE["engine"] = v
            log(f"text reader -> {v}")
            return self._json(200, snapshot())
        if u.path == "/pause":
            v = q.get("value", ["1"])[0]
            with LOCK:
                STATE["paused"] = v not in ("0", "false", "off")
                paused = STATE["paused"]
            log("CAMERA PAUSED" if paused else "camera resumed")
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
    threading.Thread(target=reader_loop, daemon=True).start()
    if args.direct:
        threading.Thread(target=direct_loop, daemon=True).start()
    log(f"bridge on http://0.0.0.0:{args.port}  camera={CAMERA}  pi={PI_URL}")
    try:
        ThreadingHTTPServer(("0.0.0.0", args.port), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
