# Brief: documentation for the capture-quality work

Repo /Users/sdawka/Code/openflexito. Read CLAUDE.md, README.md, TODO.md, CAPTURE_AUDIT.md, and the five handoff files in
/Users/sdawka/.claude/jobs/e88486dd/tmp/handoff/ (device.md, focus.md, superres.md, scan.md, raw.md). Verify claims against the
code before writing (grep the files named); do not document anything you cannot find.

## File ownership (strict)
You own README.md, CLAUDE.md, TODO.md, CAPTURE_AUDIT.md only. Do not edit code.

## Work
1. README.md: update the "Photos and stacks", "Super-resolution and depth", scan/stitch, video, time-lapse and hardware-notes
   sections to describe the new behaviour (still metadata, OFRW v2 trailer, raw averaging, packed raw, bracket endpoint,
   flat field, still_clean, frame-duration limits; middle-reference Lanczos alignment, noise-floor and cross-level pyramid
   fusion, hybrid DMap, adaptive z step, two-pass autofocus; accurate sub-pixel registration, corrected super-res pattern,
   pixfrac, deconvolution, Bayer drizzle; weighted/multiband stitching, gain equalisation, robust solve, local autofocus,
   adaptive settle; time-lapse fixes; the fetch-based MJPEG reader, frame-accurate recording and stabiliser; export file
   naming `YYYYMMDD-HHMMSS_sample_label_x_y_z_blob.ext` from algo/naming.ts). Keep the existing voice: dense, factual,
   file names in backticks. Add a short "Wired link" note: the Pi 3B+ cannot act as a USB device (its one USB controller
   feeds the onboard hub, so USB gadget/Ethernet-over-USB is Pi Zero/4/5 only); a direct Ethernet cable to the laptop is the
   fast path (NetworkManager + avahi are installed, link-local addressing and microscope.local over the cable; ~200-300 Mbit/s
   vs WiFi, so 16 MB raws take well under a second); mark "verify the link-local fallback on the real Pi" as untested.
2. CLAUDE.md: update the Conventions bullets that changed (photo modes now live in services/photo/*.ts with photoService.ts
   dispatching; services/cameraLock.ts for multi-shot runs; algo/register.ts is the registration primitive; algo/naming.ts;
   api/mjpegStream.ts; new algo modules), and the e2e step count once the UI agent reports it (leave a TODO marker
   "<<e2e steps>>" if unknown; the lead will fill it).
3. TODO.md: replace the done items, add the hardware-verification list from every handoff's "hypotheses / open points"
   (picamera2 defaults, FrameDurationLimits clamp, switch_mode+capture_request behaviour, exposure latency, super-res measured
   shifts, stabiliser tuning on a real camera, focus breathing, flat-field workflow, link-local over Ethernet), and remaining
   loose ends (raw-plane super-res if still unwired, stackWorker has no unit test, toneMapMertens 1-row edge case, etc.).
4. CAPTURE_AUDIT.md: add a "Status (2026-09-11)" column or section marking each D1-D10 and each Tier row as done / partly /
   pending with the file that implements it.

Finish: report which sections changed and anything you could not verify.
