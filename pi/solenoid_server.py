#!/usr/bin/env python3
"""Solenoid / braille-cell controller for the Pi Zero 2 W.

The six solenoids are the six dots of one braille cell (1-2-3 left column,
4-5-6 right column). Each is a ULN2803 driven from one GPIO, high = on.

HTTP on port 8080 (CORS open, so the visualizer can call it from anywhere):

  GET  /                          simple button panel + braille text box
  GET  /app/                      the Braille Pin Visualizer build, if copied to ~/www
  GET  /state                     JSON: dots, current mask, braille playback status
  POST /cell?mask=19&ms=900       raise exactly the dots in a 6-bit mask (bit n-1 = dot n)
  POST /pulse/<n>?ms=150          pulse dot n
  POST /on/<n>  /off/<n>          hold / release dot n (auto-off after max_on_ms)
  POST /alloff                    everything down, stop braille playback
  POST /lock?value=1|0            safety latch: while locked, cell/pulse/on/braille return 423
  POST /wifi?mode=ap|client       host the IMG2BRL hotspot (Pi at 10.42.0.1) or rejoin saved Wi-Fi
  POST /braille?text=Hello&cell_ms=900&space_ms=500&gap_ms=120&caps=1&loop=0&kind=text|speech
                                  play text as braille, one cell at a time, on the Pi's clock
                                  (kind prefixes the speech/text indicator cell)
  POST /braille/stop
  GET  /encode?text=Hello         the cell sequence for a text (same encoder as the web app)

Pins and timings live in ~/solenoids.json.
"""
import json, mimetypes, os, re, signal, subprocess, sys, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from gpiozero import DigitalOutputDevice

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from braille import encode_text  # noqa: E402

CONFIG = os.path.expanduser("~/solenoids.json")
DEFAULTS = {
    "pins": [17, 27, 24, 23, 25, 22],   # BCM GPIO for dot 1..6
    "active_high": True,
    "pulse_ms": 150,
    "max_on_ms": 2000,                  # safety: a dot is never energised longer than this
    "cell_ms": 900,                     # braille: hold per cell
    "space_ms": 500,                    # braille: hold per space
    "gap_ms": 120,                      # braille: all-down gap between cells (so "ll" reads as two)
    "port": 8080,
    "www_dir": os.path.expanduser("~/www"),
}
cfg = dict(DEFAULTS)
if os.path.exists(CONFIG):
    cfg.update(json.load(open(CONFIG)))
json.dump(cfg, open(CONFIG, "w"), indent=2)


class Solenoid:
    def __init__(self, idx, pin):
        self.idx, self.pin = idx, pin
        self.dev = DigitalOutputDevice(pin, active_high=cfg["active_high"], initial_value=False)
        self.on_since = None
        self.timer = None
        self.lock = threading.Lock()

    def _cancel(self):
        if self.timer:
            self.timer.cancel()
            self.timer = None

    def on(self, ms=None):
        with self.lock:
            self._cancel()
            self.dev.on()
            self.on_since = time.monotonic()
            limit = min(ms, cfg["max_on_ms"]) if ms else cfg["max_on_ms"]
            self.timer = threading.Timer(limit / 1000.0, self.off)
            self.timer.daemon = True
            self.timer.start()

    def off(self):
        with self.lock:
            self._cancel()
            self.dev.off()
            self.on_since = None

    @property
    def is_on(self):
        return bool(self.dev.value)

    def state(self):
        return {"id": self.idx, "pin": self.pin, "on": self.is_on,
                "on_ms": int((time.monotonic() - self.on_since) * 1000) if self.on_since else 0}


SOLENOIDS = [Solenoid(i + 1, p) for i, p in enumerate(cfg["pins"])]
LOG = []
LOCKED = False   # safety latch: while True every actuation request is refused (HTTP 423)


def log(msg):
    line = time.strftime("%H:%M:%S ") + msg
    LOG.append(line)
    del LOG[:-60]
    print(line, flush=True)


def all_off():
    for s in SOLENOIDS:
        s.off()


def set_mask(mask, ms=None):
    """Raise exactly the dots in mask (others go down)."""
    for s in SOLENOIDS:
        if mask & (1 << (s.idx - 1)):
            s.on(ms)
        else:
            s.off()


def current_mask():
    return sum(1 << (s.idx - 1) for s in SOLENOIDS if s.is_on)


def glyph(mask):
    return chr(0x2800 + mask)


