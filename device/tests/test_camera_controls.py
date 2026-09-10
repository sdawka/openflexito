"""Persistent controls must survive a full-res / RAW still.

picamera2's switch_mode_and_capture_* returns to the preview configuration and re-applies the
controls that configuration was *created* with. With a stale configuration every still (photos,
focus stacks) reverted a white balance or exposure the user had set since startup."""
import asyncio
import io
import sys
import types
from pathlib import Path

import pytest

from openflexito.config import CameraConfig
from openflexito.events import EventBus


class StubPicam:
    """Mimics the part of Picamera2 the still path touches, including the switch-back re-apply."""
    def __init__(self, video_config: dict):
        self.video_config = video_config
        self.applied: list[dict] = []
        self.controls = dict(video_config["controls"])

    def set_controls(self, c: dict) -> None:
        self.applied.append(dict(c)); self.controls.update(c)

    def create_still_configuration(self, **kw) -> dict:
        return {"controls": kw.get("controls", {})}

    def _switch_back(self) -> None:
        # what picamera2 does after the still: configure(preview) → start with preview controls
        self.controls = dict(self.video_config["controls"])

    def switch_mode_and_capture_file(self, still, buf, format="jpeg"):
        self.controls.update(still["controls"]); buf.write(b"jpeg"); self._switch_back()

    def switch_mode_and_capture_array(self, still, name):
        import numpy as np
        self.controls.update(still["controls"]); self._switch_back()
        return np.zeros((2, 2), dtype="<u2")


@pytest.fixture
def picam_camera(tmp_path: Path, monkeypatch):
    monkeypatch.setitem(sys.modules, "picamera2", types.SimpleNamespace(Picamera2=object))
    from openflexito.camera import PiCamera
    cam = PiCamera(CameraConfig(full_size=(2, 2)), tmp_path, EventBus())
    cam._video_config = {"controls": cam._libcamera_controls(cam.controls)}   # as _open() builds it at startup
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
