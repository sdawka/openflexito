"""Device-side store for browser-computed calibrations.

The maths behind every calibration (camera-stage mapping, focus backlash/lag, blank-field flat
fields, scan-derived shading, manual pixel scale) runs in the webapp, but the *results* describe this
microscope, not a browser: they live here in `calibration.json` so every client that connects sees the
same state and a recalibration on one tablet reaches the laptop next to it. The device never
interprets the values; it stores JSON objects by key, stamps them with `when`, and tells connected
clients (`event.calibration`) that a key changed. Not power-guarded: nothing here touches hardware.
"""
from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .events import EventBus

log = logging.getLogger(__name__)

KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
MAX_VALUE_BYTES = 2 * 1024 * 1024   # a 64×48×3 flat field is ~70 kB; leave room for finer maps


class CalibrationStore:
    def __init__(self, state_dir: Path, events: EventBus | None = None) -> None:
        self.state_dir = state_dir
        self.events = events
        self._data: dict[str, dict[str, Any]] = {}
        self._load()

    # ---- persistence --------------------------------------------------------------------------

    @property
    def _file(self) -> Path:
        return self.state_dir / "calibration.json"

    def _load(self) -> None:
        try:
            d = json.loads(self._file.read_text())
            self._data = {k: v for k, v in d.items() if KEY_RE.match(k) and isinstance(v, dict)}
        except (OSError, ValueError, AttributeError):
            self._data = {}

    def _save(self) -> None:
        try:
            self.state_dir.mkdir(parents=True, exist_ok=True)
            tmp = self._file.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(self._data, separators=(",", ":")))
            os.replace(tmp, self._file)   # never leave a half-written file behind
        except OSError as e:
            log.warning("could not save calibration: %s", e)

    def _publish(self, key: str, when: str | None) -> None:
        if self.events is not None:
            self.events.publish("calibration", {"key": key, "when": when})

    # ---- RPC surface --------------------------------------------------------------------------

    def summary(self) -> dict[str, str | None]:
        """{key: when} for every stored calibration (what `system.status` carries)."""
        return {k: v.get("when") for k, v in self._data.items()}

    async def get(self, key: str | None = None) -> dict:
        """All stored calibrations ({key: value}) or, with `key`, {"key", "value"} where value is
        null when nothing is stored under it."""
        if key is None:
            return dict(self._data)
        self._check_key(key)
        return {"key": key, "value": self._data.get(key)}

    async def set(self, key: str, value: dict | None = None) -> dict:
        """Store `value` (a JSON object; `when` is added as an ISO timestamp if missing) under `key`,
        or delete the key when value is null. Returns {"key", "when"}."""
        self._check_key(key)
        if value is None:
            self._data.pop(key, None)
            self._save()
            self._publish(key, None)
            return {"key": key, "when": None}
        if not isinstance(value, dict):
            raise ValueError("value must be a JSON object or null")
        v = dict(value)
        when = v.get("when")
        if not isinstance(when, str) or not when:
            when = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
            v["when"] = when
        if len(json.dumps(v, separators=(",", ":"))) > MAX_VALUE_BYTES:
            raise ValueError(f"calibration {key!r} exceeds {MAX_VALUE_BYTES} bytes")
        self._data[key] = v
        self._save()
        self._publish(key, when)
        return {"key": key, "when": when}

    async def clear(self) -> dict:
        """Forget every stored calibration (the e2e runs this against the fake before each suite)."""
        keys = list(self._data)
        self._data = {}
        self._save()
        for k in keys:
            self._publish(k, None)
        return {"cleared": keys}

    @staticmethod
    def _check_key(key: str) -> None:
        if not isinstance(key, str) or not KEY_RE.match(key):
            raise ValueError("key must match ^[a-z][a-z0-9_]{0,31}$")