# ---------------------------------------------------------------- braille player
class BraillePlayer(threading.Thread):
    def __init__(self, text, cell_ms, space_ms, gap_ms, caps, loop, kind=None):
        super().__init__(daemon=True)
        self.text = text
        self.cells = encode_text(text, capital_indicators=caps, kind=kind)
        self.cell_ms, self.space_ms, self.gap_ms, self.loop = cell_ms, space_ms, gap_ms, loop
        self.stop_evt = threading.Event()
        self.index = -1
        self.done = False

    def run(self):
        try:
            while not self.stop_evt.is_set():
                for i, c in enumerate(self.cells):
                    if self.stop_evt.is_set():
                        return
                    self.index = i
                    hold = self.space_ms if c["kind"] == "space" else self.cell_ms
                    set_mask(c["mask"], hold + 100)      # the timer is a backstop; we release below
                    log(f"braille {i + 1}/{len(self.cells)} {c['glyph']} {c['label']!r} {hold} ms")
                    if self.stop_evt.wait(hold / 1000.0):
                        return
                    if self.gap_ms and c["mask"] and i + 1 < len(self.cells):
                        all_off()
                        if self.stop_evt.wait(self.gap_ms / 1000.0):
                            return
                if not self.loop:
                    return
                all_off()
                if self.stop_evt.wait(self.space_ms / 1000.0):
                    return
        finally:
            all_off()
            self.index = len(self.cells)
            self.done = True

    def status(self):
        cur = self.cells[self.index] if 0 <= self.index < len(self.cells) else None
        return {"playing": self.is_alive() and not self.done, "text": self.text,
                "index": self.index, "total": len(self.cells),
                "label": cur["label"] if cur else "", "mask": cur["mask"] if cur else 0,
                "glyph": cur["glyph"] if cur else "", "preview": "".join(c["glyph"] for c in self.cells),
                "cell_ms": self.cell_ms, "space_ms": self.space_ms, "gap_ms": self.gap_ms, "loop": self.loop}


PLAYER = None
PLAYER_LOCK = threading.Lock()
IDLE_BRAILLE = {"playing": False, "text": "", "index": -1, "total": 0, "label": "", "mask": 0, "glyph": "", "preview": ""}


def stop_braille():
    global PLAYER
    with PLAYER_LOCK:
        p, PLAYER = PLAYER, None
    if p and p.is_alive():
        p.stop_evt.set()
        if threading.current_thread() is not p:
            p.join(timeout=1.0)
        log("braille stopped")


def start_braille(text, cell_ms, space_ms, gap_ms, caps, loop, kind=None):
    global PLAYER
    stop_braille()
    p = BraillePlayer(text, cell_ms, space_ms, gap_ms, caps, loop, kind)
    with PLAYER_LOCK:
        PLAYER = p
    log(f"braille start {text!r} -> {len(p.cells)} cells {p.status()['preview']}")
    p.start()
    return p


def braille_status():
    p = PLAYER
    return p.status() if p else dict(IDLE_BRAILLE)


