#!/bin/bash
# First boot (invoked from cmdline.txt via systemd.run, like Raspberry Pi Imager). Configures the
# user, SSH, WiFi and hostname, unpacks openflexito and schedules its installation on the next boot
# once the network is up. Values are substituted by build-mac.sh.
set +e
BOOT=/boot/firmware
[ -d $BOOT ] || BOOT=/boot
IC=/usr/lib/raspberrypi-sys-mods/imager_custom
LED=/sys/class/leds/ACT; [ -d $LED ] || LED=/sys/class/leds/led0
echo timer > $LED/trigger 2>/dev/null; echo 100 > $LED/delay_on 2>/dev/null; echo 100 > $LED/delay_off 2>/dev/null

# --- identity ---
if [ -x $IC ]; then $IC set_hostname microscope; else echo microscope > /etc/hostname; sed -i 's/^127\.0\.1\.1.*/127.0.1.1\tmicroscope/' /etc/hosts; fi
if [ -x $IC ]; then $IC enable_ssh; else systemctl enable ssh; fi

# --- admin user ---
FIRSTUSER=$(getent passwd 1000 | cut -d: -f1)
if [ -f /usr/lib/userconf-pi/userconf ]; then
  /usr/lib/userconf-pi/userconf '@ADMIN_USER@' '@ADMIN_HASH@'
else
  if [ -n "$FIRSTUSER" ] && [ "$FIRSTUSER" != "@ADMIN_USER@" ]; then usermod -l '@ADMIN_USER@' -d '/home/@ADMIN_USER@' -m "$FIRSTUSER"; groupmod -n '@ADMIN_USER@' "$FIRSTUSER"; fi
  id '@ADMIN_USER@' >/dev/null 2>&1 || useradd -m -s /bin/bash -G sudo,adm,video,dialout,plugdev,users '@ADMIN_USER@'
  echo '@ADMIN_USER@:@ADMIN_HASH@' | chpasswd -e
fi
install -d -m 700 -o '@ADMIN_USER@' -g '@ADMIN_USER@' '/home/@ADMIN_USER@/.ssh'
echo '@SSH_PUBKEY@' > '/home/@ADMIN_USER@/.ssh/authorized_keys'
chmod 600 '/home/@ADMIN_USER@/.ssh/authorized_keys'; chown '@ADMIN_USER@:@ADMIN_USER@' '/home/@ADMIN_USER@/.ssh/authorized_keys'
echo '@ADMIN_USER@ ALL=(ALL) NOPASSWD: ALL' > '/etc/sudoers.d/010_@ADMIN_USER@-nopasswd'; chmod 440 '/etc/sudoers.d/010_@ADMIN_USER@-nopasswd'

# --- wifi (NetworkManager profile, higher priority than the hotspot fallback) ---
if [ -x $IC ]; then $IC set_wlan '@WIFI_SSID@' '@WIFI_PSK@' '@WIFI_COUNTRY@'; fi
raspi-config nonint do_wifi_country '@WIFI_COUNTRY@' >/dev/null 2>&1
cat > /etc/NetworkManager/system-connections/openflexito-client.nmconnection <<NM
[connection]
id=openflexito-client
uuid=$(cat /proc/sys/kernel/random/uuid)
type=wifi
autoconnect=true
autoconnect-priority=10

[wifi]
mode=infrastructure
ssid=@WIFI_SSID@

[wifi-security]
key-mgmt=wpa-psk
psk=@WIFI_PSK@

[ipv4]
method=auto

[ipv6]
method=auto
NM
chmod 600 /etc/NetworkManager/system-connections/openflexito-client.nmconnection
cat > /etc/NetworkManager/system-connections/openflexito-ricknet.nmconnection <<NM
[connection]
id=openflexito-ricknet
uuid=$(cat /proc/sys/kernel/random/uuid)
type=wifi
autoconnect=true
autoconnect-priority=5

[wifi]
mode=infrastructure
ssid=Ricknet

[wifi-security]
key-mgmt=wpa-psk
psk=lalalalala

[ipv4]
method=auto

[ipv6]
method=auto
NM
chmod 600 /etc/NetworkManager/system-connections/openflexito-ricknet.nmconnection
rm -f /etc/NetworkManager/system-connections/preconfigured.nmconnection 2>/dev/null

# --- openflexito payload: unpack now, install on next boot when online ---
mkdir -p /opt/openflexito-src
tar -xzf $BOOT/openflexito.tar.gz -C /opt/openflexito-src
cat > /etc/systemd/system/openflexito-setup.service <<UNIT
[Unit]
Description=openflexito first-time installation (needs internet for apt)
Wants=network-online.target
After=network-online.target NetworkManager-wait-online.service time-sync.target
ConditionPathExists=/opt/openflexito-src/image/install.sh

[Service]
Type=oneshot
Restart=on-failure
RestartSec=30
ExecStartPre=/bin/sh -c 'for i in \$(seq 1 60); do getent hosts deb.debian.org && exit 0; sleep 5; done; exit 1'
ExecStartPre=/bin/sh -c 'for i in \$(seq 1 120); do [ "\$(timedatectl show -p NTPSynchronized --value)" = yes ] && exit 0; sleep 5; done; exit 1'
ExecStart=/opt/openflexito-src/image/install.sh --trim
ExecStartPost=/bin/systemctl disable openflexito-setup.service
ExecStartPost=/bin/rm -rf /opt/openflexito-src
StandardOutput=journal+console

[Install]
WantedBy=multi-user.target
UNIT
systemctl enable openflexito-setup.service

# --- boot files: openflexito config include, free the UART, remove this hook ---
grep -q '^include config-openflexito.txt' $BOOT/config.txt || echo 'include config-openflexito.txt' >> $BOOT/config.txt
sed -i -E 's/console=serial0,[0-9]+ ?//; s/console=ttyAMA0,[0-9]+ ?//; s| systemd.run.*||g' $BOOT/cmdline.txt
rm -f $BOOT/firstrun.sh $BOOT/openflexito.tar.gz
exit 0
