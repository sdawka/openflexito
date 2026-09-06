"""Status LED via the kernel `pattern` trigger (falls back to `timer`, then to no-op)."""

from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger(__name__)

# state -> list of (on: bool, duration_ms)
PATTERNS: dict[str, list[tuple[bool, int]]] = {
    "booting":    [(True, 100), (False, 100)],
    "offline":    [(True, 500), (False, 500)],
    "hotspot":    [(True, 100), (False, 150), (True, 100), (False, 1650)],
    "online":     [(True, 1000)],
    "streaming":  [(True, 50), (False, 950)],
    "error":      [(True, 150), (False, 150)] * 3 + [(True, 450), (False, 150)] * 3 + [(True, 150), (False, 150)] * 2 + [(True, 150), (False, 1000)],
    "off":        [(False, 1000)],
}


def pattern_string(steps: list[tuple[bool, int]], max_brightness: int) -> str:
    """Kernel pattern format: 'brightness duration' tuples; repeating a brightness with
    duration 0 holds the value instead of dimming towards the next tuple."""
    parts = []
    for on, ms in steps:
        b = max_brightness if on else 0
        parts.append(f"{b} {ms} {b} 0")
    return " ".join(parts)


class LedController:
    def __init__(self, path: Path | str = "/sys/class/leds/ACT"):
        self.path = Path(path)
        self.state = None
        self.available = self.path.is_dir()
        self.max_brightness = 1
        self.mode = "none"
        if self.available:
            try:
                self.max_brightness = int((self.path / "max_brightness").read_text().strip() or 1)
                triggers = (self.path / "trigger").read_text()
                self.mode = "pattern" if "pattern" in triggers else ("timer" if "timer" in triggers else "manual")
            except OSError as e:
                log.warning("LED at %s not usable: %s", self.path, e)
                self.available = False
        else:
            log.info("no LED at %s; status LED disabled", self.path)

    def _write(self, name: str, value: str) -> None:
        (self.path / name).write_text(value)

    def _set_trigger(self, trigger: str) -> None:
        """Select a trigger only if it is not already active: re-selecting recreates the
        trigger's sysfs attributes (pattern/repeat) as root, which would lock us out."""
        current = (self.path / "trigger").read_text()
        if f"[{trigger}]" not in current:
            self._write("trigger", trigger)

    def set_state(self, state: str) -> None:
        if state == self.state:
            return
        self.state = state
        if not self.available:
            return
        steps = PATTERNS.get(state, PATTERNS["error"])
        try:
            if self.mode == "pattern":
                self._set_trigger("pattern")
                self._write("pattern", pattern_string(steps, self.max_brightness))
                self._write("repeat", "-1")
            elif self.mode == "timer" and len(steps) >= 2:
                self._set_trigger("timer")
                self._write("delay_on", str(steps[0][1]))
                self._write("delay_off", str(steps[1][1]))
            else:
                self._set_trigger("none")
                self._write("brightness", str(self.max_brightness if steps[0][0] else 0))
        except OSError as e:
            log.warning("LED write failed: %s", e)
