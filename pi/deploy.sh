#!/usr/bin/env bash
# Push the Pi-side code and the web build to the Pi and (re)start the service.
#   ./pi/deploy.sh [pi-host]      default 169.254.10.10 (USB link)
set -eu
PI="${1:-169.254.10.10}"
HERE="$(cd "$(dirname "$0")" && pwd)"
scp -q "$HERE"/solenoid_server.py "$HERE"/braille.py "$HERE"/braille_play.py pi@"$PI":/home/pi/
scp -q "$HERE"/systemd/*.service pi@"$PI":/tmp/
ssh pi@"$PI" 'sudo mv /tmp/solenoid-server.service /tmp/unblock-wifi.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now unblock-wifi.service solenoid-server.service && sudo systemctl restart solenoid-server.service && chmod +x ~/braille_play.py'
if [ -d "$HERE/../dist" ]; then
  ssh pi@"$PI" 'rm -rf ~/www && mkdir -p ~/www'
  scp -q -r "$HERE"/../dist/. pi@"$PI":/home/pi/www/
  echo "web build installed: http://$PI:8080/app/"
fi
echo "controller: http://$PI:8080/"
