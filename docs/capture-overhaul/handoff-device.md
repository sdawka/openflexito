# Device-side capture changes: handoff to the webapp and docs

All changes are under `device/`. Old clients keep working: `/snapshot.jpg`, `/raw.bin` (single
frame, unpacked) and every RPC keep their previous behaviour; the additions are new query
parameters, new endpoints, extra `X-Frame` content and a trailer appended after the raw pixels.

Files: `device/openflexito/rawfmt.py` (new, pure wire formats + reference decoders),
`camera.py`, `fake_camera.py`, `web.py`, `config.py`, `app.py`; tests
`device/tests/test_rawfmt.py` (new), `test_camera_controls.py`, `test_rpc_web.py`.

## 1. Still metadata (`/snapshot.jpg?full=1`)

`X-Frame` now carries the still's own request metadata (via `switch_mode` + `capture_request`),
not the last stream frame's. Shape = `event.frame` plus extras:

```json
{"ts": 8003476660090458, "exposure": 500, "gain": 1.0, "digital_gain": 1.0, "colour_gains": [1.0, 1.0],
 "focus_fom": null, "lux": 400.0, "frame_duration": 33333, "colour_temperature": 5000, "t": ...,
 "still": true, "matched": true, "width": 3280, "height": 2464, "size": 688917, "seq": 14}
```

`ts` is the still's SensorTimestamp (ns, CLOCK_BOOTTIME), so the browser can assert
`ts > stage t1`. `X-Timestamp` = `ts`. `seq` is still the last stream frame's seq (compat only).
`colour_temperature` is null when libcamera does not report it. Without `full=1` nothing changed
except that stream frames now also carry `matched` (see 4) and `digital_gain`/`frame_duration`.

Webapp: `api/snapshot.ts` should parse `X-Frame` and return it with the blob; gallery items should
store it (plus µm/px and tuning id). The DNG writer can take AsShotNeutral from `colour_gains`
(1/r, 1, 1/b) and exposure/gain for the EXIF IFD.

## 2. OFRW v2 raw record (`/raw.bin`, `/flat.bin`, raw items in `/bracket.bin`)

Byte layout (also in the `rawfmt.py` module docstring):

```
offset    size  field
0         4     magic "OFRW"
4         4     width      u32 LE
8         4     height     u32 LE
12        2     bit_depth  u16 LE   10 (single frame) or 16 (frames > 1)
14        2     black_level u16 LE  64 at 10 bit, 4096 at 16 bit (same scale as the pixels)
16        8     bayer      ASCII NUL-padded ("BGGR")
24        N     pixel data
24+N      J     trailer JSON (UTF-8)
24+N+J    4     J  u32 LE
24+N+J+4  4     magic "OFRM"
```

Reader: `parseRaw` already tolerates trailing bytes (`byteLength >= HEADER + w*h*2`), so v1 code
keeps working. To read the trailer: if the last 4 bytes are `OFRM`, read the u32 LE at
`len-8`, JSON-parse `bytes[len-8-J : len-8]`. The same JSON is in the response's `X-Frame`
header, so a fetch-time parse does not need the bytes at all.

