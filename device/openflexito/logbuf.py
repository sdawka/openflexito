"""Crash and debug logging on the device.

Two stores, both readable over RPC (`system.logs`) and clearable (`system.clear_logs`):

* the systemd journal, made persistent and size-capped by the image
  (``/etc/systemd/journald.conf.d/openflexito.conf``); it captures everything the service
  prints, including tracebacks from threads that die, across restarts and reboots;
* an in-process ring of the last records (structured, cheap, works in ``--fake`` mode too).

Uncaught exceptions in threads, the asyncio loop and the main thread are routed through
``logging`` so they land in both.
"""
from __future__ import annotations

import asyncio
import collections
import logging
import subprocess
import sys
import threading
import traceback
from typing import Any

log = logging.getLogger(__name__)

LEVELS = {"DEBUG": 7, "INFO": 6, "WARNING": 4, "ERROR": 3, "CRITICAL": 2}  # name -> journal priority


class RingLogHandler(logging.Handler):
    """Keeps the last `capacity` records in memory."""

    def __init__(self, capacity: int = 2000):
        super().__init__(level=logging.DEBUG)
        self.records: collections.deque = collections.deque(maxlen=capacity)
        self._lock = threading.Lock()
        self._seq = 0

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = record.getMessage()
            if record.exc_info:
                msg += "\n" + "".join(traceback.format_exception(*record.exc_info)).rstrip()
            with self._lock:
                self._seq += 1
                self.records.append({"id": self._seq, "t": record.created, "level": record.levelname,
                                     "logger": record.name, "msg": msg})
        except Exception:  # noqa: BLE001  never let logging break the caller
            pass

    def tail(self, lines: int = 200, level: str = "DEBUG", since_id: int | None = None) -> list[dict]:
        minimum = logging.getLevelName(level.upper()) if isinstance(level, str) else level
        minimum = minimum if isinstance(minimum, int) else logging.DEBUG
        with self._lock:
            out = [r for r in self.records if logging.getLevelName(r["level"]) >= minimum
                   and (since_id is None or r["id"] > since_id)]
        return out[-lines:]

    def clear(self) -> None:
        with self._lock:
            self.records.clear()


ring = RingLogHandler()


def install(level: int = logging.INFO) -> None:
    """Configure root logging (stderr -> journal) plus the ring, and route crashes through it."""
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger().addHandler(ring)

    def thread_hook(args: threading.ExceptHookArgs) -> None:
        log.critical("uncaught exception in thread %s", args.thread.name if args.thread else "?",
                     exc_info=(args.exc_type, args.exc_value, args.exc_traceback))
    threading.excepthook = thread_hook

    def sys_hook(exc_type, exc, tb) -> None:
        log.critical("uncaught exception", exc_info=(exc_type, exc, tb))
    sys.excepthook = sys_hook


def install_loop_hook(loop: asyncio.AbstractEventLoop) -> None:
    def handler(_loop, context: dict[str, Any]) -> None:
        exc = context.get("exception")
        if exc is not None:
            log.error("asyncio: %s", context.get("message", ""), exc_info=(type(exc), exc, exc.__traceback__))
        else:
            log.error("asyncio: %s", context.get("message", ""))
    loop.set_exception_handler(handler)


# ---- journal access ---------------------------------------------------------------------------

JOURNAL_UNIT = "openflexito.service"


def journal_tail(lines: int = 200, level: str = "DEBUG", boot: bool = False) -> list[str]:
    """Last `lines` of this service's journal at `level` and above (needs the systemd-journal group)."""
    prio = LEVELS.get(level.upper(), 7)
    cmd = ["journalctl", "-u", JOURNAL_UNIT, "-o", "short-iso", "--no-pager", "-n", str(int(lines)), "-p", str(prio)]
    if boot:
        cmd.append("-b")
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as e:
        return [f"(journal unavailable: {e})"]
    if out.returncode != 0:
        return [f"(journal unavailable: {out.stderr.strip() or out.returncode})"]
    return out.stdout.splitlines()


def journal_usage() -> str:
    try:
        out = subprocess.run(["journalctl", "--disk-usage"], capture_output=True, text=True, timeout=10)
        return out.stdout.strip() or out.stderr.strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return f"unknown ({e})"


def journal_clear(state_dir) -> str:
    """Ask the root-side maintenance unit to rotate and vacuum the journal (see request())."""
    return request(state_dir, "clear-logs", wait=15.0)


def request(state_dir, name: str, wait: float = 0.0) -> str:
    """Privileged actions from the hardened service: drop `<name>.request` in the state dir; the
    `openflexito-maint.path` unit runs `openflexito-maint` as root and removes the file (writing
    `<name>.request.result` for actions that report back)."""
    import time
    from pathlib import Path
    d = Path(state_dir) / "requests"
    d.mkdir(parents=True, exist_ok=True)
    req, res = d / f"{name}.request", d / f"{name}.request.result"
    res.unlink(missing_ok=True)
    req.write_text(str(time.time()))
    deadline = time.monotonic() + wait
    while wait and time.monotonic() < deadline:
        if res.exists():
            text = res.read_text().strip()
            res.unlink(missing_ok=True)
            return text or "done"
        if not req.exists():
            return "done"
        time.sleep(0.2)
    return "requested" if not wait else "no response from openflexito-maint (is the path unit enabled?)"
