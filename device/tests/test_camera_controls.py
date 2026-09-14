"""PiCamera still path against a stub Picamera2 (picamera2 is not installed here).

Covers: persistent controls surviving a mode switch (picamera2 re-applies the controls the preview
configuration was *created* with), still-only ISP settings, explicit FrameDurationLimits, one mode
switch per multi-frame capture, bracket exposure sequencing, and the metadata ring flags."""
import asyncio
import io
import sys
import types
from pathlib import Path

import numpy as np
import pytest

from openflexito.config import CameraConfig
from openflexito.events import EventBus
from openflexito.rawfmt import decode_bracket, decode_raw


class StubRequest:
    def __init__(self, picam, metadata: dict):
        self.picam, self.metadata, self.released = picam, dict(metadata), False

    def get_metadata(self) -> dict:
        return dict(self.metadata)

    def make_image(self, name):
        from PIL import Image
        return Image.new("RGB", tuple(self.picam.config["main"]["size"]), (200, 100, 50))

    def make_array(self, name):
        w, h = self.picam.config["raw"]["size"]
        return np.full((h, w), 100 + self.metadata["ExposureTime"] // 100, dtype="<u2")

    def release(self):
        self.released = True


class StubPicam:
    """Mimics the part of Picamera2 the still path touches, including the switch-back re-apply."""
    def __init__(self, video_config: dict):
        self.video_config = video_config
        self.config = video_config
        self.applied: list[dict] = []
        self.controls = dict(video_config["controls"])
        self.options: dict = {}
        self.switches: list[dict] = []
        self.requests: list[StubRequest] = []
        self.ts = 1_000_000_000
        self.exposure_latency = 2  # frames until a new ExposureTime shows up in the metadata
        self._pending: list[int] = []

    def set_controls(self, c: dict) -> None:
        self.applied.append(dict(c))
        if "ExposureTime" in c and self.config is not self.video_config:
            self._pending = [self.controls.get("ExposureTime", 0)] * self.exposure_latency
        self.controls.update(c)

    def create_still_configuration(self, **kw) -> dict:
        return {"main": kw.get("main") or {"size": (2, 2)}, "raw": kw.get("raw"), "controls": kw.get("controls", {})}

    def switch_mode(self, config: dict) -> dict:
        self.switches.append(config)
        self.config = config
        self.controls = dict(config["controls"])  # configure() + start() apply the config's controls
        self._pending = []
        return config

    def capture_request(self) -> StubRequest:
        self.ts += 66_667_000
        exposure = self._pending.pop(0) if self._pending else self.controls.get("ExposureTime", 500)
        md = {"SensorTimestamp": self.ts, "ExposureTime": exposure, "AnalogueGain": self.controls.get("AnalogueGain", 1.0),
              "DigitalGain": 1.0, "ColourGains": tuple(self.controls.get("ColourGains", (1.0, 1.0))), "Lux": 123.0,
              "FocusFoM": 42, "FrameDuration": 66667, "ColourTemperature": 4800}
        req = StubRequest(self, md)
        self.requests.append(req)
        return req

    def capture_metadata(self) -> dict:
        return {"ExposureTime": self.controls.get("ExposureTime", 500)}


@pytest.fixture
def picam_camera(tmp_path: Path, monkeypatch):
    monkeypatch.setitem(sys.modules, "picamera2", types.SimpleNamespace(Picamera2=object))
    from openflexito.camera import PiCamera
    cam = PiCamera(CameraConfig(full_size=(8, 4), raw_main_size=(4, 2)), tmp_path, EventBus())
    cam._video_config = {"controls": cam._stream_controls()}   # as _open() builds it at startup
    cam._picam = StubPicam(cam._video_config)
    cam._start_encoders = lambda: None
    cam._stop_encoders = lambda: None
    return cam


async def test_manual_white_balance_survives_a_full_still(picam_camera):
    cam = picam_camera
    assert cam.controls["AwbEnable"] is True
    await cam.set_controls(AwbEnable=False, ColourGains=[1.8, 1.3])
    assert cam._picam.controls["ColourGains"] == (1.8, 1.3)
    await cam.snapshot(full=True)
    assert cam._picam.controls["AwbEnable"] is False
    assert cam._picam.controls["ColourGains"] == (1.8, 1.3), "the still switched back to stale startup controls"


async def test_manual_exposure_survives_a_raw_capture(picam_camera):
    cam = picam_camera
    await cam.set_controls(AeEnable=False, ExposureTime=20000, AnalogueGain=2.0)
    await cam.capture_raw()
    assert cam._picam.controls["AeEnable"] is False
    assert cam._picam.controls["ExposureTime"] == 20001 and cam._picam.controls["AnalogueGain"] == 2.0


async def test_auto_modes_are_restored_after_the_frozen_still(picam_camera):
    """Under auto AE/AWB the still freezes the live values; afterwards auto must be on again."""
    cam = picam_camera
    cam._meta_ring.append({"exposure": 5000, "gain": 1.5, "colour_gains": [2.0, 1.1]})
    await cam.snapshot(full=True)
    assert cam._picam.controls["AeEnable"] is True and cam._picam.controls["AwbEnable"] is True
    assert "ColourGains" not in cam._libcamera_controls(cam.controls)


async def test_still_returns_its_own_request_metadata(picam_camera):
    cam = picam_camera
    cam.main.meta = {"ts": 1, "exposure": 999}  # stale stream metadata must not leak into the still
    jpeg, meta = await cam.still()
    assert jpeg[:2] == b"\xff\xd8"
    assert meta["still"] is True and meta["matched"] is True
    assert meta["ts"] == cam._picam.requests[-1].metadata["SensorTimestamp"]
    assert meta["exposure"] == cam._picam.requests[-1].metadata["ExposureTime"] != 999
    assert meta["lux"] == 123.0 and meta["colour_temperature"] == 4800 and meta["frame_duration"] == 66667
    assert meta["colour_gains"] == [1.0, 1.0] and meta["size"] == len(jpeg) and (meta["width"], meta["height"]) == (8, 4)
    assert cam._picam.requests[-1].released


async def test_still_config_is_clean_and_has_no_raw_stream(picam_camera):
    cam = picam_camera
    await cam.still()
    still = cam._picam.switches[0]
    assert still["raw"] is None
    assert still["controls"]["NoiseReductionMode"] == 0 and still["controls"]["Sharpness"] == 0.0
    assert still["controls"]["FrameDurationLimits"] == (100, 1_000_000)
    assert cam._picam.switches[1] is cam._video_config, "must switch back to the stream configuration"
    await cam.set_still_clean(False)
    await cam.still()
    assert "NoiseReductionMode" not in cam._picam.switches[2]["controls"]
    assert cam.status()["still_clean"] is False


def test_stream_controls_pin_frame_duration_limits(picam_camera):
    assert picam_camera._stream_controls()["FrameDurationLimits"] == (33333, 500_000)


async def test_raw_frames_are_one_mode_switch_and_averaged(picam_camera):
    cam = picam_camera
    await cam.set_controls(AeEnable=False, ExposureTime=20000, AnalogueGain=1.0)
    cam._picam.switches.clear()
    data, trailer = await cam.capture_raw(frames=4)
    assert len(cam._picam.switches) == 2, "N frames must not mean N mode switches"
    assert cam._picam.switches[0]["main"]["size"] == (4, 2) and cam._picam.switches[0]["raw"]["size"] == (8, 4)
    header, pixels, t2 = decode_raw(data)
    assert header["bit_depth"] == 16 and header["black_level"] == 64 * 64 and t2["white_level"] == 1023 * 64
    assert trailer["frames"] == 4 and len(trailer["frame_timestamps"]) == 4 and trailer["ccm"] and len(trailer["ccm"]) == 9
    mosaic = np.frombuffer(pixels, dtype="<u2")
    assert mosaic[0] == (100 + 20001 // 100) * 64
    assert all(r.released for r in cam._picam.requests)


async def test_raw_rejects_bad_arguments(picam_camera):
    with pytest.raises(ValueError):
        await picam_camera.capture_raw(frames=9)
    with pytest.raises(ValueError):
        await picam_camera.capture_raw(frames=2, packed=True)


async def test_bracket_varies_only_exposure_and_waits_for_it(picam_camera):
    cam = picam_camera
    cam._meta_ring.append({"exposure": 10000, "gain": 1.5, "colour_gains": [2.0, 1.1]})  # AE/AWB live values
    data, summary = await cam.capture_bracket([0.5, 1, 2])
    items = decode_bracket(data)
    assert [m["factor"] for m, _ in items] == [0.5, 1, 2]
    assert [m["exposure"] for m, _ in items] == [5000, 10000, 20000], "each item carries the exposure it was shot at"
    assert all(m["gain"] == 1.5 and m["colour_gains"] == [2.0, 1.1] for m, _ in items)
    assert all(d[:2] == b"\xff\xd8" for _, d in items)
    assert len(cam._picam.switches) == 2
    assert summary["exposures"] == [5000, 10000, 20000] and summary["base_exposure"] == 10000 and summary["gain"] == 1.5
    still = cam._picam.switches[0]["controls"]
    assert still["AeEnable"] is False and still["AwbEnable"] is False
    assert cam._picam.controls["AeEnable"] is True, "auto exposure back on after the bracket"


async def test_raw_bracket_items_are_ofrw_records(picam_camera):
    cam = picam_camera
    await cam.set_controls(AeEnable=False, ExposureTime=10000)
    data, _ = await cam.capture_bracket([1, 2], raw=True)
    items = decode_bracket(data)
    for (meta, rec), want in zip(items, (10001, 20002)):  # manual 10000 runs as 10001 (the +1 convention)
        header, pixels, trailer = decode_raw(rec)
        assert header["bit_depth"] == 10 and trailer["exposure"] == meta["exposure"] == want
        assert meta["kind"] == "raw"


def test_meta_for_flags_unmatched_timestamps(picam_camera, caplog):
    cam = picam_camera
    cam._meta_ring.append({"ts": 5_000_000, "exposure": 1})
    cam._meta_ring.append({"ts": 6_000_000, "exposure": 2})
    assert cam._meta_for(5000)["matched"] is True and cam._meta_for(5000)["exposure"] == 1
    with caplog.at_level("WARNING"):
        m = cam._meta_for(7000)
        cam._meta_for(8000)
    assert m["matched"] is False and m["exposure"] == 2
    assert sum("not found in the metadata ring" in r.message for r in caplog.records) == 1


async def test_capture_metadata_runs_under_the_lock(picam_camera):
    cam = picam_camera
    async with cam._lock:
        task = asyncio.ensure_future(cam.capture_metadata())
        await asyncio.sleep(0.02)
        assert not task.done(), "capture_metadata must wait for the camera lock"
    assert (await task)["ExposureTime"] == 500
