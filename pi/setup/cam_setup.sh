#!/usr/bin/env bash
# Runs ON the Raspberry Pi: verifies the camera module is detected, then
# streams live video over TCP so the Mac can open it with ffplay.
set -u
PORT="${1:-8554}"

echo "== Pi model / OS"
tr -d '\0' < /proc/device-tree/model 2>/dev/null; echo
. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"

# Bookworm+ ships rpicam-*, Bullseye ships libcamera-*
if command -v rpicam-hello >/dev/null 2>&1; then HELLO=rpicam-hello; VID=rpicam-vid;
elif command -v libcamera-hello >/dev/null 2>&1; then HELLO=libcamera-hello; VID=libcamera-vid;
else
  echo "camera apps missing, installing rpicam-apps..."
  sudo apt-get update -qq && sudo apt-get install -y -qq rpicam-apps || sudo apt-get install -y -qq libcamera-apps
  command -v rpicam-hello >/dev/null && { HELLO=rpicam-hello; VID=rpicam-vid; } || { HELLO=libcamera-hello; VID=libcamera-vid; }
fi

echo "== Detected cameras"
if ! $HELLO --list-cameras 2>&1 | tee /tmp/cams.txt | grep -q -E "^[0-9]+ :"; then
  echo "!! No camera detected. Check: ribbon cable seated (contacts facing the right way),"
  echo "   correct port (CAM/DISP 0 on Pi 5), and camera_auto_detect=1 in /boot/firmware/config.txt"
  grep -n -E "camera_auto_detect|dtoverlay=(imx|ov)" /boot/firmware/config.txt /boot/config.txt 2>/dev/null
  exit 1
fi

echo "== Streaming H.264 on tcp://0.0.0.0:${PORT}  (Ctrl-C to stop)"
echo "   On the Mac:  ffplay -fflags nobuffer -flags low_delay -framedrop tcp://<pi-ip>:${PORT}"
exec $VID -t 0 --width 1280 --height 720 --framerate 30 --inline --listen -o "tcp://0.0.0.0:${PORT}"
