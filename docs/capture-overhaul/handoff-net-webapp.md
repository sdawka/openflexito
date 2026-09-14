# net-webapp handoff

## Files changed
- `webapp/src/lib/api/types.ts`: `NetworkStatus`/`NetworkInterface` types, additive fields on
  `DeviceStatus.network` (`link`, `interface`, `link_local`, `speed_mbit`, `interfaces`) matching
  the net-device handoff exactly (field names confirmed against the real `device/openflexito/netwatch.py`
  and `app.py` after they landed).
- `webapp/src/lib/store/device.svelte.ts`: `streamKBs` — measured live-stream bitrate from the existing
  `event.frame` metadata (`size`/`t` on `stream === 'main'` frames, 3 s rolling window). No second
  stream is opened.
- `webapp/src/components/StatusBar.svelte`: link label ("Wired 1000 Mbit/s 192.168.1.50", "WiFi
  <connection name>", "Hotspot 10.42.0.1", "direct cable" for link-local) plus the measured
  kB/s + Mbit/s, next to the existing connection badge. Falls back to nothing shown if the device
  hasn't reported the newer fields (defensive `net &&` guards).
- `webapp/src/components/PhotoPanel.svelte`: one-line advice under the mode blurb when a RAW-frame
  mode (raw/rawavg/focusfineraw/hdrraw/superres+raw) is selected and the link is a hotspot or the
  measured rate is under ~30 Mbit/s — estimated seconds per RAW frame at the measured rate, plus
  "plug in an Ethernet cable for ~0.5 s per RAW frame".
- `webapp/e2e/app.mjs`: new step "link indicator shows the wired fake device" right after "connects
  and streams", waiting for "Wired" in the nav/status bar text.
- `CLAUDE.md`: e2e step count 33 → 34, added "link indicator" to the step list.
- `README.md`: replaced the old "Wired link" hardware-notes bullet (trimmed, now points at the new
  section) with a new "## Networking" section — the four connection paths in preference order, a
  throughput/RAW-frame-time table, the live stream's ~15 Mbit/s need, what the status LED shows, and
  an "unverified on hardware" line pointing at TODO.md.
- `TODO.md`: replaced the old one-line "Link-local over Ethernet" item with a fuller wired-networking
  verification list (link-local timing, avahi on a 169.254 address, `nmcli` connected-state wording,
  real Ethernet throughput).

## Verification
- `npm run check`: 0 errors, 0 warnings (840 files).
- `npx vitest --run`: 240/240 tests, 30 files green (rtk's terminal summary printer failed to parse
  vitest's own output this run — verified via `.vitest/json/output.json` instead:
  `numTotalTests: 240, numPassedTests: 240, numFailedTests: 0, success: true`).
- `npm run build`: succeeds (unrelated >500 kB chunk-size warning, pre-existing).
- e2e, run alone against a freshly started fake (`--fake --webapp-dir ../webapp/dist --port 8099`):
  **34/34 steps passed** (build.mjs list unchanged except the new step). Fake process killed after.

## A real gotcha hit and fixed here
The first e2e attempt failed only on the new step. Cause: a fake device process I'd started earlier
in this session was still running from *before* the device agent's net-device changes landed on disk
(started, then their edit landed, so the running process never picked up the new `netwatch.py`/
`app.py`) — `system.status` kept returning the old 3-key `network` dict for the process's whole
lifetime. Killed it, started a fresh fake, confirmed via `curl`/`system.status` that `network.link`
etc. were present, then the full 34-step run passed clean. Not a code bug — just a reminder that a
long-lived fake process doesn't pick up another agent's concurrent file edits.

## Open points
- Field-name confirmation: I initially guessed `eth_speed_mbps`/`addresses` before net-device.md
  existed, then corrected to the real names (`speed_mbit`, `interfaces`) once it appeared partway
  through this session. No trace of the old guesses remains in the diff — grep clean.
- `linkLabel`'s WiFi case uses `net.connections[0]` (the NM connection name) as a stand-in for SSID,
  since the handoff doesn't expose an explicit SSID field. On a real WiFi client this is normally the
  network's own SSID (NM's default connection-naming), but if a wired agent ever gives connections
  custom names this label could read oddly — worth revisiting if that turns out to matter.
- The Photo-panel advice's "16 MB RAW frame" / "0.5 s per RAW frame" figures are the same ones in the
  new README table; if those get refined after real hardware measurement, update both places (they're
  not shared as a single constant right now — small duplication, intentionally left alone rather than
  over-engineering a shared config for two prose numbers).
- Did not touch `Settings.svelte`'s existing one-line network summary (`network {state} {ip}`) — the
  brief's UI ask was satisfied in the status bar; left Settings as glue-with-existing rather than
  duplicating the new richer label there. Worth a follow-up if you want the fuller link label in
  Settings too.
