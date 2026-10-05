"""FocusFoM in the per-frame metadata (real path via frame_meta, fake via a rendered-frame stand-in)
and the fake's tilted focal plane (OPENFLEXITO_FAKE_TILT)."""
import time

import pytest

from openflexito.config import CameraConfig
from openflexito.events import EventBus
from openflexito.fake_camera import FakeCamera
from openflexito.rawfmt import frame_meta


def make(tmp_path, monkeypatch, tilt=None):
    if tilt is not None:
        monkeypatch.setenv("OPENFLEXITO_FAKE_TILT", tilt)
    return FakeCamera(CameraConfig(fake=True, stream_size=(820, 616), lores_size=(80, 60), full_size=(64, 48)),
                      tmp_path, EventBus())


def fom_at(cam, x=0, y=0, z=0):
    return cam.focus_fom(cam._render({"x": x, "y": y, "z": z}))


def test_frame_meta_carries_focus_fom_and_tolerates_missing():
    assert frame_meta({"FocusFoM": 1234})["focus_fom"] == 1234
    assert frame_meta({})["focus_fom"] is None


def test_fake_fom_peaks_at_zero_and_falls_with_defocus(tmp_path, monkeypatch):
    cam = make(tmp_path, monkeypatch)
    zs = [0, 20, 60, 100, 200, 300, 600]
    foms = [fom_at(cam, z=z) for z in zs]
    assert all(isinstance(f, int) for f in foms)
    # |z| < ~30 steps blurs by less than PIL's smallest kernel, so the peak is a flat top there
    assert all(a >= b for a, b in zip(foms, foms[1:])) and all(a > b for a, b in zip(foms[1:], foms[2:])), foms
    assert foms[0] > 1.5 * foms[-2]
    assert fom_at(cam, z=-100) == pytest.approx(fom_at(cam, z=100), rel=0.02)
    assert fom_at(cam, z=0) == fom_at(cam, z=0)  # deterministic


def test_fake_fom_is_cheap(tmp_path, monkeypatch):
    cam = make(tmp_path, monkeypatch)
    img = cam._render({"x": 0, "y": 0, "z": 0})
    t = time.perf_counter()
    for _ in range(20):
        cam.focus_fom(img)
    assert (time.perf_counter() - t) / 20 < 0.003


def test_tilt_moves_the_peak(tmp_path, monkeypatch):
    cam = make(tmp_path, monkeypatch, tilt="0.1,-0.05")
    assert cam.tilt == (0.1, -0.05)
    # at x=1000, y=400 the focal plane sits at z = 100 - 20 = 80
    assert cam.z_focus({"x": 1000, "y": 400}) == pytest.approx(80)
    zs = [0, 40, 80, 120, 160]
    foms = [fom_at(cam, 1000, 400, z) for z in zs]
    assert foms.index(max(foms)) == zs.index(80), foms


def test_bad_tilt_falls_back_to_flat(tmp_path, monkeypatch):
    assert make(tmp_path, monkeypatch, tilt="nonsense").tilt == (0.0, 0.0)


async def test_stream_frames_carry_fom(tmp_path, monkeypatch):
    import asyncio
    cam = make(tmp_path, monkeypatch)
    cam.bind(asyncio.get_running_loop())
    await cam.start()
    try:
        for _ in range(100):
            if cam.main.seq >= 2:
                break
            await asyncio.sleep(0.05)
        assert isinstance(cam.main.meta["focus_fom"], int)
        jpeg, meta = await cam.still()
        assert isinstance(meta["focus_fom"], int)
    finally:
        await cam.stop()
