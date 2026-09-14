# Brief: make the wired Ethernet link first-class on the Pi image and device

Repo /Users/sdawka/Code/openflexito. Read CLAUDE.md, README.md (networking / hotspot / "Wired link" parts, hardware notes),
image/install.sh, image/build-mac.sh, image/overlay/** (NetworkManager hotspot profile, openflexito-netfallback, import-wifi,
systemd units), device/openflexito/{netwatch,leds,app}.py and device/tests. Target OS: Raspberry Pi OS Bookworm Lite,
NetworkManager 1.42, avahi-daemon, Pi 3B+ (Ethernet is gigabit-over-USB2, ~200-300 Mbit/s real).

## File ownership (strict)
You own: image/** and device/**. Another agent owns webapp/**, README.md, TODO.md, CLAUDE.md. Write anything the webapp or docs
must know (new fields in the `network` status dict, exact behaviour) to /Users/sdawka/.claude/jobs/e88486dd/tmp/handoff/net-device.md.
Files copied onto the Pi must be root-owned 0600 for NM profiles (see CLAUDE.md). The device runs unprivileged: no sudo.

## Work
1. Wired profile: add image/overlay/etc/NetworkManager/system-connections/openflexito-wired.nmconnection for `type=ethernet`,
   `interface-name=eth0` (or match any ethernet), `ipv4.method=auto`, `ipv4.link-local=fallback` (so a direct cable to a laptop
   with no DHCP server still gets a 169.254.x.x address), `ipv6.method=auto`, `connection.autoconnect-priority` above the hotspot,
   `ipv4.dhcp-timeout=15` or similar so the link-local fallback arrives quickly. Make sure install.sh / build-mac.sh copy it with
   the same root:root 0600 handling as the hotspot profile.
2. Hotspot fallback (openflexito-netfallback): never start the hotspot while an Ethernet connection is active with an IPv4
   address (DHCP or link-local); drop the hotspot when a cable comes up. Keep the existing WiFi-client logic.
3. mDNS on the cable: confirm avahi-daemon publishes microscope.local on eth0 (default `use-ipv4=yes`, all interfaces); if the
   overlay or install restricts interfaces, fix it. Also make sure link-local IPv4 addresses are allowed (avahi config
   `allow-interfaces`/`deny-interfaces` untouched, `publish-workstation` irrelevant).
4. Device status: extend `network_state()` in netwatch.py to report `link: "ethernet" | "wifi" | "hotspot" | "none"`,
   the interface name, the IPv4 address per interface, whether the address is link-local, and (if cheap via
   /sys/class/net/<if>/speed or nmcli) the Ethernet link speed in Mbit/s. Keep the existing `state`, `connections`, `ip`
   fields for compatibility; `ip` should prefer the Ethernet address when both are up. Fake mode (`--fake`) must return a
   plausible dict (e.g. link "ethernet", 192.168.1.50, 1000 Mbit/s) so the webapp can be e2e-tested.
5. LED: leds.py state machine already has booting/offline/hotspot/online/streaming; keep "online" for wired too (document).
6. Tests: device/tests for the new network_state parsing (mock nmcli output for: wired DHCP, wired link-local only,
   wifi client, hotspot, nothing), and for the fake path. `cd device && .venv/bin/pytest -q` must be green.
7. Handoff: describe the new status fields, the expected user flow for (a) Pi to router by cable, (b) Pi direct to laptop by
   cable (link-local, what the laptop must do: nothing on macOS/Windows/Linux with NM), and what still needs checking on real
   hardware (NM 1.42 `ipv4.link-local=fallback` semantics, DHCP timeout, avahi on link-local).
