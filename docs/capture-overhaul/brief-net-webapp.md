# Brief: show the network link in the webapp and document the wired path

Repo /Users/sdawka/Code/openflexito. Read CLAUDE.md, README.md (networking, hotspot, "Wired link" hardware note, the stream
bitrate facts around lines 96-108: ~100 kB per frame, 18 fps at 820x616), webapp/src/routes/Settings.svelte, the status /
connection UI (search webapp/src for `network`, `hotspot`, `state.network`, `DeviceStatus`), webapp/src/lib/api/types.ts
(`DeviceStatus.network`), webapp/src/lib/store/device.svelte.ts, webapp/src/lib/api/mjpegStream.ts (per-frame size is
available), TODO.md.

## File ownership (strict)
You own: webapp/** (all), README.md, TODO.md, CLAUDE.md. Another agent owns image/** and device/** and is extending the device's
network status dict; its contract will appear at /Users/sdawka/.claude/jobs/e88486dd/tmp/handoff/net-device.md (fields: `link`
"ethernet" | "wifi" | "hotspot" | "none", interface, per-interface IPv4, link-local flag, Ethernet speed in Mbit/s, existing
`state`/`connections`/`ip` kept). Poll for that file before writing the types; if it does not exist after you finish the other
work, code against exactly those field names as optional and note it.

## Work
1. Types: extend `DeviceStatus.network` (api/types.ts) additively with the new optional fields.
2. Link indicator: in the connection/status area the app already has (header or Settings), show the link type with an icon or
   short label ("Wired 1000 Mbit/s 192.168.1.50", "WiFi <ssid>", "Hotspot 10.42.0.1", link-local flagged as "direct cable"),
   and a measured stream bitrate (kB/s and Mbit/s from frame sizes and timestamps of the live stream: use the
   existing frame metadata events `event.frame` `size` field or the MJPEG reader; do not open a second stream).
3. Advice: when the link is hotspot (or WiFi under ~30 Mbit/s measured), show one unobtrusive line in the Photo panel near the
   RAW/averaging/HDR/RAW-superres modes: estimated time for that mode at the measured rate and "plug in an Ethernet cable for
   ~0.5 s per RAW frame". Keep it to a single sentence; no modal.
4. Fake device: `--fake` reports a wired link (see handoff); add an e2e step in webapp/e2e/app.mjs that the link indicator
   shows "Wired" on the fake (run the suite ALONE against a fresh fake: `cd device && .venv/bin/python -m openflexito --fake
   --webapp-dir ../webapp/dist --port 8099 &` after `cd webapp && npm run build`, then `npm run test:e2e`; kill the fake after;
   never run two suites at once). Update the step count in CLAUDE.md (currently 33).
5. README: replace the "Wired link" hardware note with a short "Networking" section: the three ways to connect (cable to
   router: recommended, same speed as direct; direct cable to laptop: link-local, `microscope.local` still works; WiFi client;
   hotspot: fallback only) with a compact table of realistic throughput and RAW-frame time (Ethernet 200-300 Mbit/s ≈ 0.5 s
   per 16 MB RAW; WiFi 5 GHz 40-90 Mbit/s ≈ 1.5-3 s; 2.4 GHz 15-40 ≈ 3-9 s; hotspot 10-30 ≈ 5-14 s), the live stream's
   ~15 Mbit/s need, and what the LED shows. Mark what is unverified on hardware. TODO.md: hardware-verification entries for
   the wired path (link-local fallback, DHCP timeout, avahi on eth0, real throughput).
6. `cd webapp && npm run check && npx vitest --run && npm run build` green, e2e green (report the step count).
Write open points to /Users/sdawka/.claude/jobs/e88486dd/tmp/handoff/net-webapp.md.
