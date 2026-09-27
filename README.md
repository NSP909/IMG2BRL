# Braille Pin Visualizer

Front end for the deafblind camera/sound-to-braille project. It shows what the
active recognizer produced (an object label, visible text, or a name-triggered
spoken utterance), turns it into braille,
and plays it back one 3 × 2 cell at a time, the way the finger module will.
While the hardware is still being built, the pin actuator is simulated on a
timer.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-checks, then writes a static build to dist/
npm run preview    # serves dist/
```

Node 18+ and npm. The recognition bridge uses Python 3.11; camera and sound
dependencies are listed in `bridge/requirements.txt`.

## What you see

| Panel | Purpose |
| --- | --- |
| Camera | Viewfinder with a simulated capture. **Capture frame** runs a short scan and returns the next sample detection. **Use camera** shows your real webcam behind the overlay; detection stays simulated. |
| Detected | The label, whether it is an object or text, confidence, and how many braille cells it needs. |
| Send text | Type anything and send it to the pins. Useful for testing without the camera. |
| On the finger now | The current cell at finger scale, with standard dot numbers, the character, the Unicode braille glyph, and the 6-bit pin mask. Transport controls and a hold bar that fills over the cell's hold time. |
| Sequence | Every cell of the message in order. Click a cell to jump to it. |
| Pin actuator | Each of the six pins as UP or down, the mask and byte, and a log of the last frames the controller would have received. |
| Timing | Hold per cell, hold per space, repeat, and whether capital indicators are emitted. |

## Code layout

```
src/
  lib/braille.ts          six-dot model, text → cells encoder, mask/Unicode helpers
  lib/detections.ts       Detection type and the simulated samples
  hooks/useCellStream.ts  timed playback of cells (play, pause, step, seek, loop)
  hooks/useCamera.ts      optional webcam preview
  components/             one file per panel; BrailleCellView draws any cell
  App.tsx                 wires detection → cells → stream → panels
  styles.css              design tokens and all styling
```

## Braille conventions

Uncontracted (Grade 1) braille, one cell per character.

- Dots are numbered 1–3 down the left column and 4–6 down the right.
- A capital letter is preceded by dot 6. A whole uppercase word gets dot 6 twice.
- Digits are preceded once by the number sign (dots 3-4-5-6) and use the letters a–j.
- Supported punctuation: `. , ; : ! ? ' -`. Anything else is dropped.
- Space is a cell with no dots raised.

The pin mask is a 6-bit integer where bit `n-1` is dot `n`, so dots 1 and 4
(the letter c) are `0b001001` = `0x09`. This is the same bit layout as the
Unicode braille block, so `0x2800 + mask` is always the matching glyph.

## Plugging in the hardware

Two seams are designed for replacement:

1. **Detection in.** `SAMPLES` in `src/lib/detections.ts` stands in for the
   detector. When the Pi produces results, build a `Detection` from them
   (kind, label, confidence, box) and pass it to `setDetection` in `App.tsx`.
   A WebSocket or SSE feed from the Pi is the natural transport.
2. **Frames out.** Every time the displayed cell changes, `App.tsx` appends a
   frame with the pin mask. Send that mask to the controller (serial, GPIO, or
   over the same socket) instead of only logging it. Once the controller
   drives its own timing, replace `useCellStream` with the controller's
   reported state so the screen mirrors the finger rather than leading it.

## Detection in: Pi camera → laptop → queue → finger

The Pi's camera module streams 720p MJPEG at 30 fps (`camera-stream.service`,
tcp 8555). A bridge process on the laptop pulls that stream, re-serves it to
the browser at full rate with the latest boxes drawn on, and, twice a second:

1. **Objects · YOLO26** (`pi/models/yolo26n-seg.pt`, ~40 ms on the GPU),
   filtered to a short list of things you meet at a venue: person, phone,
   laptop, bottle, chair, couch, table, cup, backpack, bag, book, keyboard,
   mouse, screen, clock, scissors, plant, bench (`--classes` to change).
2. **Text gate · EAST** (`bridge/models/frozen_east_text_detection.pb`,
   ~60 ms, local): does this frame contain text, and where?
