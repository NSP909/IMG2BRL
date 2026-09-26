#!/usr/bin/env python3
"""Play text as braille on the solenoid cell, from the command line.

  braille_play.py "Hello 42"                 default timing (900 ms per cell)
  braille_play.py "EXIT" --cell-ms 600 --space-ms 400 --gap-ms 100 --loop
  braille_play.py --stop

Talks to the running solenoid server (so nothing fights over the GPIO).
"""
import argparse, json, sys, time, urllib.parse, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("text", nargs="*")
ap.add_argument("--cell-ms", type=int, default=900)
ap.add_argument("--space-ms", type=int, default=500)
ap.add_argument("--gap-ms", type=int, default=120)
ap.add_argument("--no-caps", action="store_true", help="skip capital indicators")
ap.add_argument("--loop", action="store_true")
ap.add_argument("--stop", action="store_true")
ap.add_argument("--host", default="localhost:8080")
a = ap.parse_args()
base = f"http://{a.host}"


def call(path, method="POST"):
    with urllib.request.urlopen(urllib.request.Request(base + path, method=method), timeout=5) as r:
        return json.load(r)


if a.stop:
    call("/braille/stop"); print("stopped"); sys.exit(0)
text = " ".join(a.text).strip()
if not text:
    ap.print_help(); sys.exit(1)

cells = call("/encode?text=" + urllib.parse.quote(text), "GET")["cells"]
print(f"{text!r} -> {len(cells)} cells: " + "".join(c["glyph"] for c in cells))
for c in cells:
    print(f"  {c['glyph']}  {c['label']!r:6} dots {','.join(map(str, c['dots'])) or '-':10} {c['description']}")
q = f"text={urllib.parse.quote(text)}&cell_ms={a.cell_ms}&space_ms={a.space_ms}&gap_ms={a.gap_ms}&caps={0 if a.no_caps else 1}&loop={1 if a.loop else 0}"
call("/braille?" + q)
print("playing… (Ctrl-C stops)")
try:
    last = None
    while True:
        b = call("/state", "GET")["braille"]
        if not b["playing"]:
            break
        if b["index"] != last:
            last = b["index"]
            print(f"\r  cell {b['index'] + 1}/{b['total']}  {b['glyph']}  {b['label']!r}     ", end="", flush=True)
        time.sleep(0.1)
    print("\ndone")
except KeyboardInterrupt:
    call("/braille/stop"); print("\nstopped")