Trailer keys (always present, may be null):
`version` (2), `width`, `height`, `bit_depth`, `black_level`, `white_level`, `bayer`, `packed`,
`frames`, `frame_timestamps` (ns per averaged frame), `ts` (first frame), `exposure` (µs), `gain`,
`digital_gain`, `colour_gains` [r, b], `colour_temperature`, `lux`, `focus_fom`,
`frame_duration`, `ccm` (9 floats row-major, the tuning `rpi.ccm` entry nearest the frame's CT),
`ccm_ct`, `flat`, `still` (true), `matched` (true), `t`.

`black_level` in the trailer equals the header field; `white_level` is 1023 or 65472.
`rawdev.ts` should use the record's `colour_gains` and `ccm`, not the live stream's, and must
honour `bit_depth`/`black_level`/`white_level` from the record instead of assuming 10-bit/64.

### Multi-frame averaging: `/raw.bin?frames=N` (N = 1..8)

One mode switch, N `capture_request`s, running uint32 sum, mean scaled to 16 bit:
`value16 = round(sum * 64 / N)`. Chosen over "keep 10-bit" because the extra fractional bits
(up to 3 for N = 8) are the whole point of averaging. Header says `bit_depth 16`,
`black_level 4096`; trailer `white_level 65472`, `frames N`, `frame_timestamps [N]`. Use the
timestamps (plus stage events) to check that the stage was still: all N frames are consecutive at
the still mode's frame duration. N = 1 is byte-identical to v1 (10 bit). `packed=1` with N > 1 is
a 400.

### Packed 10-bit: `/raw.bin?packed=1`

Pixel data is SBGGR10_CSI2P layout: 4 pixels in 5 bytes, `w*h*5/4` bytes, rows contiguous
(width must be a multiple of 4; 3280 is). Trailer `packed: true`, header `bit_depth 10`. Unpack:

```ts
// b = Uint8Array(pixels), out = Uint16Array(w*h)
for (let i = 0, o = 0; i < b.length; i += 5, o += 4) {
  const lo = b[i + 4]
  out[o]     = (b[i]     << 2) | ( lo       & 3)
  out[o + 1] = (b[i + 1] << 2) | ((lo >> 2) & 3)
  out[o + 2] = (b[i + 2] << 2) | ((lo >> 4) & 3)
  out[o + 3] = (b[i + 3] << 2) | ((lo >> 6) & 3)
}
```

Transfer: 10.1 MB instead of 16.2 MB for 3280×2464. `parseRaw` must branch on
`trailer.packed` (or on `byteLength` vs `w*h*2`) before slicing.

### Flat field: `/flat.bin?frames=N` (default 4)

Exactly `/raw.bin?frames=N` with `flat: true` in the trailer and `Content-Disposition
filename=flat.bin`. No duplicated code (one handler, `flat` flag). Intended to be taken with the
sample removed; the browser derives per-channel gain maps.

## 3. Exposure bracket: `/bracket.bin?factors=0.5,1,2[&raw=1]`

One mode switch for the whole bracket. AE/AWB are frozen from the live frame (or the manual
controls), gain and colour gains locked, only `ExposureTime` varies: target_i = round(base × f_i),
clamped to `[20 µs, still_frame_duration max]`. After each control change the device drops frames
until the request's own `ExposureTime` is within 5 % of the target (max 8 frames), so every
item's metadata is what it was actually shot at. 1..8 factors, each 0.01..100; else 400.

`X-Frame` summary:
`{count, factors, base_exposure, exposures, gain, colour_gains, raw, frames: [per-item meta]}`.

OFBK container:

```
0   4   magic "OFBK"
4   4   count u32 LE
then count × { meta_len u32 LE, meta JSON, data_len u32 LE, data }
```

`meta` = still X-Frame shape plus `factor`, `index`, `kind` ("jpeg" | "raw"), `requested_exposure`.
`data` = JPEG (quality 95) or a complete OFRW v2 record (10-bit, unpacked) when `raw=1`.

## 4. Frame metadata `matched` flag

Stream frames (`event.frame`, MJPEG `X-Frame`, `/snapshot.jpg`) now carry `matched: true|false`.
`false` means the encoder's timestamp was not found in the metadata ring and `ts`/`exposure`
belong to the newest frame instead (logged once at WARNING). Anything that interpolates z from
`ts` (autofocus sweeps, per-frame position) should skip or down-weight `matched: false` frames.
The fake always reports `matched: true`.

## 5. Still image quality controls

- `still_clean` (config `camera.still_clean`, default true; RPC `camera.set_still_clean(enabled:
  bool)`; shown in `camera.status()` as `still_clean`, persisted in `camera.json`): stills, raws
  and brackets get `NoiseReductionMode Off` and `Sharpness 0`. The stream is unchanged.
- Still JPEG quality pinned to 95 (`camera.still_jpeg_quality`); stills are encoded from the
  request with PIL, and `Picamera2.options["quality"]` is set for the idle-snapshot path.
- JPEG still config has no raw stream (`raw=None`); raw still config has a 640×480 main
  (`camera.raw_main_size`). Saves ~16 MB of buffers each on the Pi.
- Explicit `FrameDurationLimits`: stream `(33333, 500000)` (`camera.stream_frame_duration_us`),
  stills `(100, 1000000)` (`camera.still_frame_duration_us`). Both appear in `camera.status()`
  under `frame_duration_limits_us`. A Settings UI could expose the stream max for dim samples.
- `camera.status()` also reports `still_jpeg_quality`, `max_raw_frames`, `max_bracket_frames`.

## 6. RPC / status additions

- `camera.set_still_clean(enabled: bool = True) -> {still_clean}`
- `camera.metadata` now runs under the camera lock (no crash during `set_tuning` reinit) and its
  result is JSON-sanitised.

## 7. Suggested README / CLAUDE.md notes (not written by me)

- CLAUDE.md conventions: "Raw captures are OFRW v2 (`device/openflexito/rawfmt.py`): v1 header +
  pixels + JSON trailer; `frames=N` averages in one mode switch and ships 16-bit; `packed=1` is
  CSI2P 4-in-5; `/flat.bin` is the same with `flat: true`; `/bracket.bin` is an OFBK container.
  Stills carry their own metadata in `X-Frame` (`still: true`). Stills use `still_clean` (ISP
  denoise/sharpen off) and JPEG quality 95."
- README hardware notes: FrameDurationLimits defaults and the fact that the 3280×2464 mode's
  floor is ~66.7 ms (15 fps), so the stream's 33333 µs minimum is clamped by libcamera.

## 8. Hypotheses to verify on the real Pi (picamera2 is not in `device/.venv`)

1. `Picamera2.switch_mode(config_dict)` (public, blocking) followed by `capture_request()` and a
   second `switch_mode(video_config)` behaves like `switch_mode_and_capture_request`, and the
   `_video_config` dict is still accepted by `configure()` after picamera2 aligned it.
2. `create_still_configuration(raw=None)` really drops the raw stream (picamera2 treats `raw={}`
   as "add one", `None` as "none").
3. `libcamera.controls.draft.NoiseReductionModeEnum.Off` is accepted in a configuration's
   `controls` dict on this libcamera build (picamera2 itself puts the enum there).
4. Stream `FrameDurationLimits (33333, 500000)`: min below the mode floor is clamped, and AE now
   goes past 66 ms on dim samples (the audit's clamp hypothesis).
5. Exposure change latency in still mode is ≤ 8 frames and the reported `ExposureTime` lands
   within 5 % of the request (IMX219 line-time rounding is far below that).
6. `request.make_array("raw")` for SBGGR10 returns uint16 (or a uint8 view of it); the existing
   `view(np.uint16)[:h, :w]` handles both. CPU: 8 × 16 MB uint32 adds is ~0.3 s on a Pi 3.
7. Memory: at most one 16 MB copy plus one 32 MB uint32 accumulator are live during
   `frames=8`; the request buffer is released after each add.