# ---------------------------------------------------------------- http
HTML = """<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Braille Cell Panel</title>
<style>
:root{--bg:#111318;--card:#1b1f27;--fg:#e8eaf0;--mute:#8b93a7;--acc:#3b82f6;--hot:#f59e0b;--red:#ef4444}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px system-ui,-apple-system,sans-serif;padding:16px}
h1{font-size:18px;font-weight:600;margin:0 0 4px}.sub{color:var(--mute);font-size:13px;margin-bottom:16px}
.wrap{max-width:720px}
.cell{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;max-width:340px}
button.sol{background:var(--card);color:var(--fg);border:2px solid #2a3040;border-radius:14px;padding:26px 10px;font-size:20px;font-weight:600;cursor:pointer;user-select:none;-webkit-user-select:none;touch-action:manipulation;transition:background .08s,border-color .08s}
button.sol small{display:block;font-size:12px;color:var(--mute);font-weight:400;margin-top:6px}
button.sol:active{border-color:var(--acc)}button.sol.on{background:#3a2a05;border-color:var(--hot);box-shadow:0 0 0 3px #f59e0b33}
.row{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin-top:18px;color:var(--mute);font-size:14px}
.row label{display:flex;align-items:center;gap:8px}input[type=range]{width:160px}
.alloff{background:var(--red);color:#fff;border:0;border-radius:10px;padding:12px 18px;font-weight:700;cursor:pointer;margin-left:auto}
.btn{background:var(--acc);color:#fff;border:0;border-radius:10px;padding:12px 18px;font-weight:700;cursor:pointer}
.txt{flex:1;min-width:200px;background:var(--card);color:var(--fg);border:1px solid #2a3040;border-radius:10px;padding:12px;font-size:16px}
#now{font-size:44px;line-height:1;min-width:56px;text-align:center}
#log{margin-top:16px;font:12px ui-monospace,Menlo,monospace;color:var(--mute);white-space:pre-wrap;max-height:120px;overflow:auto}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;margin-right:6px}.dot.bad{background:var(--red)}
a{color:var(--acc)}
</style></head><body><div class=wrap>
<h1>Braille Cell Panel</h1>
<div class=sub><span id=dot class=dot></span><span id=conn>connecting…</span> · click a dot = pulse · keys 1–6 · <a href="/app/">open the visualizer</a></div>
<div class=cell id=grid></div>
<div class=row>
 <label>Pulse <input type=range id=ms min=30 max=1000 step=10 value=150> <b id=msv>150 ms</b></label>
 <label><input type=checkbox id=hold> Hold mode (max <span id=maxon>2000</span> ms)</label>
 <button class=alloff onclick="post('/alloff')">ALL OFF</button>
 <button class=btn id=lockbtn style="background:#374151" onclick="toggleLock()">Lock pins</button>
</div>
<div class=row>
 <input class=txt id=text placeholder="Type text to play as braille, e.g. Hello 42">
 <label>Cell <input type=number id=cellms value=900 min=200 max=2000 step=50 style="width:70px"> ms</label>
 <button class=btn onclick="playText()">Play</button>
 <button class=btn style="background:#374151" onclick="post('/braille/stop')">Stop</button>
 <span id=now>⠀</span>
</div>
<div id=log></div></div>
<script>
const grid=document.getElementById('grid'),ms=document.getElementById('ms'),msv=document.getElementById('msv'),hold=document.getElementById('hold');
const ORDER=[1,4,2,5,3,6];let btns={};
function post(p){return fetch(p,{method:'POST'}).then(r=>r.json()).then(render).catch(()=>setConn(false));}
function setConn(ok){document.getElementById('dot').className='dot'+(ok?'':' bad');document.getElementById('conn').textContent=ok?'connected to Pi':'Pi not reachable';}
let locked=false;function toggleLock(){post('/lock?value='+(locked?0:1));}
function playText(){const t=document.getElementById('text').value.trim();if(!t)return;post('/braille?text='+encodeURIComponent(t)+'&cell_ms='+document.getElementById('cellms').value);}
function render(st){setConn(true);if(!Object.keys(btns).length){ORDER.forEach(id=>{const s=st.solenoids[id-1];const b=document.createElement('button');b.className='sol';b.innerHTML=`Dot ${s.id}<small>GPIO ${s.pin}</small>`;
 b.onpointerdown=e=>{e.preventDefault();if(hold.checked){b.setPointerCapture(e.pointerId);post('/on/'+s.id);}else post(`/pulse/${s.id}?ms=${ms.value}`);};
 const rel=()=>{if(hold.checked)post('/off/'+s.id);};b.onpointerup=rel;b.onpointercancel=rel;b.onpointerleave=e=>{if(hold.checked&&e.buttons)rel();};
 grid.appendChild(b);btns[id]=b;});document.getElementById('maxon').textContent=st.max_on_ms;ms.value=st.pulse_ms;msv.textContent=st.pulse_ms+' ms';}
 st.solenoids.forEach(s=>btns[s.id].classList.toggle('on',s.on));document.getElementById('now').textContent=String.fromCodePoint(0x2800+st.mask);
 locked=!!st.locked;const lb=document.getElementById('lockbtn');lb.textContent=locked?'🔒 PINS LOCKED — click to unlock':'Lock pins';lb.style.background=locked?'#b3261e':'#374151';
 document.getElementById('log').textContent=(st.log||[]).slice(-6).reverse().join('\\n');}
ms.oninput=()=>msv.textContent=ms.value+' ms';
document.addEventListener('keydown',e=>{if(e.target.tagName==='INPUT')return;const n=parseInt(e.key);if(n>=1&&n<=6&&!e.repeat)post(`/pulse/${n}?ms=${ms.value}`);if(e.key==='Escape')post('/alloff');});
document.getElementById('text').addEventListener('keydown',e=>{if(e.key==='Enter')playText();});
window.addEventListener('blur',()=>{if(hold.checked)post('/alloff');});
setInterval(()=>fetch('/state').then(r=>r.json()).then(render).catch(()=>setConn(false)),300);
fetch('/state').then(r=>r.json()).then(render).catch(()=>setConn(false));
</script></body></html>"""


