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
args = ap.parse_args()
CAMERA = args.camera if args.camera is not None else f"tcp://{args.pi}:8555"
PI_URL = f"http://{args.pi}:8080"

LOCK = threading.Lock()
STATE = {
    "frame": None, "jpeg": None, "frame_at": 0.0, "camera_ok": False,
    "detections": [], "best": None, "mode": args.mode, "queue": collections.deque(),
    "playing": None, "seq": 0, "last_next_at": 0.0,
    "stats": {"fps": 0.0, "infer_ms": 0, "ocr_ms": 0, "model": os.path.basename(args.weights), "device": args.device, "passes": 0},
    "log": collections.deque(maxlen=40),
}
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


def choose_best(dets):
    """Prefer readable text; otherwise the most confident, largest object."""
    texts = [d for d in dets if d["kind"] == "text"]
    if texts:
        return max(texts, key=lambda d: d["confidence"] * len(d["label"]))
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
        if args.ocr_every and passes % args.ocr_every == 0:
            t = time.time()
            dets += run_ocr(frame)
            ocr_ms = int((time.time() - t) * 1000)
        best = choose_best(dets)
        jpeg = annotate(frame, dets, best)
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
    if args.direct:
        threading.Thread(target=direct_loop, daemon=True).start()
    log(f"bridge on http://0.0.0.0:{args.port}  camera={CAMERA}  pi={PI_URL}")
    try:
        ThreadingHTTPServer(("0.0.0.0", args.port), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
