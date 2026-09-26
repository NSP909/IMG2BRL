#!/usr/bin/env bash
# Configures a freshly flashed Raspberry Pi OS (Trixie) boot partition for
# headless USB-gadget access from this Mac.  Usage: configure_bootfs.sh USER PASSWORD
set -eu
USER_NAME="$1"; USER_PASS="$2"
B=/Volumes/bootfs
[ -f "$B/config.txt" ] || { echo "!! $B not mounted"; exit 1; }
grep -q "bcm2710-rpi-zero-2-w.dtb" <(ls "$B") || { echo "!! this is not the new image"; exit 1; }

HASH=$(openssl passwd -6 "$USER_PASS")
PUBKEY=$(cat ~/.ssh/id_ed25519.pub)

# 1) USB device mode overlay
grep -q '^dtoverlay=dwc2' "$B/config.txt" || printf 'dtoverlay=dwc2,dr_mode=peripheral\n' >> "$B/config.txt"

# 2) load the Ethernet-gadget driver with fixed MACs (so the Mac sees one stable device)
if ! grep -q 'g_ether' "$B/cmdline.txt"; then
  sed -i '' -E 's/rootwait/rootwait modules-load=dwc2,g_ether g_ether.dev_addr=02:50:49:5a:32:57 g_ether.host_addr=02:50:49:5a:32:58/' "$B/cmdline.txt"
fi

# 3) legacy ssh flag (harmless if unused)
touch "$B/ssh"

# 4) cloud-init: user, ssh, usb0 networking
cat > "$B/user-data" <<EOF
#cloud-config
hostname: raspberrypi
manage_etc_hosts: true
ssh_pwauth: true
chpasswd:
  expire: false
users:
- name: ${USER_NAME}
  gecos: ${USER_NAME}
  groups: users,adm,dialout,audio,netdev,video,plugdev,cdrom,games,input,gpio,spi,i2c,render,sudo
  shell: /bin/bash
  lock_passwd: false
  passwd: ${HASH}
  sudo: ALL=(ALL) NOPASSWD:ALL
  ssh_authorized_keys:
  - ${PUBKEY}
rpi:
  interfaces:
    ssh: true
runcmd:
- sh -c 'systemctl enable --now ssh || true'
- sh -c 'nmcli con add type ethernet ifname usb0 con-name usb0 ipv4.method auto ipv4.link-local enabled ipv4.dhcp-timeout 15 ipv4.may-fail yes ipv6.method link-local connection.autoconnect yes connection.autoconnect-priority 10 || true'
- sh -c 'nmcli con up usb0 || true'
EOF

echo "== config.txt tail";  tail -2 "$B/config.txt"
echo "== cmdline.txt";      cat "$B/cmdline.txt"
echo "== user-data (user line)"; grep -E "^- name:|hostname:" "$B/user-data"
sync
echo "CONFIG_OK"
