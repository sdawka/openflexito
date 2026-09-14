# Continuing this work from a fresh clone

State as of 2026-09-14, `main` at the commit that adds this file. Everything is in the repository except two things
that must never be committed: `image/secrets.env` (WiFi credentials and the Pi user password for the image build;
recreate it from `image/build-mac.sh`'s comments) and the SSH key authorised on the Pi (`~/.ssh/id_ed25519` of the
original machine; add another key via the Pi's console or re-flash the image with your own).

## Where things are
- `README.md`: what the system does and the verified hardware facts. `CLAUDE.md`: the conventions and the exact
  commands to check, test, build, run the e2e and deploy. `TODO.md`: what is pending, above all the hardware
  verification list. `CAPTURE_AUDIT.md`: the audit that drove the 2026-09-10/14 overhaul, with a status table.
- `docs/capture-overhaul/`: the two long auditor reports, the per-area agent handoffs (open points, design
  judgement calls, UI controls, wire contracts) and the briefs they were built from. Read `handoff-device.md` for
  the byte layouts of the OFRW v2 raw record, `/bracket.bin` and the `X-Frame` header.

## Workflow that worked
1. `cd device && .venv/bin/pytest -q` (create the venv with `python3 -m venv .venv && .venv/bin/pip install -e .[dev]`
   or as `device/pyproject.toml` says).
2. `cd webapp && npm ci && npm run check && npx vitest --run && npm run build`.
3. Fake device for the e2e: `cd device && .venv/bin/python -m openflexito --fake --webapp-dir ../webapp/dist --port 8099`
   then `cd webapp && npm run test:e2e` (Playwright with installed Chrome). Run one suite at a time against one fake.
4. Deploy to a running Pi: `image/deploy.sh [admin@microscope.local]` (webapp, device package, network overlay,
   service restart). Run the e2e on the Pi by IPv4 address with `E2E_MOVES=0` first.
5. Full image: `image/build-mac.sh` (needs `image/secrets.env`), then `sudo image/install.sh` on the Pi if updating in place.

## Reaching the Pi
`ssh admin@microscope.local` (key auth). The app is `http://microscope.local/`; Chrome/Playwright need the IPv4 address
(`ping -c1 microscope.local`). Installed code: `/opt/openflexito/venv/lib/python3.11/site-packages/openflexito/`,
webapp `/opt/openflexito/webapp`, config `/etc/openflexito/config.toml`, logs via `journalctl -u openflexito` or the
app's Logs panel. The device runs unprivileged; privileged actions go through request files (`openflexito-maint.path`).

## What to do next (short version; details in TODO.md)
- Deploy and run the e2e on the Pi; the new device paths (raw averaging, brackets, flat field, still metadata,
  `still_clean`) have only run on the fake.
- Plug in an Ethernet cable (router or laptop) and confirm the status bar shows "Wired", the hotspot stays down,
  `microscope.local` resolves over the cable, and RAW frames arrive in ~0.5 s.
- Try super-resolution on a real sample and read the measured shifts the item records; tune the video stabiliser on
  real footage; capture a flat field with the sample removed.
- Feature 5 (oblique / darkfield / DPC) is waiting on the two side LEDs (README and TODO.md).
