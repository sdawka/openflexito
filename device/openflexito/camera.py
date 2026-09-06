"""Camera: picamera2 + hardware MJPEG encoder with a frame fan-out, plus a fake for dev.

The device does no image processing. It exposes:
  * the latest JPEG frame (for MJPEG streaming) with per-frame metadata,
  * a full-resolution still,
  * an unprocessed raw Bayer capture (for browser-side calibration),
  * libcamera controls and the tuning file (read/write).
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import math
import struct
import threading
import time
from collections import deque
from importlib import resources
from pathlib import Path
from typing import Any

from .clock import now_ns
from .config import CameraConfig
from .events import EventBus

log = logging.getLogger(__name__)

PERSISTENT_CONTROL_KEYS = ("ExposureTime", "AnalogueGain", "ColourGains", "Brightness",
                           "Contrast", "Saturation", "Sharpness", "AeEnable", "AwbEnable")
# Until the browser-side calibration fixes exposure and colour, an uncalibrated camera runs
# with auto exposure and auto white balance so the first picture is usable rather than green.
DEFAULT_CONTROLS: dict[str, Any] = {
    "AeEnable": True, "AwbEnable": True, "ExposureTime": 500, "AnalogueGain": 1.0,
    "ColourGains": [1.0, 1.0], "Brightness": 0.0, "Contrast": 1.0, "Saturation": 1.0, "Sharpness": 1.0,
}
RAW_MAGIC = b"OFRW"
RAW_HEADER = struct.Struct("<4sIIHH8s")  # magic, width, height, bit_depth, black_level, bayer order


class FrameHub:
    """Latest-frame buffer with async wakeups; written from the encoder thread."""

    def __init__(self, events: EventBus, name: str):
        self.events = events
        self.name = name
        self.seq = 0
        self.jpeg: bytes = b""
        self.meta: dict = {}
        self._cond = asyncio.Condition()
        self._loop: asyncio.AbstractEventLoop | None = None
        self.clients = 0
        self.on_clients = None  # optional callback(hub) invoked by the web layer when `clients` changes

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def publish_threadsafe(self, jpeg: bytes, meta: dict) -> None:
        if self._loop is None:
            return
        self._loop.call_soon_threadsafe(self._publish, jpeg, meta)

    def _publish(self, jpeg: bytes, meta: dict) -> None:
        self.seq += 1
        self.jpeg = jpeg
        self.meta = {**meta, "seq": self.seq, "size": len(jpeg), "stream": self.name}
        if self.name == "main":
            self.events.publish("frame", self.meta)
        asyncio.ensure_future(self._notify())

    async def _notify(self) -> None:
        async with self._cond:
            self._cond.notify_all()

    async def next_frame(self, last_seq: int) -> tuple[bytes, dict]:
        async with self._cond:
            while self.seq == last_seq:
                await self._cond.wait()
            return self.jpeg, self.meta


class CameraBase:
    def __init__(self, cfg: CameraConfig, state_dir: Path, events: EventBus):
        self.active = False
        self.cfg = cfg
        self.state_dir = Path(state_dir)
        self.events = events
        self.main = FrameHub(events, "main")
        self.lores = FrameHub(events, "lores")
        self.controls: dict[str, Any] = dict(DEFAULT_CONTROLS)
        self.tuning: dict = {}
        self.stream_size = tuple(cfg.stream_size)
        self.sensor: dict = {}
        self._load_controls()
        self.tuning = self._load_tuning()

    # ---- persistence -----------------------------------------------------------------------

    @property
    def controls_file(self) -> Path:
        return self.state_dir / "camera.json"

    @property
    def tuning_file(self) -> Path:
        return self.state_dir / f"{self.cfg.tuning_name}.json"

    def _load_controls(self) -> None:
        try:
            data = json.loads(self.controls_file.read_text())
            self.controls.update({k: v for k, v in data.get("controls", {}).items() if k in PERSISTENT_CONTROL_KEYS})
            if "stream_size" in data:
                self.stream_size = tuple(data["stream_size"])
        except (OSError, ValueError):
            pass

    def _save_controls(self) -> None:
        try:
            self.state_dir.mkdir(parents=True, exist_ok=True)
            self.controls_file.write_text(json.dumps({"controls": self.controls, "stream_size": list(self.stream_size)}))
        except OSError as e:
            log.warning("could not save camera settings: %s", e)

    def default_tuning(self) -> dict:
        try:
            return json.loads(resources.files("openflexito").joinpath(f"tuning/{self.cfg.tuning_name}.json").read_text())
        except (OSError, ValueError):
            return {}

    def _load_tuning(self) -> dict:
        try:
            return json.loads(self.tuning_file.read_text())
        except (OSError, ValueError):
            return self.default_tuning()

    # ---- API shared by real and fake -------------------------------------------------------

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self.main.bind(loop)
        self.lores.bind(loop)

    def status(self) -> dict:
        return {
            "sensor": self.sensor, "stream_size": list(self.stream_size),
            "controls": self.controls, "clients": self.main.clients + self.lores.clients,
            "tuning_customised": self.tuning_file.exists(), "fake": isinstance(self, FakeCamera),
            "last_frame": self.main.meta,
        }

    async def get_controls(self) -> dict:
        return dict(self.controls)

    async def set_controls(self, **controls) -> dict:
        for k, v in controls.items():
            if k not in PERSISTENT_CONTROL_KEYS:
                raise ValueError(f"unknown control {k}")
            self.controls[k] = v
        self._save_controls()
        await self._apply_controls({k: self.controls[k] for k in controls})
        return dict(self.controls)

    async def get_tuning(self) -> dict:
        return self.tuning

    async def set_tuning(self, tuning: dict) -> dict:
        if not isinstance(tuning, dict) or "algorithms" not in tuning and "rpi.alsc" not in tuning:
            raise ValueError("tuning must be a libcamera tuning JSON object")
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.tuning_file.write_text(json.dumps(tuning))
        self.tuning = tuning
        await self._reinit()
        return {"ok": True}

    async def reset_tuning(self) -> dict:
        try:
            self.tuning_file.unlink()
        except FileNotFoundError:
            pass
        self.tuning = self.default_tuning()
        await self._reinit()
        return {"ok": True}

    async def set_stream_size(self, width: int, height: int) -> dict:
        self.stream_size = (int(width), int(height))
        self._save_controls()
        await self._reinit()
        return {"stream_size": list(self.stream_size)}

    # ---- to implement ----------------------------------------------------------------------

    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    async def _apply_controls(self, controls: dict) -> None: ...
    async def _reinit(self) -> None: ...
    def set_active(self, active: bool) -> None:
        """Called by the app when the number of stream + WebSocket clients crosses zero.
        Encoders only run while someone is connected (they cost ~30% of a Pi 3 core)."""
        self.active = active

    async def snapshot(self, full: bool = False) -> bytes: ...
    async def capture_raw(self) -> bytes: ...
    async def capture_metadata(self) -> dict: return dict(self.main.meta)


def pack_raw(width: int, height: int, bit_depth: int, black_level: int, bayer: str, data: bytes) -> bytes:
    return RAW_HEADER.pack(RAW_MAGIC, width, height, bit_depth, black_level, bayer.encode()[:8].ljust(8, b"\0")) + data


# ================================ real camera ===================================================

class PiCamera(CameraBase):
    def __init__(self, cfg: CameraConfig, state_dir: Path, events: EventBus):
        super().__init__(cfg, state_dir, events)
        from picamera2 import Picamera2  # noqa: F401  (import check)
        self._picam = None
        self._encoders: dict = {}
        self._meta_ring: deque = deque(maxlen=8)
        self._lock = asyncio.Lock()

    def _open(self):
        from picamera2 import Picamera2
        from libcamera import controls as lc  # noqa: F401
        tuning = self.tuning or None
        self._picam = Picamera2(tuning=tuning) if tuning else Picamera2()
        props = self._picam.camera_properties
        self.sensor = {"model": props.get("Model"), "pixel_array_size": list(props.get("PixelArraySize", ())),
                       "modes": [{"size": list(m["size"]), "bit_depth": m["bit_depth"], "fps": m.get("fps")}
                                 for m in self._picam.sensor_modes]}
        self._video_config = self._picam.create_video_configuration(
            main={"size": self.stream_size, "format": "YUV420"},
            lores={"size": tuple(self.cfg.lores_size), "format": "YUV420"},
            raw=None,  # no raw stream while streaming: saves a per-frame DMA sync of a 4 MB buffer on the Pi 3
            sensor={"output_size": tuple(self.cfg.sensor_size), "bit_depth": 10},
            controls=self._libcamera_controls(self.controls),
            buffer_count=4,
        )
        self._picam.configure(self._video_config)
        self._picam.post_callback = self._on_request
        self.lores.on_clients = self._lores_clients_changed

    @staticmethod
    def _libcamera_controls(controls: dict) -> dict:
        """Map our persistent controls to libcamera controls. Manual values are only sent when the
        matching auto algorithm is off: libcamera treats an explicit ColourGains as "AWB off" and
        explicit ExposureTime/AnalogueGain as "AE off", which would silently defeat the auto modes."""
        out = {}
        ae, awb = bool(controls.get("AeEnable", False)), bool(controls.get("AwbEnable", False))
        for k, v in controls.items():
            if ae and k in ("ExposureTime", "AnalogueGain"):
                continue
            if awb and k == "ColourGains":
                continue
            if k == "ExposureTime":
                out[k] = int(v) + 1  # picamera2 rounds down / drifts on restart; v3 does the same
            elif k == "ColourGains":
                out[k] = (float(v[0]), float(v[1]))
            elif k in ("AeEnable", "AwbEnable"):
                out[k] = bool(v)
            else:
                out[k] = float(v)
        return out

    def _on_request(self, request) -> None:
        md = request.get_metadata()
        self._meta_ring.append({
            "ts": md.get("SensorTimestamp"), "exposure": md.get("ExposureTime"), "gain": md.get("AnalogueGain"),
            "digital_gain": md.get("DigitalGain"), "colour_gains": list(md.get("ColourGains", ()) or ()),
            "focus_fom": md.get("FocusFoM"), "lux": md.get("Lux"), "frame_duration": md.get("FrameDuration"),
            "t": now_ns(),
        })

    def _meta_for(self, timestamp_us) -> dict:
        if timestamp_us is not None:
            for m in reversed(self._meta_ring):
                if m.get("ts") is not None and m["ts"] // 1000 == timestamp_us:
                    return m
        return self._meta_ring[-1] if self._meta_ring else {"t": now_ns()}

    def _make_output(self, hub: FrameHub, encoder):
        from picamera2.outputs import Output
        cam = self

        class HubOutput(Output):
            def outputframe(self, frame, keyframe=True, timestamp=None, packet=None, audio=False):  # noqa: D401
                # picamera2 encoders report timestamps relative to their first frame; add the
                # offset back to get SensorTimestamp/1000 and look up that frame's metadata.
                abs_us = None if timestamp is None else int(timestamp) + int(encoder.firsttimestamp or 0)
                hub.publish_threadsafe(bytes(frame), cam._meta_for(abs_us))
        return HubOutput()

    def _wanted_encoders(self) -> set[str]:
        if not self.active:
            return set()
        return {"main", "lores"} if self.lores.clients > 0 else {"main"}

    def _start_encoders(self) -> None:
        """Start the encoders that are currently wanted: none without clients, the main MJPEG
        encoder while anyone is connected, plus lores only while it has stream clients (each
        encoder costs a poll thread and per-frame buffer copies on the Pi 3)."""
        for name in sorted(self._wanted_encoders()):
            self._start_encoder(name)

    def _sync_encoders_sync(self) -> None:
        wanted = self._wanted_encoders()
        for name in list(self._encoders):
            if name not in wanted:
                self._stop_encoder(name)
        for name in sorted(wanted):
            self._start_encoder(name)

    def _start_encoder(self, name: str) -> None:
        from picamera2.encoders import MJPEGEncoder
        if name in self._encoders or self._picam is None or not self._picam.started:
            return
        hub = self.main if name == "main" else self.lores
        bitrate = self.cfg.bitrate if name == "main" else self.cfg.lores_bitrate
        enc = MJPEGEncoder(bitrate=bitrate)
        self._picam.start_encoder(enc, self._make_output(hub, enc), name=name)
        self._encoders[name] = enc
        log.info("%s encoder started", name)

    def _stop_encoder(self, name: str) -> None:
        enc = self._encoders.pop(name, None)
        if enc is not None:
            try:
                self._picam.stop_encoder(enc)
                log.info("%s encoder stopped", name)
            except Exception:  # noqa: BLE001
                pass

    def _stop_encoders(self) -> None:
        for name in list(self._encoders):
            self._stop_encoder(name)

    def _lores_clients_changed(self, hub: FrameHub) -> None:
        asyncio.ensure_future(self._sync_encoders())

    def set_active(self, active: bool) -> None:
        if active != self.active:
            self.active = active
            asyncio.ensure_future(self._sync_encoders())

    async def _sync_encoders(self) -> None:
        async with self._lock:
            await asyncio.to_thread(self._sync_encoders_sync)

    async def start(self) -> None:
        await asyncio.to_thread(self._start_sync)

    def _start_sync(self) -> None:
        self._open()
        self._picam.start()
        self._picam.set_controls(self._libcamera_controls(self.controls))
        self._start_encoders()
        log.info("camera streaming %sx%s (sensor %s)", *self.stream_size, self.cfg.sensor_size)

    async def stop(self) -> None:
        await asyncio.to_thread(self._stop_sync)

    def _stop_sync(self) -> None:
        if self._picam is None:
            return
        self._stop_encoders()
        try:
            self._picam.stop()
            self._picam.close()
        finally:
            self._picam = None

    async def _reinit(self) -> None:
        async with self._lock:
            await asyncio.to_thread(self._reinit_sync)

    def _reinit_sync(self) -> None:
        import gc
        from picamera2 import Picamera2
        self._stop_sync()
        # A new tuning file only takes effect with a fresh CameraManager.
        try:
            del Picamera2._cm
        except AttributeError:
            pass
        gc.collect()
        from picamera2.picamera2 import CameraManager
        Picamera2._cm = CameraManager()
        self._start_sync()

    async def _apply_controls(self, controls: dict) -> None:
        if self._picam is not None:
            self._picam.set_controls(self._libcamera_controls(controls))

    async def snapshot(self, full: bool = False) -> bytes:
        if not full:
            fresh = self.main.jpeg and now_ns() - int(self.main.meta.get("t") or 0) < 1_000_000_000
            if "main" in self._encoders and fresh:
                return self.main.jpeg
            async with self._lock:  # encoder idle (no clients): software JPEG of the current frame
                return await asyncio.to_thread(self._jpeg_sync)
        async with self._lock:
            return await asyncio.to_thread(self._full_still_sync)

    def _jpeg_sync(self) -> bytes:
        buf = io.BytesIO()
        self._picam.capture_file(buf, "main", format="jpeg")
        return buf.getvalue()

    def _full_still_sync(self) -> bytes:
        still = self._picam.create_still_configuration(
            main={"size": tuple(self.cfg.full_size)}, controls=self._libcamera_controls(self.controls))
        self._stop_encoders()
        try:
            buf = io.BytesIO()
            self._picam.switch_mode_and_capture_file(still, buf, format="jpeg")
            return buf.getvalue()
        finally:
            self._start_encoders()

    async def capture_raw(self) -> bytes:
        async with self._lock:
            return await asyncio.to_thread(self._raw_sync)

    def _raw_sync(self) -> bytes:
        import numpy as np
        w, h = self.cfg.full_size
        still = self._picam.create_still_configuration(
            main={"size": (w, h)}, raw={"format": self.cfg.raw_format, "size": (w, h)},
            controls=self._libcamera_controls(self.controls))
        self._stop_encoders()
        try:
            arr = self._picam.switch_mode_and_capture_array(still, "raw")
        finally:
            self._start_encoders()
        raw16 = arr.view(np.uint16)[:h, :w] if arr.dtype == np.uint8 else arr[:h, :w]
        bayer = self.cfg.raw_format.replace("S", "").rstrip("0123456789P_") or "BGGR"
        return pack_raw(w, h, 10, self.cfg.black_level, bayer, np.ascontiguousarray(raw16, dtype="<u2").tobytes())

    async def capture_metadata(self) -> dict:
        if self._picam is None:
            return {}
        return await asyncio.to_thread(lambda: dict(self._picam.capture_metadata()))


# ================================ fake camera (dev on a laptop) =================================

class FakeCamera(CameraBase):
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
            meta = {"ts": ts, "exposure": self.controls["ExposureTime"], "gain": self.controls["AnalogueGain"],
                    "colour_gains": list(self.controls["ColourGains"]), "focus_fom": None, "lux": None, "t": ts}
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

    async def snapshot(self, full: bool = False) -> bytes:
        if full:
            return await asyncio.to_thread(self._frame, tuple(self.cfg.full_size), time.time())
        return self.main.jpeg

    async def capture_raw(self) -> bytes:
        import numpy as np
        w, h = self.cfg.full_size
        yy, xx = np.mgrid[0:h, 0:w]
        vignette = 1 - 0.5 * (((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2)
        level = self.cfg.black_level + 600 * vignette * min(1.0, self.controls["ExposureTime"] / 5000) * self.controls["AnalogueGain"]
        raw = np.clip(level, 0, 1023).astype("<u2")
        raw[0::2, 0::2] = (raw[0::2, 0::2] * 0.8).astype("<u2")  # B weaker
        raw[1::2, 1::2] = (raw[1::2, 1::2] * 0.9).astype("<u2")  # R weaker
        return pack_raw(w, h, 10, self.cfg.black_level, "BGGR", raw.tobytes())


def make_camera(cfg: CameraConfig, state_dir: Path, events: EventBus) -> CameraBase:
    if cfg.fake:
        return FakeCamera(cfg, state_dir, events)
    try:
        return PiCamera(cfg, state_dir, events)
    except ImportError as e:
        raise RuntimeError("picamera2 not available; set camera.fake = true for development") from e
