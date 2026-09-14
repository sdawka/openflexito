# net-device handoff (done by the lead)

## Status dict (`DeviceStatus.network`, also in the `status` event)
Existing fields kept: `state` (online | hotspot | offline | unknown), `connections` (active NM connection names), `ip`.
New fields (all present, may be null):
- `link`: "ethernet" | "wifi" | "hotspot" | "none" — which path carries traffic; Ethernet with an IPv4 address beats WiFi.
- `interface`: e.g. "eth0" | "wlan0" | null
- `link_local`: true when `ip` is 169.254.x.x (a cable straight into a laptop, no DHCP server)
- `speed_mbit`: Ethernet link speed from /sys/class/net/<if>/speed (1000/100/10) or null (WiFi, unknown)
- `interfaces`: [{interface, type: "ethernet"|"wifi"|"hotspot", connection, ip, link_local, speed_mbit}] for eth0/wlan0
`ip` now prefers the Ethernet address when both are up.
Fake (`--fake`): link "ethernet", interface "eth0", ip 192.168.1.50, speed_mbit 1000, connection "openflexito-wired".

## Image
- New NM profile image/overlay/etc/NetworkManager/system-connections/openflexito-wired.nmconnection: ethernet, autoconnect,
  ipv4 method auto, `link-local=fallback`, `dhcp-timeout=15`, `may-fail=true`; installed root:root 0600 by install.sh's
  existing `chmod 600 *.nmconnection`.
- openflexito-netfallback: never starts the hotspot while an Ethernet device is connected with an IPv4 address; drops the
  hotspot when a cable comes up. WiFi-client logic unchanged.
- avahi: no overlay config; the Debian default publishes on all interfaces including link-local IPv4, so microscope.local
  should resolve over the cable.

## User flows
(a) Pi to router by cable: nothing to configure; DHCP; microscope.local or the router-assigned IP; hotspot stays off.
(b) Pi straight into a laptop: after ~15 s DHCP timeout the Pi takes 169.254.x.x; macOS/Windows/Linux(NM) do the same by
    default; open http://microscope.local/ (mDNS over link-local). No internet on either side through that cable.
LED: "online" for wired exactly like WiFi client; "hotspot" double blink only when neither cable nor WiFi is up.

## Unverified on hardware
NM 1.42 `ipv4.link-local=fallback` timing with `dhcp-timeout=15`; avahi answering on a 169.254 address; real Ethernet
throughput on the 3B+ (expect 200-300 Mbit/s); that `nmcli device status` prints "connected" (not "connected (externally)")
for the wired profile.