3. **Text read · Claude** (`claude-opus-5`, structured JSON, low effort): only
   when the gate says text is in view for two passes, and at least **5 s**
   after the previous request (`--read-gap`). The crop around the text is
   sent with `bridge/prompt.txt`. Tesseract is the offline reader
   (`--engine tesseract`), useful without a key.

**Text always beats objects.** The best candidate goes to a bounded queue:
in auto mode a read text is queued when it comes back (once per distinct
text), and an object once it has been in view for two passes and only when
no text is showing; in manual mode only the capture button queues. The web
app pops the queue one message at a time, plays it, and drives the pins.

```bash
python3 pi/models/fetch_models.py yolo26n-seg.pt   # once: object weights
curl -L -o bridge/models/frozen_east_text_detection.pb \
  https://github.com/oyyd/frozen_east_text_detection.pb/raw/master/frozen_east_text_detection.pb   # once: text gate
brew install tesseract                            # once: offline reader
echo ANTHROPIC_API_KEY=sk-ant-... > bridge/.env    # once: never committed (.gitignore)
python3 bridge/detect_bridge.py                   # laptop side, keep running
npm run dev                                       # web app on http://127.0.0.1:5173
```

The **Camera lab** screen (top bar) shows the feed with every box, the
object list, the text gate's verdict, the countdown to the next Claude read,
the last read text with its latency, an engine switch, a "Read now" button,
and Send buttons to play any of them on the finger.

### Safety controls (top bar)

| Control | What it does | Enforced where |
| --- | --- | --- |
| **Lock pins** | Drops every pin and latches the Pi: `cell`, `pulse`, `on` and `braille` return HTTP 423 until unlocked, whoever sends them. | Pi (`POST /lock?value=1|0`) |
| **Pause camera** | The bridge keeps showing the picture but stops detecting, stops calling the vision model, queues nothing, and refuses capture. | Bridge (`POST /pause?value=1|0`) |
| **Stop** | One-shot: halts playback now, drops all pins, clears the queue. | App + Pi + bridge |

Both latches live on the devices, so they survive a page reload and also
block the command-line tools.

- **Auto mode** (default): a label that stays in view for two passes is
  queued, with a 15 s cooldown per label so the same cup does not repeat.
- **Manual mode**: nothing is queued until you press the capture button,
  which queues whatever the bridge currently ranks best (text beats objects).
- `--direct` makes the bridge play the queue on the Pi itself, for a demo
  without the web app. Other knobs: `--conf`, `--ocr-conf`, `--interval`,
  `--cooldown`, `--camera 0` to use the laptop webcam instead of the Pi.

Bridge API on `:8765`: `GET /state`, `GET /frame.jpg`, `GET /stream.mjpg`,
`POST /next`, `POST /capture`, `POST /queue?text=`, `POST /clear`,
`POST /mode?value=auto|manual`, `POST /engine?value=vlm|tesseract|none`,
`POST /analyze` (read now), `POST /pause?value=1|0`. The dev server forwards
`/bridge/*` to it.

The Pi camera has one consumer at a time: stop the bridge before using
`tools/pi_camera_view.sh`, and vice versa.

## Sound mode: Mac microphone → name match → text

Sound mode is separate from camera mode. It does not start the camera, YOLO,
EAST, Tesseract, Claude, or any other vision worker. Silero VAD finds a spoken
utterance, OpenAI `gpt-transcribe` transcribes it, and the bridge queues the
**full utterance only when it contains the configured wearer name or an
explicit alias**. No speech-to-text model is downloaded or run locally.

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r bridge/requirements.txt

# Add this line to bridge/.env (never committed):
# OPENAI_API_KEY=sk-...

python bridge/detect_bridge.py \
  --recognizer sound \
  --wake-name "Ritesh" \
  --wake-alias "Reetesh" \
  --mic "MacBook Air Microphone"

