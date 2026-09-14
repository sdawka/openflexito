"""Configuration: defaults, overridden by a TOML file (/etc/openflexito/config.toml)."""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field, asdict
from pathlib import Path

DEFAULT_CONFIG_PATH = Path(os.environ.get("OPENFLEXITO_CONFIG", "/etc/openflexito/config.toml"))


@dataclass
class CameraConfig:
    enabled: bool = True
    fake: bool = False
    # Full 3280x2464 readout downscaled by the ISP to an 820x616 preview, as OpenFlexure v3 does:
    # the 4x4 averaging halves per-pixel flicker versus the binned 1640x1232 mode and the small
    # frame leaves room for a high JPEG quality (100 Mbit/s cap ~ 100 KB frames at ~18 fps) while
    # cutting the Pi 3's CPU load by two thirds. 1640x1232 remains selectable in Settings.
    sensor_size: tuple[int, int] = (3280, 2464)
    stream_size: tuple[int, int] = (820, 616)
    lores_size: tuple[int, int] = (410, 308)
    bitrate: int = 100_000_000
    lores_bitrate: int = 4_000_000
    full_size: tuple[int, int] = (3280, 2464)
    raw_format: str = "SBGGR10"
    black_level: int = 64
    tuning_name: str = "imx219"
    # Stills (full-res JPEG, RAW, brackets, flats) are taken in their own mode switch. `still_clean`
    # turns the ISP's spatial denoise and sharpening off for them: those inflate Laplacian focus
    # metrics and add halos to every stack input; the browser does its own processing. Toggle at
    # run time with `camera.set_still_clean`. Software JPEG quality for stills is pinned.
    still_clean: bool = True
    still_jpeg_quality: int = 95
    # picamera2's video configuration pins FrameDurationLimits to 33333 us, which clamps exposure
    # at one (fps-limited) frame; explicit limits let long low-gain exposures through on dim
    # samples. Stream: 30 fps ceiling down to 2 fps; stills: 100 us to 1 s.
    stream_frame_duration_us: tuple[int, int] = (33333, 500_000)
    still_frame_duration_us: tuple[int, int] = (100, 1_000_000)
    # Main-stream size of the RAW still configuration (the ISP output is not read; keep it tiny).
    raw_main_size: tuple[int, int] = (640, 480)
    # Upper bound for `/raw.bin?frames=N` (each frame is a 16 MB uint16 mosaic on the Pi 3).
    max_raw_frames: int = 8
    max_bracket_frames: int = 8


@dataclass
class StageConfig:
    enabled: bool = True
    fake: bool = False
    port: str | None = None          # None = autodetect
    baud: int = 115200
    backlash: dict[str, int] = field(default_factory=lambda: {"x": 200, "y": 200, "z": 200})
    inverted: dict[str, bool] = field(default_factory=lambda: {"x": True, "y": False, "z": True})
    poll_interval: float = 0.05
    # De-energise the coils this many seconds after a move settles (0 = never). The Sangaboard
    # firmware otherwise holds two coils per motor energised for ever, which keeps the 28BYJ-48
    # motors hot; the geared lead-screw actuators hold position without current.
    release_after: float = 2.0


@dataclass
class Config:
    host: str | None = None  # None = all interfaces, IPv4 and IPv6 (clients resolving microscope.local get AAAA first)
    port: int = 80
    state_dir: Path = Path("/var/lib/openflexito")
    webapp_dir: Path | None = Path("/opt/openflexito/webapp")
    led_path: Path = Path("/sys/class/leds/ACT")
    hotspot_connection: str = "openflexito-hotspot"
    log_level: str = "INFO"
    camera: CameraConfig = field(default_factory=CameraConfig)
    stage: StageConfig = field(default_factory=StageConfig)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["state_dir"] = str(self.state_dir)
        d["webapp_dir"] = str(self.webapp_dir) if self.webapp_dir else None
        d["led_path"] = str(self.led_path)
        return d


def _merge(dc, data: dict):
    for key, value in data.items():
        if not hasattr(dc, key):
            raise KeyError(f"unknown config key: {key}")
        current = getattr(dc, key)
        if hasattr(current, "__dataclass_fields__") and isinstance(value, dict):
            _merge(current, value)
        elif isinstance(current, Path) or (current is None and key.endswith("_dir")):
            setattr(dc, key, Path(value) if value is not None else None)
        elif isinstance(current, tuple):
            setattr(dc, key, tuple(value))
        else:
            setattr(dc, key, value)


def load_config(path: Path | None = None) -> Config:
    cfg = Config()
    path = path or DEFAULT_CONFIG_PATH
    if path.is_file():
        with path.open("rb") as f:
            _merge(cfg, tomllib.load(f))
    if cfg.host in ("", "*", "::", "0.0.0.0"):
        cfg.host = None  # bind every interface on both IP families
    return cfg
