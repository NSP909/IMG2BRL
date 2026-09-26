#!/usr/bin/env bash
# Fallback: make usb0 come up with a fixed link-local IPv4 on EVERY boot, independent of
# NetworkManager (which ignores/parks USB gadget interfaces), and force cloud-init to re-run.
set -eu
B=/Volumes/bootfs; [ -f "$B/user-data" ] || { echo "!! $B not mounted"; exit 1; }
HASH=$(openssl passwd -6 raspberry); PUBKEY=$(cat ~/.ssh/id_ed25519.pub)
cat > "$B/user-data" <<EOF
#cloud-config
hostname: raspberrypi
manage_etc_hosts: true
ssh_pwauth: true
chpasswd:
  expire: false
users:
- name: pi
  gecos: pi
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
bootcmd:
- sh -c 'mkdir -p /etc/NetworkManager/conf.d; printf "[keyfile]\nunmanaged-devices=interface-name:usb0\n" > /etc/NetworkManager/conf.d/99-usb0-unmanaged.conf'
- sh -c 'for i in 1 2 3 4 5 6 7 8 9 10; do [ -d /sys/class/net/usb0 ] && break; sleep 1; done; ip link set usb0 up; ip addr replace 169.254.10.10/16 dev usb0; sysctl -w net.ipv6.conf.usb0.disable_ipv6=0 || true'
runcmd:
- sh -c 'systemctl enable --now ssh || true'
- sh -c 'systemctl enable --now avahi-daemon || true'
- sh -c 'ip link set usb0 up; ip addr replace 169.254.10.10/16 dev usb0 || true'
EOF
sed -i '' -E 's/^instance_id: .*/instance_id: rpios-image-usb2/' "$B/meta-data"
sync
echo "== meta-data instance"; grep instance_id "$B/meta-data"
echo "== user-data bootcmd"; grep -A3 "^bootcmd" "$B/user-data" | cut -c1-120
echo "RECONFIG_OK"
