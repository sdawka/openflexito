"""Fake camera for developing on a laptop: synthesises a stage-coupled specimen (1 px/step, 4° axis
rotation, defocus ∝ |z|) so calibration, autofocus and scans work end to end without hardware.
Selected with `camera.fake = true` / `--fake`; see `make_camera` in camera.py.

Focus model. The in-focus plane is z_focus = a*x + b*y (steps); defocus = |z - z_focus + focus_offset|.
`OPENFLEXITO_FAKE_TILT=a,b` sets (a, b) as steps of z per x-step and per y-step (floats, default 0,0), so
a scan has to track a tilted plane. Every stream frame and still carries `focus_fom`, a stand-in for
libcamera's FocusFoM: the mean squared horizontal Brenner gradient (2 px apart) of the rendered grey
frame (decimated to <= 410 px wide, the overlay text rows excluded) times 100, as an int. It peaks at
the focal plane and falls monotonically with defocus. Deterministic and ~1 ms."""
from __future__ import annotations

import asyncio
import io
import logging
import math
import os
import threading
import time
from fractions import Fraction
from pathlib import Path

from .clock import now_ns
from .config import CameraConfig
from .events import EventBus
from .camera import CameraBase, MosaicAccumulator, encode_bracket

log = logging.getLogger(__name__)


# ---- lens shading model -------------------------------------------------------------------------
# Real scans show the same vignetting + colour shading in every tile (yellowish and magenta corners),
# which a stitcher must remove. The fake reproduces it with one deterministic model, applied in
# linear light to the stream/stills (`_shade`) and as the illumination of the RAW mosaic
# (`_raw_mosaic`), so a measured flat field (`/flat.bin`) describes exactly what the stills carry.
VIGNETTE = 0.17             # 1 - VIGNETTE * (nx² + ny²): corner (nx = ny = 1) = 0.66 of the centre
WARM_CORNER = (0.06, 0.035, 0.0)    # +R +G toward the top-left corner (yellow)
MAGENTA_CORNER = (0.045, 0.0, 0.06)  # +R +B toward the bottom-right corner
HORIZONTAL_GRADIENT = 0.06  # left edge 0.97, right edge 1.03 of the centre (all channels)
_SHADING_CACHE: dict = {}


def shading(w: int, h: int):
    """Per-channel linear-light multipliers (r, g, b), each float32 (h, w); cached per size."""
    key = (int(w), int(h))
    if key not in _SHADING_CACHE:
        import numpy as np
        u = (np.arange(w, dtype=np.float32) + 0.5) / w   # 0..1 across
        v = (np.arange(h, dtype=np.float32) + 0.5) / h   # 0..1 down
        u, v = np.meshgrid(u, v)
        base = (1 - VIGNETTE * ((2 * u - 1) ** 2 + (2 * v - 1) ** 2)) * (1 + HORIZONTAL_GRADIENT * (u - 0.5))
        tl = (1 - u) * (1 - v)   # 1 at the top-left corner, 0 along the right and bottom edges
        br = u * v
        chans = tuple((base * (1 + WARM_CORNER[c] * tl + MAGENTA_CORNER[c] * br)).astype(np.float32) for c in range(3))
        if len(_SHADING_CACHE) >= 6:
            _SHADING_CACHE.pop(next(iter(_SHADING_CACHE)))
        _SHADING_CACHE[key] = chans
    return _SHADING_CACHE[key]


def shading_mosaic(w: int, h: int):
    """The same shading laid out as a BGGR mosaic multiplier (h, w) for the RAW path; cached."""
    key = ("mosaic", int(w), int(h))
    if key not in _SHADING_CACHE:
        import numpy as np
        r, g, b = shading(w, h)
        m = g.copy()
        m[0::2, 0::2] = b[0::2, 0::2]
        m[1::2, 1::2] = r[1::2, 1::2]
        _SHADING_CACHE[key] = m
    return _SHADING_CACHE[key]


