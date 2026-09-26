#!/usr/bin/env bash
# Opens the live view from the Pi Zero 2 W camera.
# Usage: ./pi_camera_view.sh            (over USB, default)
#        ./pi_camera_view.sh <pi-ip>    (e.g. its Wi-Fi address)
PI="${1:-169.254.10.10}"
PORT=8554
echo "Starting stream on the Pi ($PI)..."
ssh -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new pi@"$PI" \
  'pkill -x rpicam-vid 2>/dev/null; sleep 1; nohup rpicam-vid -t 0 --width 1280 --height 720 --framerate 30 --codec h264 --profile baseline --intra 30 --inline --listen -o tcp://0.0.0.0:'"$PORT"' -n >/tmp/rpicam.log 2>&1 & sleep 2; ss -ltn | grep -q '"$PORT"' && echo "stream listening on '"$PORT"'"' || { echo "could not reach the Pi at $PI"; exit 1; }
echo "Opening viewer (close the window or press q to quit)..."
exec ffplay -window_title "Pi Zero 2 W camera" -fflags nobuffer -flags low_delay -framedrop -probesize 32 -analyzeduration 0 -f h264 "tcp://$PI:$PORT"
