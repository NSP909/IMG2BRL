#!/usr/bin/env bash
# Control the Pi's solenoids / braille cell from the Mac.
#   ./solenoid.sh                 open the button panel in your browser
#   ./solenoid.sh app             open the braille visualizer served by the Pi
#   ./solenoid.sh 3 [ms]          pulse solenoid (dot) 3
#   ./solenoid.sh on 2 | off 2 | alloff | state
#   ./solenoid.sh cell 0b010011 [ms]   raise the dots of a 6-bit mask (bit n-1 = dot n)
#   ./solenoid.sh text "Hello 42" [cell_ms] [space_ms]   play text as braille on the Pi
#   ./solenoid.sh stop            stop braille playback
PI="${PI:-169.254.10.10}"; BASE="http://$PI:8080"
urlenc() { python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$1"; }
case "${1:-panel}" in
  panel) open "$BASE" ;;
  app) open "$BASE/app/" ;;
  state) curl -s "$BASE/state"; echo ;;
  alloff) curl -s -X POST "$BASE/alloff" >/dev/null && echo "all off" ;;
  stop) curl -s -X POST "$BASE/braille/stop" >/dev/null && echo "braille stopped" ;;
  on|off) curl -s -X POST "$BASE/$1/$2" >/dev/null && echo "solenoid $2 $1" ;;
  cell) m=$(( $2 )); curl -s -X POST "$BASE/cell?mask=$m&ms=${3:-900}" >/dev/null && echo "cell mask $2 for ${3:-900} ms" ;;
  text) curl -s -X POST "$BASE/braille?text=$(urlenc "$2")&cell_ms=${3:-900}&space_ms=${4:-500}" | python3 -c 'import sys,json; b=json.load(sys.stdin)["braille"]; print("playing", b["total"], "cells:", b["preview"])' ;;
  [1-6]) curl -s -X POST "$BASE/pulse/$1?ms=${2:-150}" >/dev/null && echo "pulsed solenoid $1 for ${2:-150} ms" ;;
  *) sed -n '2,10p' "$0"; exit 1 ;;
esac
