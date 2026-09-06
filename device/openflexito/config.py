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
    sensor_size: tuple[int, int] = (1640, 1232)   # IMX219 2x2 binned: full field of view
    stream_size: tuple[int, int] = (1640, 1232)
    lores_size: tuple[int, int] = (410, 308)
    bitrate: int = 25_000_000
    lores_bitrate: int = 4_000_000
    full_size: tuple[int, int] = (3280, 2464)
    raw_format: str = "SBGGR10"
    black_level: int = 64
    tuning_name: str = "imx219"


@dataclass
class StageConfig:
    enabled: bool = True
    fake: bool = False
    port: str | None = None          # None = autodetect
    baud: int = 115200
    backlash: dict[str, int] = field(default_factory=lambda: {"x": 200, "y": 200, "z": 200})
    inverted: dict[str, bool] = field(default_factory=lambda: {"x": True, "y": False, "z": True})
    poll_interval: float = 0.05


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