AP_CON = "IMG2BRL-AP"


_WIFI_CACHE = {"at": 0.0, "info": None}


def wifi_info():
    """Cached for 5 s: asking NetworkManager costs ~130 ms, far too slow for every reply."""
    now = time.time()
    if _WIFI_CACHE["info"] is None or now - _WIFI_CACHE["at"] > 5.0:
        _WIFI_CACHE["info"], _WIFI_CACHE["at"] = _wifi_info_uncached(), now
    return _WIFI_CACHE["info"]


def _wifi_info_uncached():
    """Which Wi-Fi mode the Pi is in, from NetworkManager."""
    try:
        out = subprocess.run(["nmcli", "-t", "-f", "DEVICE,STATE,CONNECTION", "dev", "status"], capture_output=True, text=True, timeout=5).stdout
        con = next((l.split(":")[2] for l in out.splitlines() if l.startswith("wlan0:")), "")
        ip = subprocess.run(["sh", "-c", "ip -4 -o addr show wlan0 | awk '{print $4}' | cut -d/ -f1"], capture_output=True, text=True, timeout=5).stdout.strip()
        return {"mode": "ap" if con == AP_CON else ("client" if con else "off"), "connection": con, "ip": ip or None, "ap_ssid": "IMG2BRL"}
    except Exception as e:
        return {"mode": "unknown", "connection": "", "ip": None, "error": str(e)}


def _nm(*argv, timeout=40):
    r = subprocess.run(["sudo", "nmcli", *argv], capture_output=True, text=True, timeout=timeout)
    return r.returncode == 0, re.sub(r"\x1b\[[0-9;]*[A-Za-z]|\r", "", (r.stdout or r.stderr)).strip()


def wifi_switch(mode):
    """ap: host the IMG2BRL hotspot; client: rejoin saved networks, highest priority first."""
    if mode == "ap":
        ok, msg = _nm("con", "up", AP_CON)
        _WIFI_CACHE["info"] = None
        log(f"wifi -> ap: {msg[:100]}")
        return ok
    _WIFI_CACHE["info"] = None
    _nm("con", "down", AP_CON, timeout=15)
    out = subprocess.run(["nmcli", "-t", "-f", "NAME,TYPE,AUTOCONNECT-PRIORITY", "con", "show"], capture_output=True, text=True, timeout=10).stdout
    saved = sorted(((int(p or 0), n) for n, t, p in (l.split(":") for l in out.splitlines() if l.count(":") == 2)
                    if t == "802-11-wireless" and n != AP_CON), reverse=True)
    for _, name in saved:
        ok, msg = _nm("con", "up", name)
        log(f"wifi -> client {name!r}: {msg[:80]}")
        if ok:
            return True
    return False


def state():
    return {"solenoids": [s.state() for s in SOLENOIDS], "mask": current_mask(), "glyph": glyph(current_mask()),
            "pulse_ms": cfg["pulse_ms"], "max_on_ms": cfg["max_on_ms"], "cell_ms": cfg["cell_ms"],
            "space_ms": cfg["space_ms"], "gap_ms": cfg["gap_ms"], "active_high": cfg["active_high"],
            "pins": cfg["pins"], "locked": LOCKED, "braille": braille_status(), "wifi": wifi_info(), "app": os.path.isfile(os.path.join(cfg["www_dir"], "index.html")),
            "log": LOG[-10:]}


