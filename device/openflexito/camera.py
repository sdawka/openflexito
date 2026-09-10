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
        try:
            self._loop.call_soon_threadsafe(self._publish, jpeg, meta)
        except RuntimeError:  # loop closed during shutdown; the encoder thread outlives it briefly
            pass

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
    is_fake = False
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
            "tuning_customised": self.tuning_file.exists(), "fake": self.is_fake,
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
        self._video_config: dict | None = None
        self._encoders: dict = {}
        self._meta_ring: deque = deque(maxlen=8)
        self._meta_lock = threading.Lock()
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
        # Runs on picamera2's event thread for every completed request: an exception here would
        # take that thread down and stop the camera silently, so it must never escape.
        try:
            md = request.get_metadata()
            entry = {
                "ts": md.get("SensorTimestamp"), "exposure": md.get("ExposureTime"), "gain": md.get("AnalogueGain"),
                "digital_gain": md.get("DigitalGain"), "colour_gains": list(md.get("ColourGains", ()) or ()),
                "focus_fom": md.get("FocusFoM"), "lux": md.get("Lux"), "frame_duration": md.get("FrameDuration"),
                "t": now_ns(),
            }
            with self._meta_lock:
                self._meta_ring.append(entry)
        except Exception:  # noqa: BLE001
            log.exception("request metadata callback failed")

    def _meta_for(self, timestamp_us) -> dict:
        # Called on the encoder output thread while _on_request appends on the camera thread:
        # copy under the lock, never iterate the live deque (a RuntimeError here killed
        # picamera2's poll thread and silently froze the stream).
        with self._meta_lock:
            ring = list(self._meta_ring)
        if timestamp_us is not None:
            for m in reversed(ring):
                if m.get("ts") is not None and m["ts"] // 1000 == timestamp_us:
                    return m
        return ring[-1] if ring else {"t": now_ns()}

    def _make_output(self, hub: FrameHub, encoder):
        from picamera2.outputs import Output
        cam = self

        class HubOutput(Output):
            def outputframe(self, frame, keyframe=True, timestamp=None, packet=None, audio=False):  # noqa: D401
                # picamera2 encoders report timestamps relative to their first frame; add the
                # offset back to get SensorTimestamp/1000 and look up that frame's metadata.
                try:
                    abs_us = None if timestamp is None else int(timestamp) + int(encoder.firsttimestamp or 0)
                    hub.publish_threadsafe(bytes(frame), cam._meta_for(abs_us))
                except Exception:  # noqa: BLE001  an exception here would end the encoder thread for good
                    log.exception("frame output failed")
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
            try:
                self._start_encoder(name)
            except Exception:  # noqa: BLE001  one encoder failing must not stop the other
                log.exception("%s encoder failed to start", name)

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
        # Under the same lock as _reinit/_raw/_full_still so we never poke a camera that is being
        # closed and reopened (set_controls on a closed Picamera2 raises).
        async with self._lock:
            # keep the preview configuration current: picamera2 re-applies its `controls` whenever it
            # switches back after a still, so stale values here would undo this very change
            if self._video_config is not None:
                self._video_config["controls"] = self._libcamera_controls(self.controls)
            if self._picam is not None:
                await asyncio.to_thread(self._picam.set_controls, self._libcamera_controls(controls))

    def _restore_controls_sync(self) -> None:
        """Re-apply the persistent controls after a mode switch. `switch_mode_and_capture_*` returns to
        the preview configuration and re-applies the controls *that configuration* was created with;
        until 2026-09 those were the startup values, so every full-res or RAW still (focus stacks,
        photos) silently reverted a white balance or exposure the user had set since."""
        if self._picam is None:
            return
        try:
            self._picam.set_controls(self._libcamera_controls(self.controls))
        except Exception:  # noqa: BLE001
            log.exception("could not restore camera controls after the still")

    def _still_controls(self) -> dict:
        """Controls for a mode switch (full-res still, raw). Switching configuration restarts
        libcamera's AE/AWB from their defaults and the still is taken on the first frames, so under
        auto modes the picture would ignore the exposure and colour the live view had settled on.
        Freeze the live values from the latest frame metadata into manual controls instead. These
        apply to the still only: `_restore_controls_sync` puts the persistent controls back."""
        controls = dict(self.controls)
        with self._meta_lock:
            last = self._meta_ring[-1] if self._meta_ring else {}
        if controls.get("AeEnable") and last.get("exposure") and last.get("gain"):
            controls.update(AeEnable=False, ExposureTime=int(last["exposure"]) - 1, AnalogueGain=float(last["gain"]))
        if controls.get("AwbEnable") and len(last.get("colour_gains") or ()) == 2:
            controls.update(AwbEnable=False, ColourGains=[float(g) for g in last["colour_gains"]])
        return self._libcamera_controls(controls)

    def _require_camera(self):
        if self._picam is None:
            raise RuntimeError("camera is not running")
        return self._picam

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
        self._require_camera().capture_file(buf, "main", format="jpeg")
        return buf.getvalue()

    def _full_still_sync(self) -> bytes:
        picam = self._require_camera()
        still = picam.create_still_configuration(
            main={"size": tuple(self.cfg.full_size)}, controls=self._still_controls())
        self._stop_encoders()
        try:
            buf = io.BytesIO()
            picam.switch_mode_and_capture_file(still, buf, format="jpeg")
            return buf.getvalue()
        finally:
            self._restore_controls_sync()
            self._start_encoders()

    async def capture_raw(self) -> bytes:
        async with self._lock:
            return await asyncio.to_thread(self._raw_sync)

    def _raw_sync(self) -> bytes:
        import numpy as np
        w, h = self.cfg.full_size
        picam = self._require_camera()
        still = picam.create_still_configuration(
            main={"size": (w, h)}, raw={"format": self.cfg.raw_format, "size": (w, h)},
            controls=self._still_controls())
        self._stop_encoders()
        try:
            arr = picam.switch_mode_and_capture_array(still, "raw")
        finally:
            self._restore_controls_sync()
            self._start_encoders()
        raw16 = arr.view(np.uint16)[:h, :w] if arr.dtype == np.uint8 else arr[:h, :w]
        bayer = self.cfg.raw_format.replace("S", "").rstrip("0123456789P_") or "BGGR"
        return pack_raw(w, h, 10, self.cfg.black_level, bayer, np.ascontiguousarray(raw16, dtype="<u2").tobytes())

    async def capture_metadata(self) -> dict:
        if self._picam is None:
            return {}
        return await asyncio.to_thread(lambda: dict(self._picam.capture_metadata()))


def make_camera(cfg: CameraConfig, state_dir: Path, events: EventBus) -> CameraBase:
    if cfg.fake:
        from .fake_camera import FakeCamera
        return FakeCamera(cfg, state_dir, events)
    try:
        return PiCamera(cfg, state_dir, events)
    except ImportError as e:
        raise RuntimeError("picamera2 not available; set camera.fake = true for development") from e
