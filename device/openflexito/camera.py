"""Camera: picamera2 + hardware MJPEG encoder with a frame fan-out, plus a fake for dev.

The device does no image processing. It exposes:
  * the latest JPEG frame (for MJPEG streaming) with per-frame metadata,
  * a full-resolution still with the still's own request metadata,
  * unprocessed raw Bayer captures (single, multi-frame averaged, flat-field, packed) as OFRW v2
    records with a JSON trailer, and exposure brackets as OFBK containers (formats: rawfmt.py),
  * libcamera controls and the tuning file (read/write).

Stills, raws and brackets are each ONE mode switch: encoders stop, `switch_mode(still_config)`,
N `capture_request()`s, `switch_mode(video_config)`, controls restored, encoders restart.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import threading
from collections import deque
from importlib import resources
from pathlib import Path
from typing import Any

from .clock import now_ns
from .config import CameraConfig
from .events import EventBus
from .rawfmt import (RAW_HEADER, RAW_MAGIC, MosaicAccumulator, encode_bracket, encode_raw,  # noqa: F401  re-exported
                     frame_meta, json_safe, pack_raw)

log = logging.getLogger(__name__)

PERSISTENT_CONTROL_KEYS = ("ExposureTime", "AnalogueGain", "ColourGains", "Brightness",
                           "Contrast", "Saturation", "Sharpness", "AeEnable", "AwbEnable")
# Until the browser-side calibration fixes exposure and colour, an uncalibrated camera runs
# with auto exposure and auto white balance so the first picture is usable rather than green.
DEFAULT_CONTROLS: dict[str, Any] = {
    "AeEnable": True, "AwbEnable": True, "ExposureTime": 500, "AnalogueGain": 1.0,
    "ColourGains": [1.0, 1.0], "Brightness": 0.0, "Contrast": 1.0, "Saturation": 1.0, "Sharpness": 1.0,
}
MIN_EXPOSURE_US = 20  # IMX219 floor is ~60 us; libcamera clamps, this only guards the arithmetic


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
        self.still_clean = bool(cfg.still_clean)
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
            if "still_clean" in data:
                self.still_clean = bool(data["still_clean"])
        except (OSError, ValueError):
            pass

    def _save_controls(self) -> None:
        try:
            self.state_dir.mkdir(parents=True, exist_ok=True)
            self.controls_file.write_text(json.dumps({"controls": self.controls, "stream_size": list(self.stream_size),
                                                      "still_clean": self.still_clean}))
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
            "still_clean": self.still_clean, "still_jpeg_quality": self.cfg.still_jpeg_quality,
            "frame_duration_limits_us": {"stream": list(self.cfg.stream_frame_duration_us),
                                         "still": list(self.cfg.still_frame_duration_us)},
            "max_raw_frames": self.cfg.max_raw_frames, "max_bracket_frames": self.cfg.max_bracket_frames,
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

    async def set_still_clean(self, enabled: bool = True) -> dict:
        """Stills only: ISP denoise off and Sharpness 0 when enabled (the browser does its own
        processing); when disabled stills get the same ISP treatment as the live stream."""
        self.still_clean = bool(enabled)
        self._save_controls()
        return {"still_clean": self.still_clean}

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

    # ---- helpers shared by real and fake ---------------------------------------------------

    @property
    def bayer(self) -> str:
        return self.cfg.raw_format.replace("S", "").rstrip("0123456789P_") or "BGGR"

    def _check_raw_args(self, frames: int, packed: bool) -> int:
        frames = int(frames)
        if not 1 <= frames <= self.cfg.max_raw_frames:
            raise ValueError(f"frames must be 1..{self.cfg.max_raw_frames}")
        if packed and frames > 1:
            raise ValueError("packed raw is only available for a single frame")
        if packed and self.cfg.full_size[0] % 4:
            raise ValueError("packed raw needs a width that is a multiple of 4")
        return frames

    def _check_bracket_args(self, factors: list[float]) -> list[float]:
        factors = [float(f) for f in factors]
        if not 1 <= len(factors) <= self.cfg.max_bracket_frames:
            raise ValueError(f"1..{self.cfg.max_bracket_frames} exposure factors")
        if any(not 0.01 <= f <= 100 for f in factors):
            raise ValueError("exposure factors must be within 0.01..100")
        return factors

    def _encode_raw(self, arrays, metas: list[dict], packed: bool, flat: bool) -> tuple[bytes, dict]:
        """`arrays`: list of mosaics or a MosaicAccumulator (one metadata dict per frame)."""
        return encode_raw(arrays, metas, bayer=self.bayer, black_level=self.cfg.black_level, bit_depth=10,
                          packed=packed, flat=flat, tuning=self.tuning)

    # ---- to implement ----------------------------------------------------------------------

    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    async def _apply_controls(self, controls: dict) -> None: ...
    async def _reinit(self) -> None: ...
    def set_active(self, active: bool) -> None:
        """Called by the app when the number of stream + WebSocket clients crosses zero.
        Encoders only run while someone is connected (they cost ~30% of a Pi 3 core)."""
        self.active = active

    async def snapshot(self, full: bool = False) -> bytes:
        """Latest stream frame, or (full=True) a full-resolution still without its metadata."""
        if full:
            return (await self.still())[0]
        return self.main.jpeg

    async def still(self) -> tuple[bytes, dict]:
        """Full-resolution JPEG still plus the still's own request metadata (X-Frame shape)."""
        ...

    async def capture_raw(self, frames: int = 1, packed: bool = False, flat: bool = False) -> tuple[bytes, dict]:
        """OFRW v2 record of `frames` raw mosaics averaged (one mode switch) plus its trailer dict."""
        ...

    async def capture_bracket(self, factors: list[float], raw: bool = False) -> tuple[bytes, dict]:
        """OFBK container: one still per exposure factor (x current exposure), gain and colour gains
        locked, one mode switch. Returns (bytes, summary)."""
        ...

    async def capture_metadata(self) -> dict: return dict(self.main.meta)


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
        self._warned_unmatched = False

    def _open(self):
        from picamera2 import Picamera2
        from libcamera import controls as lc  # noqa: F401
        tuning = self.tuning or None
        self._picam = Picamera2(tuning=tuning) if tuning else Picamera2()
        self._picam.options["quality"] = int(self.cfg.still_jpeg_quality)  # capture_file path (idle snapshot)
        props = self._picam.camera_properties
        self.sensor = {"model": props.get("Model"), "pixel_array_size": list(props.get("PixelArraySize", ())),
                       "modes": [{"size": list(m["size"]), "bit_depth": m["bit_depth"], "fps": m.get("fps")}
                                 for m in self._picam.sensor_modes]}
        self._video_config = self._picam.create_video_configuration(
            main={"size": self.stream_size, "format": "YUV420"},
            lores={"size": tuple(self.cfg.lores_size), "format": "YUV420"},
            raw=None,  # no raw stream while streaming: saves a per-frame DMA sync of a 4 MB buffer on the Pi 3
            sensor={"output_size": tuple(self.cfg.sensor_size), "bit_depth": 10},
            controls=self._stream_controls(),
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

    def _stream_controls(self) -> dict:
        """Video-configuration controls: the persistent controls plus explicit FrameDurationLimits.
        picamera2's default for video configurations is (33333, 33333), which caps ExposureTime at
        one frame; the configured range lets AE (or the user) go long on dim samples."""
        out = self._libcamera_controls(self.controls)
        out["FrameDurationLimits"] = tuple(int(x) for x in self.cfg.stream_frame_duration_us)
        return out

    def _on_request(self, request) -> None:
        # Runs on picamera2's event thread for every completed request: an exception here would
        # take that thread down and stop the camera silently, so it must never escape.
        try:
            md = request.get_metadata()
            entry = frame_meta(md)
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
                    return {**m, "matched": True}
        # No entry for this encoder timestamp: report the newest metadata but say so, rather than
        # letting the browser trust a `ts` that belongs to a neighbouring frame.
        if not self._warned_unmatched:
            self._warned_unmatched = True
            log.warning("encoder frame timestamp %s not found in the metadata ring (%d entries); "
                        "frame metadata flagged matched=false from now on when this happens",
                        timestamp_us, len(ring))
        return {**(ring[-1] if ring else {"t": now_ns()}), "matched": False}

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
                self._video_config["controls"] = self._stream_controls()
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

    # ---- still mode ------------------------------------------------------------------------

    def _frozen_controls(self) -> dict:
        """Our-style controls for a mode switch (full-res still, raw). Switching configuration restarts
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
        return controls

    @staticmethod
    def _noise_reduction_off():
        try:
            from libcamera import controls as lc
            return lc.draft.NoiseReductionModeEnum.Off
        except Exception:  # noqa: BLE001  no libcamera (tests): the enum's integer value
            return 0

    def _still_controls(self, frozen: dict | None = None) -> dict:
        """libcamera controls for a still configuration: frozen AE/AWB values, explicit
        FrameDurationLimits (picamera2's still default already allows long exposures; pinned so it
        stays true), and with `still_clean` the ISP denoise off and Sharpness 0 (the stream keeps
        the tuning's `rpi.sdn`/`rpi.sharpen`; stills feed browser-side stacking and metrics)."""
        out = self._libcamera_controls(frozen if frozen is not None else self._frozen_controls())
        out["FrameDurationLimits"] = tuple(int(x) for x in self.cfg.still_frame_duration_us)
        if self.still_clean:
            out["NoiseReductionMode"] = self._noise_reduction_off()
            out["Sharpness"] = 0.0
        return out

    def _require_camera(self):
        if self._picam is None:
            raise RuntimeError("camera is not running")
        return self._picam

    def _in_still_mode(self, still_config, fn):
        """Run fn(picam) with the camera switched to `still_config`, encoders stopped; switch back to
        the video configuration, restore controls and restart encoders afterwards (one mode switch
        for however many requests fn captures)."""
        picam = self._require_camera()
        self._stop_encoders()
        try:
            picam.switch_mode(still_config)
            return fn(picam)
        finally:
            try:
                picam.switch_mode(self._video_config)
            except Exception:  # noqa: BLE001
                log.exception("could not switch back to the stream configuration")
            self._restore_controls_sync()
            self._start_encoders()

    @staticmethod
    def _take_request(picam, want_exposure: int | None = None, max_tries: int = 8):
        """Capture one request; when `want_exposure` is set, drop frames until the request's own
        ExposureTime is within 5 % (libcamera applies a control change 2-3 frames later)."""
        for i in range(max_tries):
            req = picam.capture_request()
            md = req.get_metadata()
            if want_exposure is None or abs(int(md.get("ExposureTime") or 0) - want_exposure) <= max(want_exposure * 0.05, 50) \
                    or i == max_tries - 1:
                return req, md
            req.release()
        raise RuntimeError("unreachable")

    def _jpeg_from_request(self, req) -> bytes:
        buf = io.BytesIO()
        req.make_image("main").save(buf, "JPEG", quality=int(self.cfg.still_jpeg_quality))
        return buf.getvalue()

    async def snapshot(self, full: bool = False) -> bytes:
        if full:
            return (await self.still())[0]
        fresh = self.main.jpeg and now_ns() - int(self.main.meta.get("t") or 0) < 1_000_000_000
        if "main" in self._encoders and fresh:
            return self.main.jpeg
        async with self._lock:  # encoder idle (no clients): software JPEG of the current frame
            return await asyncio.to_thread(self._jpeg_sync)

    def _jpeg_sync(self) -> bytes:
        buf = io.BytesIO()
        self._require_camera().capture_file(buf, "main", format="jpeg")
        return buf.getvalue()

    async def still(self) -> tuple[bytes, dict]:
        async with self._lock:
            return await asyncio.to_thread(self._still_sync)

    def _still_sync(self) -> tuple[bytes, dict]:
        picam = self._require_camera()
        w, h = self.cfg.full_size
        # JPEG still: main only (no raw stream: it would allocate 16 MB buffers nobody reads)
        still = picam.create_still_configuration(main={"size": (w, h)}, raw=None, controls=self._still_controls())

        def capture(picam):
            req, md = self._take_request(picam)
            try:
                return self._jpeg_from_request(req), md
            finally:
                req.release()
        jpeg, md = self._in_still_mode(still, capture)
        meta = frame_meta(md, still=True, matched=True, width=w, height=h, size=len(jpeg))
        return jpeg, meta

    async def capture_raw(self, frames: int = 1, packed: bool = False, flat: bool = False) -> tuple[bytes, dict]:
        frames = self._check_raw_args(frames, packed)
        async with self._lock:
            return await asyncio.to_thread(self._raw_sync, frames, packed, flat)

    def _raw_config(self, picam, controls: dict):
        w, h = self.cfg.full_size
        return picam.create_still_configuration(
            main={"size": tuple(self.cfg.raw_main_size)}, raw={"format": self.cfg.raw_format, "size": (w, h)},
            controls=controls)

    @staticmethod
    def _raw_array(req, w: int, h: int):
        import numpy as np
        arr = req.make_array("raw")
        return arr.view(np.uint16)[:h, :w] if arr.dtype == np.uint8 else arr[:h, :w]

    def _raw_sync(self, frames: int, packed: bool, flat: bool) -> tuple[bytes, dict]:
        picam = self._require_camera()
        w, h = self.cfg.full_size
        still = self._raw_config(picam, self._still_controls())

        def capture(picam):
            acc, metas = MosaicAccumulator(10), []
            for _ in range(frames):
                req, md = self._take_request(picam)
                try:
                    acc.add(self._raw_array(req, w, h))  # summed before the buffer goes back: one 16 MB copy live
                finally:
                    req.release()
                metas.append(frame_meta(md))
            return acc, metas
        acc, metas = self._in_still_mode(still, capture)
        return self._encode_raw(acc, metas, packed, flat)

    async def capture_bracket(self, factors: list[float], raw: bool = False) -> tuple[bytes, dict]:
        factors = self._check_bracket_args(factors)
        async with self._lock:
            return await asyncio.to_thread(self._bracket_sync, factors, raw)

    def _bracket_sync(self, factors: list[float], raw: bool) -> tuple[bytes, dict]:
        picam = self._require_camera()
        w, h = self.cfg.full_size
        frozen = self._frozen_controls()
        frozen["AeEnable"] = False  # gain and colour gains stay at the frozen values; only exposure varies
        frozen["AwbEnable"] = False
        # `base` is the exposure libcamera actually runs (our controls store it minus one, see
        # _libcamera_controls); the per-item targets are in the same actual microseconds.
        base = int(frozen.get("ExposureTime") or DEFAULT_CONTROLS["ExposureTime"]) + 1
        lo, hi = MIN_EXPOSURE_US, int(self.cfg.still_frame_duration_us[1])
        exposures = [max(lo, min(hi, int(round(base * f)))) for f in factors]
        first = dict(frozen, ExposureTime=exposures[0] - 1)
        controls = self._still_controls(first)
        still = (self._raw_config(picam, controls) if raw else
                 picam.create_still_configuration(main={"size": (w, h)}, raw=None, controls=controls))

        def capture(picam):
            items = []
            for i, (f, exp) in enumerate(zip(factors, exposures)):
                if i > 0:
                    picam.set_controls({"ExposureTime": exp})
                req, md = self._take_request(picam, want_exposure=exp)
                try:
                    if raw:
                        data, trailer = self._encode_raw([self._raw_array(req, w, h).copy()], [frame_meta(md)], False, False)
                        meta = frame_meta(md, still=True, matched=True, width=w, height=h, size=len(data),
                                          factor=f, index=i, kind="raw", requested_exposure=exp)
                    else:
                        data = self._jpeg_from_request(req)
                        meta = frame_meta(md, still=True, matched=True, width=w, height=h, size=len(data),
                                          factor=f, index=i, kind="jpeg", requested_exposure=exp)
                finally:
                    req.release()
                items.append((meta, data))
            return items
        items = self._in_still_mode(still, capture)
        summary = {"count": len(items), "factors": factors, "base_exposure": base, "exposures": exposures,
                   "gain": frozen.get("AnalogueGain"), "colour_gains": frozen.get("ColourGains"), "raw": raw,
                   "frames": [m for m, _ in items]}
        return encode_bracket(items), summary

    async def capture_metadata(self) -> dict:
        async with self._lock:  # never poke a camera that _reinit is closing and reopening
            if self._picam is None:
                return {}
            return await asyncio.to_thread(lambda: json_safe(dict(self._picam.capture_metadata())))


def make_camera(cfg: CameraConfig, state_dir: Path, events: EventBus) -> CameraBase:
    if cfg.fake:
        from .fake_camera import FakeCamera
        return FakeCamera(cfg, state_dir, events)
    try:
        return PiCamera(cfg, state_dir, events)
    except ImportError as e:
        raise RuntimeError("picamera2 not available; set camera.fake = true for development") from e
