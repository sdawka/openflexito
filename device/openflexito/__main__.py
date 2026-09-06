"""Entry point: `python -m openflexito [--config PATH] [--fake] [--port N]`."""

from __future__ import annotations

import argparse
import asyncio
import logging
from pathlib import Path

from .app import Device
from .config import load_config


def main() -> None:
    ap = argparse.ArgumentParser(prog="openflexito")
    ap.add_argument("--config", type=Path, default=None, help="TOML config file")
    ap.add_argument("--fake", action="store_true", help="fake camera and stage (laptop development)")
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--host", default=None)
    ap.add_argument("--state-dir", type=Path, default=None)
    ap.add_argument("--webapp-dir", type=Path, default=None)
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    cfg = load_config(args.config)
    if args.fake:
        cfg.camera.fake = True
        cfg.stage.fake = True
        if args.state_dir is None:
            cfg.state_dir = Path.home() / ".openflexito"
        if args.port is None and cfg.port == 80:
            cfg.port = 8080
    if args.port is not None:
        cfg.port = args.port
    if args.host is not None:
        cfg.host = args.host
    if args.state_dir is not None:
        cfg.state_dir = args.state_dir
    if args.webapp_dir is not None:
        cfg.webapp_dir = args.webapp_dir

    from .logbuf import install as install_logging
    install_logging(logging.DEBUG if args.verbose else getattr(logging, cfg.log_level.upper(), logging.INFO))
    asyncio.run(Device(cfg).run())


if __name__ == "__main__":
    main()