def qint(q, key, default, lo, hi):
    try:
        v = int(str(q.get(key, [default])[0]), 0)
    except ValueError:
        v = default
    return max(lo, min(v, hi))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _headers(self, code, ctype, length):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _send(self, code, body, ctype="application/json"):
        data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        self._headers(code, ctype, len(data))
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._headers(204, "text/plain", 0)

    def _static(self, parts):
        root = os.path.realpath(cfg["www_dir"])
        rel = "/".join(parts) or "index.html"
        path = os.path.realpath(os.path.join(root, rel))
        if not path.startswith(root + os.sep) and path != root:
            return self._send(403, {"error": "forbidden"})
        if os.path.isdir(path):
            path = os.path.join(path, "index.html")
        if not os.path.isfile(path):
            if "." not in os.path.basename(rel):          # SPA fallback
                path = os.path.join(root, "index.html")
            if not os.path.isfile(path):
                return self._send(404, "Visualizer not installed: copy the web build to %s" % cfg["www_dir"], "text/plain")
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        with open(path, "rb") as f:
            data = f.read()
        self._headers(200, ctype, len(data))
        self.wfile.write(data)

    def _act(self):
        u = urlparse(self.path)
        parts = [p for p in u.path.split("/") if p]
        q = parse_qs(u.query)
        try:
            if not parts:
                return self._send(200, HTML, "text/html; charset=utf-8")
            if parts[0] == "app":
                return self._static(parts[1:])
            if parts[0] == "state":
                return self._send(200, state())
            if parts[0] == "encode":
                text = q.get("text", [""])[0]
                return self._send(200, {"text": text, "cells": encode_text(text, q.get("caps", ["1"])[0] != "0", kind=q.get("kind", [None])[0])})
            if parts[0] == "alloff":
                stop_braille(); all_off(); log("ALL OFF")
                return self._send(200, state())
            if parts[0] == "wifi":
                mode = q.get("mode", [""])[0]
                if mode not in ("ap", "client"):
                    return self._send(400, {"error": "mode must be ap or client"})
                ok = wifi_switch(mode)
                return self._send(200 if ok else 500, state())
            if parts[0] == "lock":
                global LOCKED
                v = q.get("value", ["1"])[0]
                LOCKED = v not in ("0", "false", "off")
                if LOCKED:
                    stop_braille(); all_off()
                log("PINS LOCKED" if LOCKED else "pins unlocked")
                return self._send(200, state())
            if parts[0] in ("cell", "braille", "pulse", "on", "off") and LOCKED and not (parts[0] == "braille" and len(parts) > 1 and parts[1] == "stop"):
                return self._send(423, dict(state(), error="pins are locked"))
            if parts[0] == "cell":
                stop_braille()
                mask = qint(q, "mask", 0, 0, 63)
                ms = qint(q, "ms", cfg["cell_ms"], 10, cfg["max_on_ms"])
                set_mask(mask, ms)
                log(f"cell {glyph(mask)} mask=0b{mask:06b} {ms} ms")
                return self._send(200, state())
            if parts[0] == "braille":
                if len(parts) > 1 and parts[1] == "stop":
                    stop_braille(); all_off()
                    return self._send(200, state())
                text = q.get("text", [""])[0].strip()
                if not text:
                    return self._send(400, {"error": "text is required"})
                start_braille(text,
                              qint(q, "cell_ms", cfg["cell_ms"], 100, cfg["max_on_ms"]),
                              qint(q, "space_ms", cfg["space_ms"], 50, 5000),
                              qint(q, "gap_ms", cfg["gap_ms"], 0, 2000),
                              q.get("caps", ["1"])[0] != "0",
                              q.get("loop", ["0"])[0] == "1",
                              q.get("kind", [None])[0])
                time.sleep(0.05)
                return self._send(200, state())
            if parts[0] in ("pulse", "on", "off"):
                stop_braille()
                n = int(parts[1])
                s = SOLENOIDS[n - 1]
                if parts[0] == "pulse":
                    ms = qint(q, "ms", cfg["pulse_ms"], 10, cfg["max_on_ms"])
                    s.on(ms); log(f"pulse dot {n} (GPIO {s.pin}) {ms} ms")
                elif parts[0] == "on":
                    s.on(); log(f"HOLD dot {n} (GPIO {s.pin})")
                else:
                    s.off(); log(f"release dot {n}")
                return self._send(200, state())
            return self._send(404, {"error": "unknown path"})
        except (IndexError, ValueError):
            return self._send(400, {"error": "dot id must be 1..%d" % len(SOLENOIDS)})

    do_GET = _act
    do_POST = _act


def shutdown(*_):
    stop_braille()
    all_off()
    sys.exit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    all_off()
    log(f"braille cell server on :{cfg['port']} dots->GPIO {cfg['pins']} active_high={cfg['active_high']}")
    try:
        ThreadingHTTPServer(("0.0.0.0", cfg["port"]), Handler).serve_forever()
    finally:
        all_off()