# In another terminal:
npm run dev
```

“Ritesh, your ride is here” queues the full sentence; “Your ride is here” is
discarded. Matching uses whole words, and `--wake-alias` can be repeated for
alternate spellings. Configured names are sent as transcription keyword hints.
Completed utterances are sent to OpenAI with a 15-second request timeout. Raw
audio is not saved, and rejected transcript content is never shown, queued, or
logged.

### macOS microphone setup

Allow the terminal under **System Settings → Privacy & Security → Microphone**.
List input names with:

```bash
python -c 'import sounddevice as s; print(s.query_devices())'
```

Pass the exact Mac input name or index with `--mic`; the bridge will not silently
switch to the iPhone microphone.

The Sound lab shows levels, state, latency, and counts. **Pause mic** and
**Stop** discard buffered work. Run tests with:

```bash
python -m unittest discover -s bridge/tests -v
```

## Real hardware: Raspberry Pi Zero 2 W + 6 solenoids

The finger module is a Raspberry Pi Zero 2 W driving six 12 V solenoids
through ULN2803 Darlington drivers, one solenoid per braille dot. The web
app is the clock: every cell it displays is also POSTed to the Pi, so the
screen and the finger always agree. Everything the Pi needs is in `pi/`.

```
pi/
  solenoid_server.py     HTTP controller on :8080 (cell masks, pulses, braille playback, serves the web build at /app/)
  braille.py             Grade 1 encoder, same output as src/lib/braille.ts
  braille_play.py        play text from the Pi's command line
  deploy.sh              copy code + web build to the Pi and restart the service
  systemd/               solenoid-server.service, camera-stream.service, unblock-wifi.service
  setup/                 first-boot config for a fresh Raspberry Pi OS card (USB gadget networking, SSH, user, Wi-Fi)
  models/                detection weights (not committed) + fetch_models.py to download them; see pi/models/README.md
bridge/
  detect_bridge.py       laptop: Pi camera -> YOLO26 objects + EAST text gate -> Claude reads text -> queue -> web app / Pi
  prompt.txt             the transcription prompt sent to Claude
  models/                EAST weights (not committed)
tools/
  solenoid.sh            fire dots / play text / open the panel from a Mac
  pi_camera_view.sh      live view from the Pi camera (rpicam-vid → ffplay)
```

### Wiring (verified by firing each output)

| Braille dot | Position | GPIO (BCM) | Header pin |
| --- | --- | --- | --- |
| 1 | top-left | 17 | 11 |
| 2 | middle-left | 25 | 22 |
| 3 | bottom-left | 22 | 15 |
| 4 | top-right | 27 | 13 |
| 5 | middle-right | 23 | 16 |
| 6 | bottom-right | 24 | 18 |

GPIO high = solenoid on. The map lives in `~/solenoids.json` on the Pi; edit
it and `sudo systemctl restart solenoid-server` if the wiring changes. The
controller never holds a dot on for more than 2 s (`max_on_ms`).

### Connecting

The Pi is set up as a USB Ethernet gadget: plug its `USB` port into a
computer and it appears at `169.254.10.10` (also `raspberrypi.local`), user
`pi`. It also joins Wi-Fi when a saved network is in range.

```bash
npm run build && ./pi/deploy.sh          # ship code + web build to the Pi
open http://169.254.10.10:8080/app/      # visualizer served by the Pi, live pins
open http://169.254.10.10:8080/          # bare button panel + braille text box
./tools/solenoid.sh text "Hello 42"      # braille playback on the Pi's clock
```

When developing the web app on a laptop (`npm run dev`), the dev server
forwards `/pi/*` to the Pi (set `PI_HOST=host:port` to change it), so the
browser only talks to localhost and needs no local-network permission. The
Pin actuator panel shows the link status, has a "Drive real pins" switch,
and an address field if you want to point it somewhere else.

### HTTP API (port 8080)

| Route | Effect |
| --- | --- |
| `POST /cell?mask=19&ms=900` | raise exactly the dots in a 6-bit mask (bit n−1 = dot n) for `ms` |
| `POST /pulse/<n>?ms=150` · `/on/<n>` · `/off/<n>` | one dot |
| `POST /alloff` | everything down, stop playback |
| `POST /lock?value=1\|0` | safety latch: while locked every actuation returns 423 |
| `POST /braille?text=Hello&cell_ms=900&space_ms=500&gap_ms=120` | play text on the Pi's clock |
| `POST /braille/stop` | stop |
| `GET /state` · `GET /encode?text=` | status · cell sequence for a text |
