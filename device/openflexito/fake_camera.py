"""Fake camera for developing on a laptop: synthesises a stage-coupled specimen (1 px/step, 4° axis
rotation, defocus ∝ |z|) so calibration, autofocus and scans work end to end without hardware.
Selected with `camera.fake = true` / `--fake`; see `make_camera` in camera.py."""
from __future__ import annotations

import asyncio
import io
import logging
import math
import threading
import time
from pathlib import Path

from .clock import now_ns
from .config import CameraConfig
from .events import EventBus
from .camera import CameraBase, MosaicAccumulator, encode_bracket

log = logging.getLogger(__name__)


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
        # The fake specimen is coupled to the stage: the app installs a position provider so that
        # moving x/y scrolls the image (PX_PER_STEP at stream resolution, axes rotated slightly)
        # and moving z away from 0 defocuses it. This lets the browser-side mapping, scan and
        # autofocus routines be exercised end to end without hardware.
        self.position_provider = None
        self._specimen = None
        self._rng = None  # numpy Generator for raw shot noise (lazy: numpy is a dev/pi extra)

    PX_PER_STEP = 1.0          # image pixels per motor step at stream resolution (a 1640 px field is ~1640 steps)
    AXIS_ROTATION_DEG = 4.0    # the camera is never perfectly aligned with the stage
    SPECIMEN_SIZE = (2048, 1536)

    def _make_specimen(self):
        import random
        from PIL import Image, ImageDraw
        rnd = random.Random(42)
        w, h = self.SPECIMEN_SIZE
        img = Image.new("RGB", (w, h), (236, 232, 226))
        d = ImageDraw.Draw(img)
        for _ in range(900):  # cells: filled ellipses with darker outlines, varied colour
            cx, cy = rnd.uniform(0, w), rnd.uniform(0, h)
            rx, ry = rnd.uniform(6, 40), rnd.uniform(6, 40)
            col = (rnd.randint(120, 220), rnd.randint(60, 160), rnd.randint(120, 200))
            d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=col, outline=(70, 40, 90), width=2)
        for _ in range(300):  # fibres
            x0, y0 = rnd.uniform(0, w), rnd.uniform(0, h)
            d.line([(x0, y0), (x0 + rnd.uniform(-120, 120), y0 + rnd.uniform(-120, 120))], fill=(90, 70, 110), width=rnd.randint(1, 3))
        return img

    RENDER_SCALE = 0.5  # render (and blur) at half stream resolution, then resize: keeps ~15 fps on a laptop

    def _render(self, pos: dict):
        """Specimen view for the current stage position at RENDER_SCALE of the stream size."""
        from PIL import Image, ImageChops, ImageDraw, ImageFilter
        if self._specimen is None:
            self._specimen = self._make_specimen()
        sw, sh = self.stream_size
        rw, rh = int(sw * self.RENDER_SCALE), int(sh * self.RENDER_SCALE)
        a = math.radians(self.AXIS_ROTATION_DEG)
        # stage x/y -> image shift in stream pixels
        dx = (pos["x"] * math.cos(a) - pos["y"] * math.sin(a)) * self.PX_PER_STEP
        dy = -(pos["x"] * math.sin(a) + pos["y"] * math.cos(a)) * self.PX_PER_STEP
        spec_w, spec_h = self.SPECIMEN_SIZE
        shifted = ImageChops.offset(self._specimen, int(round(-dx)) % spec_w, int(round(-dy)) % spec_h)
        crop = shifted.crop(((spec_w - sw) // 2, (spec_h - sh) // 2, (spec_w - sw) // 2 + sw, (spec_h - sh) // 2 + sh))
        img = crop.resize((rw, rh), Image.BILINEAR)
        defocus = abs(pos.get("z", 0) + self.focus_offset)
        if defocus:
            img = img.filter(ImageFilter.GaussianBlur(min(20, defocus / 100) * self.RENDER_SCALE))
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

    def _run(self) -> None:
        t = 0.0
        while not self._stop.is_set():
            ts = now_ns()
            meta = {**self._metadata(ts), "matched": True}
            img = self._render(self._position())  # one render feeds both streams
            self.main.publish_threadsafe(self._jpeg(img, self.stream_size), meta)
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
        return jpeg, {**self._metadata(), "still": True, "matched": True, "width": w, "height": h, "size": len(jpeg)}

    def _raw_mosaic(self, exposure: int | None = None):
        """Vignetted BGGR mosaic with shot noise, scaled by exposure and gain (10 bit, uint16)."""
        import numpy as np
        if self._rng is None:
            self._rng = np.random.default_rng(1)
        w, h = self.cfg.full_size
        exposure = int(self.controls["ExposureTime"]) if exposure is None else int(exposure)
        yy, xx = np.mgrid[0:h, 0:w]
        vignette = 1 - 0.5 * (((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2)
        level = 600 * vignette * min(1.0, exposure / 5000) * float(self.controls["AnalogueGain"])
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