def shade(img):
    """Apply `shading` to an sRGB PIL image in linear light (gamma 2.2 decode / encode)."""
    import numpy as np
    from PIL import Image
    a = np.asarray(img.convert("RGB"), dtype=np.float32) / 255
    lin = a ** 2.2
    r, g, b = shading(img.width, img.height)
    lin *= np.stack((r, g, b), axis=-1)
    out = np.clip(lin, 0, 1) ** (1 / 2.2) * 255
    return Image.fromarray(np.rint(out).astype(np.uint8), "RGB")


class FakeCamera(CameraBase):
    is_fake = True
    """Synthesises a moving test pattern so the webapp can be developed without hardware."""

    def __init__(self, cfg: CameraConfig, state_dir: Path, events: EventBus, fps: float = 15.0):
        super().__init__(cfg, state_dir, events)
        self.fps = fps
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.sensor = {"model": "fake-imx219", "pixel_array_size": list(cfg.full_size), "modes": []}
        self.focus_offset = 0  # set by tests/dev tools to emulate defocus
        self.tilt = self._parse_tilt(os.environ.get("OPENFLEXITO_FAKE_TILT", ""))  # (a, b): z_focus = a*x + b*y
        self._still_fom: int | None = None
        # The fake specimen is coupled to the stage: the app installs a position provider so that
        # moving x/y scrolls the image (PX_PER_STEP at stream resolution, axes rotated slightly)
        # and moving z away from 0 defocuses it. This lets the browser-side mapping, scan and
        # autofocus routines be exercised end to end without hardware.
        self.position_provider = None
        self._specimen = None
        self._rng = None  # numpy Generator for raw shot noise (lazy: numpy is a dev/pi extra)
        # recording: PyAV's libx264 stands in for the Pi's hardware H.264 encoder (optional dev extra)
        self._rec_lock = threading.Lock()
        self._rec: dict | None = None
        self._fast: dict | None = None

    @staticmethod
    def _parse_tilt(text: str) -> tuple[float, float]:
        try:
            a, b = (float(v) for v in text.split(","))
            return a, b
        except ValueError:
            if text.strip():
                log.warning("OPENFLEXITO_FAKE_TILT=%r is not 'a,b'; using 0,0", text)
            return 0.0, 0.0

    def z_focus(self, pos: dict) -> float:
        """z (steps) at which the specimen is sharp for the stage position `pos`."""
        return self.tilt[0] * pos.get("x", 0) + self.tilt[1] * pos.get("y", 0)

    @staticmethod
    def focus_fom(img) -> int:
        """Stand-in for libcamera's FocusFoM from a rendered PIL image (see the module docstring)."""
        import numpy as np
        g = np.asarray(img.convert("L"), dtype=np.float32)
        g = g[30:]  # skip the overlay text rows, which do not depend on focus
        step = max(1, -(-g.shape[1] // 410))
        g = g[::step, ::step]
        d = g[:, 2:] - g[:, :-2]
        return int(round(float(np.mean(d * d)) * 100))

    PX_PER_STEP = 1.0          # image pixels per motor step at stream resolution (a 1640 px field is ~1640 steps)
    AXIS_ROTATION_DEG = 4.0    # the camera is never perfectly aligned with the stage
    SPECIMEN_SIZE = (2048, 1536)

    def _make_specimen(self):
        """Default: ~900 cells of 6–40 px radius plus fibres. `OPENFLEXITO_FAKE_SPECIMEN=fine` draws
        ~20000 cells of 1.5–5 px instead: the same colours, but features small against the field, so
        a stitched mosaic folded by the tile pitch (webapp/e2e/mosaicMetric.mjs) averages the
        specimen out and shows only the per-tile shading."""
        import os
        import random
        from PIL import Image, ImageDraw
        rnd = random.Random(42)
        w, h = self.SPECIMEN_SIZE
        img = Image.new("RGB", (w, h), (236, 232, 226))
        d = ImageDraw.Draw(img)
        fine = os.environ.get("OPENFLEXITO_FAKE_SPECIMEN", "cells") == "fine"
        for _ in range(20000 if fine else 900):  # cells: filled ellipses with darker outlines, varied colour
            cx, cy = rnd.uniform(0, w), rnd.uniform(0, h)
            rx, ry = (rnd.uniform(1.5, 5), rnd.uniform(1.5, 5)) if fine else (rnd.uniform(6, 40), rnd.uniform(6, 40))
            col = (rnd.randint(120, 220), rnd.randint(60, 160), rnd.randint(120, 200))
            d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=col, outline=(70, 40, 90), width=1 if fine else 2)
        for _ in range(300):  # fibres
            x0, y0 = rnd.uniform(0, w), rnd.uniform(0, h)
            d.line([(x0, y0), (x0 + rnd.uniform(-120, 120), y0 + rnd.uniform(-120, 120))], fill=(90, 70, 110), width=rnd.randint(1, 3))
        return img

    RENDER_SCALE = 0.5  # render (and blur) at half stream resolution, then resize: keeps ~15 fps on a laptop

    def _render(self, pos: dict, scale: float | None = None):
        """Specimen view for the current stage position at `scale` (default RENDER_SCALE) of the
        stream size."""
        from PIL import Image, ImageChops, ImageDraw, ImageFilter
        if self._specimen is None:
            self._specimen = self._make_specimen()
        sw, sh = self.stream_size
        scale = self.RENDER_SCALE if scale is None else scale
        rw, rh = int(sw * scale), int(sh * scale)
        a = math.radians(self.AXIS_ROTATION_DEG)
        # stage x/y -> image shift in stream pixels
        dx = (pos["x"] * math.cos(a) - pos["y"] * math.sin(a)) * self.PX_PER_STEP
        dy = -(pos["x"] * math.sin(a) + pos["y"] * math.cos(a)) * self.PX_PER_STEP
        spec_w, spec_h = self.SPECIMEN_SIZE
        shifted = ImageChops.offset(self._specimen, int(round(-dx)) % spec_w, int(round(-dy)) % spec_h)
        crop = shifted.crop(((spec_w - sw) // 2, (spec_h - sh) // 2, (spec_w - sw) // 2 + sw, (spec_h - sh) // 2 + sh))
        img = crop.resize((rw, rh), Image.BILINEAR)
        defocus = abs(pos.get("z", 0) - self.z_focus(pos) + self.focus_offset)
        if defocus:
            img = img.filter(ImageFilter.GaussianBlur(min(20, defocus / 100) * scale))
        img = shade(img)  # the stage-coupled specimen under the lens' vignetting + colour shading
        d = ImageDraw.Draw(img)
        d.text((10, 10), f"openflexito fake camera {time.strftime('%H:%M:%S')}  x{pos['x']} y{pos['y']} z{pos['z']}", fill=(40, 40, 40))
        return img

    def _position(self) -> dict:
        if self.position_provider is not None:
            try:
                return dict(self.position_provider())
            except Exception:  # noqa: BLE001
                pass
        return {"x": 0, "y": 0, "z": 0}

    @staticmethod
    def _jpeg(img, size: tuple[int, int]) -> bytes:
        from PIL import Image
        buf = io.BytesIO()
        (img if img.size == size else img.resize(size, Image.BILINEAR)).save(buf, "JPEG", quality=80)
        return buf.getvalue()

    def _frame(self, size: tuple[int, int], t: float) -> bytes:
        return self._jpeg(self._render(self._position()), size)

    FAST_FPS_CAP = 60  # what PIL can render on a laptop; the stream says the rate it asked for

    def _run(self) -> None:
        t = 0.0
        last_preview = 0.0
        while not self._stop.is_set():
            ts = now_ns()
            meta = {**self._metadata(ts), "matched": True}
            with self._rec_lock:
                rec, fast = self._rec, self._fast
            if fast is not None:
                t0 = time.monotonic()
                fimg = self._render(self._position())
                meta["focus_fom"] = self.focus_fom(fimg)
                jpeg = self._jpeg(fimg, fast["size"])
                fast["tap"].put_threadsafe((jpeg, ts))
                if time.monotonic() - last_preview >= 1 / 15:
                    last_preview = time.monotonic()
                    self.main.publish_threadsafe(jpeg, meta)
                self._stop.wait(max(0.0, fast["gap"] - (time.monotonic() - t0)))  # the gap includes the render
                continue
            if rec is not None:
                # render at the full stream size so the recording is not an upscaled thumbnail
                img = self._render(self._position(), scale=1.0)
                self._record_frame(rec, img, ts)
            else:
                img = self._render(self._position())  # one render feeds both streams
            meta["focus_fom"] = self.focus_fom(img)
            self.main.publish_threadsafe(self._jpeg(img, self.stream_size), meta)
            if rec is None:  # like the Pi, the lores stream pauses while recording
                self.lores.publish_threadsafe(self._jpeg(img, tuple(self.cfg.lores_size)), meta)
            t += 1 / self.fps
            self._stop.wait(1 / self.fps)

    async def start(self) -> None:
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="fake-camera", daemon=True)
        self._thread.start()

    async def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        self._end_taps()  # standby ends a running recording or fast stream, as on the Pi
        with self._rec_lock:
            self._rec = None
            self._fast = None

    # ---- recording ------------------------------------------------------------------------

    def record_available(self) -> bool:
        try:
            import av
        except ImportError:
            return False
        return "libx264" in av.codecs_available

    async def _start_recording(self, tap, fps: int, bitrate: int, iperiod: int) -> None:
        import av
        w, h = self.cfg.record_size
        codec = av.CodecContext.create("libx264", "w")
        codec.width, codec.height, codec.pix_fmt = int(w), int(h), "yuv420p"
        codec.time_base = Fraction(1, 1_000_000)
        codec.framerate = Fraction(min(fps, int(self.fps)), 1)
        codec.bit_rate = int(bitrate)
        # like the Pi's encoder: no B-frames (decode order = presentation order), SPS/PPS in-band
        codec.options = {"preset": "ultrafast", "tune": "zerolatency", "g": str(iperiod), "bf": "0",
                         "x264-params": "repeat-headers=1"}
        codec.open()
        with self._rec_lock:
            self._rec = {"tap": tap, "codec": codec, "size": (int(w), int(h)), "gap_ns": int(1e9 / fps), "last": None}

    def _record_frame(self, rec: dict, img, ts: int) -> None:
        import av
        from PIL import Image
        if rec["last"] is not None and ts - rec["last"] < rec["gap_ns"] * 0.9:
            return
        rec["last"] = ts
        try:
            frame = av.VideoFrame.from_image(img.resize(rec["size"], Image.BILINEAR)).reformat(format="yuv420p")
            frame.pts = ts // 1000
            for pkt in rec["codec"].encode(frame):
                rec["tap"].put_threadsafe(bytes(pkt), int(pkt.pts) * 1000 if pkt.pts is not None else None, bool(pkt.is_keyframe))
        except Exception:  # noqa: BLE001  keep the fake camera thread alive
            log.exception("fake recording frame failed")

    async def _stop_recording(self) -> None:
        with self._rec_lock:
            rec, self._rec = self._rec, None
        if rec is None:
            return
        try:
            for pkt in rec["codec"].encode(None):  # flush
                rec["tap"].put_threadsafe(bytes(pkt), int(pkt.pts) * 1000 if pkt.pts is not None else None, bool(pkt.is_keyframe))
        except Exception:  # noqa: BLE001
            log.exception("fake recording flush failed")

    # ---- fast stream -----------------------------------------------------------------------

    async def _start_fast(self, tap, spec: dict, fps: int, bitrate: int) -> None:
        with self._rec_lock:
            self._fast = {"tap": tap, "size": tuple(int(v) for v in spec["size"]),
                          "gap": 1 / min(fps, self.FAST_FPS_CAP)}

    async def _stop_fast(self) -> None:
        with self._rec_lock:
            self._fast = None

    async def _apply_controls(self, controls: dict) -> None:
        return None

    async def _reinit(self) -> None:
        await self.stop()
        await self.start()

    # ---- metadata / stills ---------------------------------------------------------------

    def _metadata(self, ts: int | None = None, exposure: int | None = None) -> dict:
        """What a libcamera request would report, derived from the current controls."""
        ts = now_ns() if ts is None else ts
        exposure = int(self.controls["ExposureTime"]) if exposure is None else int(exposure)
        return {"ts": ts, "exposure": exposure, "gain": float(self.controls["AnalogueGain"]), "digital_gain": 1.0,
                "colour_gains": [float(g) for g in self.controls["ColourGains"]], "focus_fom": None, "lux": 400.0,
                "frame_duration": max(exposure, 33333), "colour_temperature": 5000, "t": ts}

    def _still_jpeg(self, factor: float = 1.0) -> bytes:
        from PIL import Image, ImageEnhance
        img = self._render(self._position())
        self._still_fom = self.focus_fom(img)
        if factor != 1.0:
            img = ImageEnhance.Brightness(img).enhance(factor)
        size = tuple(self.cfg.full_size)
        buf = io.BytesIO()
        (img if img.size == size else img.resize(size, Image.BILINEAR)).save(buf, "JPEG", quality=self.cfg.still_jpeg_quality)
        return buf.getvalue()

    async def snapshot(self, full: bool = False) -> bytes:
        if full:
            return (await self.still())[0]
        return self.main.jpeg

    async def still(self) -> tuple[bytes, dict]:
        jpeg = await asyncio.to_thread(self._still_jpeg)
        w, h = self.cfg.full_size
        return jpeg, {**self._metadata(), "still": True, "matched": True, "width": w, "height": h, "size": len(jpeg),
                      "focus_fom": self._still_fom}

    def _raw_mosaic(self, exposure: int | None = None):
        """Blank-field BGGR mosaic with shot noise, scaled by exposure and gain (10 bit, uint16), under
        the same `shading` as the stills so a measured flat field matches them."""
        import numpy as np
        if self._rng is None:
            self._rng = np.random.default_rng(1)
        w, h = self.cfg.full_size
        exposure = int(self.controls["ExposureTime"]) if exposure is None else int(exposure)
        level = 600 * shading_mosaic(w, h) * min(1.0, exposure / 5000) * float(self.controls["AnalogueGain"])
        level[0::2, 0::2] *= 0.8  # B weaker
        level[1::2, 1::2] *= 0.9  # R weaker
        noisy = level + self._rng.normal(0, 8, size=level.shape) + self.cfg.black_level
        return np.clip(np.rint(noisy), 0, 1023).astype("<u2")

    async def capture_raw(self, frames: int = 1, packed: bool = False, flat: bool = False) -> tuple[bytes, dict]:
        frames = self._check_raw_args(frames, packed)

        def capture():
            acc, metas = MosaicAccumulator(10), []
            for _ in range(frames):
                acc.add(self._raw_mosaic())
                metas.append(self._metadata())
            return self._encode_raw(acc, metas, packed, flat)
        return await asyncio.to_thread(capture)

    async def capture_bracket(self, factors: list[float], raw: bool = False) -> tuple[bytes, dict]:
        factors = self._check_bracket_args(factors)
        base = int(self.controls["ExposureTime"])
        exposures = [max(20, min(int(self.cfg.still_frame_duration_us[1]), int(round(base * f)))) for f in factors]
        w, h = self.cfg.full_size

        def capture():
            items = []
            for i, (f, exp) in enumerate(zip(factors, exposures)):
                md = self._metadata(exposure=exp)
                if raw:
                    data, _ = self._encode_raw([self._raw_mosaic(exp)], [md], False, False)
                else:
                    data = self._still_jpeg(factor=exp / base if base else 1.0)
                items.append(({**md, "still": True, "matched": True, "width": w, "height": h, "size": len(data),
                               "factor": f, "index": i, "kind": "raw" if raw else "jpeg", "requested_exposure": exp}, data))
            return items
        items = await asyncio.to_thread(capture)
        summary = {"count": len(items), "factors": factors, "base_exposure": base, "exposures": exposures,
                   "gain": float(self.controls["AnalogueGain"]), "colour_gains": list(self.controls["ColourGains"]),
                   "raw": raw, "frames": [m for m, _ in items]}
        return encode_bracket(items), summary
