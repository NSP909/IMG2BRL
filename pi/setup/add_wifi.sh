#!/usr/bin/env bash
# Usage: add_wifi.sh "SSID" "PASSWORD"  -- writes Wi-Fi into cloud-init network-config on /Volumes/bootfs
set -eu
SSID="$1"; PASS="$2"; B=/Volumes/bootfs
[ -f "$B/network-config" ] || { echo "!! $B not mounted"; exit 1; }
cp "$B/network-config" "$B/network-config.bak" 2>/dev/null || true
cat > "$B/network-config" <<EOF
network:
  version: 2
  wifis:
    wlan0:
      dhcp4: true
      dhcp6: true
      optional: true
      regulatory-domain: US
      access-points:
        "${SSID}":
          password: "${PASS}"
EOF
# make sure wifi isn't soft-blocked and country is set, every boot
grep -q "rfkill unblock" "$B/user-data" || cat >> "$B/user-data" <<'EOF'
- sh -c 'rfkill unblock wifi || true; raspi-config nonint do_wifi_country US || true'
EOF
sync
echo "== network-config"; sed -E 's/(password: ).*/\1"<hidden>"/' "$B/network-config"
echo "WIFI_OK"
