"""The fake camera's lens shading: stills and the RAW (flat-field) path carry the same vignetting +
colour shading so a stitcher can be tested against a known, repeated per-tile pattern."""
import io

import numpy as np
import pytest
from PIL import Image

from openflexito.config import CameraConfig
from openflexito.events import EventBus
from openflexito.fake_camera import FakeCamera, shading

W, H = 160, 120


@pytest.fixture
def cam(tmp_path):
    cam = FakeCamera(CameraConfig(fake=True, stream_size=(2 * W, 2 * H), lores_size=(80, 60), full_size=(W, H)), tmp_path, EventBus())
    cam._specimen = Image.new("RGB", cam.SPECIMEN_SIZE, (200, 200, 200))  # blank field: only the shading remains
    return cam


def block_means(plane, nx=8, ny=6):
    h, w = plane.shape
    return plane[: h - h % ny, : w - w % nx].reshape(ny, h // ny, nx, w // nx).mean(axis=(1, 3))


def test_shading_model_has_dark_corners_and_opposite_colour_casts():
    r, g, b = shading(W, H)
    lum = (r + g + b) / 3
    centre = lum[H // 2 - 4:H // 2 + 4, W // 2 - 4:W // 2 + 4].mean()
    for corner in (lum[:8, :8], lum[:8, -8:], lum[-8:, :8], lum[-8:, -8:]):
        assert 0.55 < corner.mean() / centre < 0.78
    rb_tl = (r[:8, :8] / b[:8, :8]).mean()   # warm corner: more red than blue
    rb_br = (r[-8:, -8:] / b[-8:, -8:]).mean()  # magenta corner: blue catches up
    assert rb_tl > rb_br * 1.03
    assert lum[:, -4:].mean() > lum[:, :4].mean()  # horizontal gradient: brighter on the right
    assert shading(W, H) is shading(W, H)  # cached per size


def test_still_carries_the_shading(cam):
    img = np.asarray(Image.open(io.BytesIO(cam._still_jpeg())).convert("RGB"), dtype=np.float32) / 255
    lin = img ** 2.2
    mask = np.ones((H, W), bool)
    mask[:30] = False  # the overlay text sits in the top rows
    r, g, b = shading(W, H)
    for plane, expect in zip(np.moveaxis(lin, -1, 0), (r, g, b)):
        ratio = (plane / expect)[mask]
        assert ratio.std() / ratio.mean() < 0.02, "still does not follow the shading model"
    lum = lin.mean(axis=-1)
    centre = lum[H // 2 - 4:H // 2 + 4, W // 2 - 4:W // 2 + 4].mean()
    assert 0.55 < lum[-8:, :8].mean() / centre < 0.78 and 0.55 < lum[-8:, -8:].mean() / centre < 0.78
    # opposite corners differ in cast: warm top-left (the overlay text starts at (10, 10)) vs magenta bottom-right
    rb_tl, rb_br = (lin[:8, :8, 0] / lin[:8, :8, 2]).mean(), (lin[-8:, -8:, 0] / lin[-8:, -8:, 2]).mean()
    assert rb_tl - rb_br > 0.04


def test_flat_capture_matches_the_still(cam):
    """The RAW blank field (what `/flat.bin` averages) relative to its centre equals the still's
    shading per channel, so a measured flat field corrects the stills exactly."""
    mosaic = np.mean([cam._raw_mosaic().astype(np.float32) for _ in range(6)], axis=0) - cam.cfg.black_level
    planes = {"b": mosaic[0::2, 0::2], "g": mosaic[0::2, 1::2], "r": mosaic[1::2, 1::2]}
    r, g, b = shading(W, H)
    expect = {"b": b[0::2, 0::2], "g": g[0::2, 1::2], "r": r[1::2, 1::2]}
    for k in planes:
        got, exp = block_means(planes[k]), block_means(expect[k])
        got, exp = got / got[2:4, 3:5].mean(), exp / exp[2:4, 3:5].mean()  # normalise to the centre blocks
        assert np.abs(got - exp).max() < 0.03, k
