"""In-memory emulation of the Sangaboard line protocol for tests and laptop development."""

from __future__ import annotations

import time
from collections import deque


class FakeTransport:
    def __init__(self, step_time_us: int = 1000, firmware: str = "Sangaboard Firmware v1.0.4"):
        self.step_time_us = step_time_us
        self.firmware = firmware
        self.pos = [0, 0, 0]
        self._target = [0, 0, 0]
        self._move_start = 0.0
        self._move_end = 0.0
        self._out: deque[str] = deque([firmware])  # boot banner
        self.led = {"cc": 0.0, "pwm": {}}
        self.blocking = True
        self.sent: list[str] = []

    # -- motion model: linear interpolation between start and target over the move duration
    def _update(self) -> None:
        now = time.monotonic()
        if now >= self._move_end:
            self.pos = list(self._target)
        else:
            f = (now - self._move_start) / (self._move_end - self._move_start)
            start = getattr(self, "_start", self.pos)
            self.pos = [round(s + (t - s) * f) for s, t in zip(start, self._target)]

    def _moving(self) -> bool:
        self._update()
        return time.monotonic() < self._move_end

    def write_line(self, line: str) -> None:
        self.sent.append(line)
        cmd, *args = line.strip().split()
        reply: str | list[str]
        if cmd == "version":
            reply = self.firmware
        elif cmd == "board":
            reply = "Sangaboard v0.5"
        elif cmd == "list_modules":
            reply = ["Stage", "Illumination", "--END--"]
        elif cmd == "blocking_moves":
            self.blocking = args[0] == "true"
            reply = f"blocking_moves {args[0]}"
        elif cmd in ("dt?", "min_step_delay?"):
            reply = f"minimum step delay {self.step_time_us}"
        elif cmd == "dt":
            self.step_time_us = int(args[0]); reply = f"minimum step delay {self.step_time_us}"
        elif cmd == "n_motors?":
            reply = "n_motors 3"
        elif cmd == "mr":
            self._update()
            d = [int(a) for a in args[:3]]
            self._start = list(self.pos)
            self._target = [p + v for p, v in zip(self.pos, d)]
            dur = max(abs(v) for v in d) * self.step_time_us / 1e6
            self._move_start = time.monotonic()
            self._move_end = self._move_start + dur
            if self.blocking:
                time.sleep(dur); self._update()
            reply = "done."
        elif cmd == "p?":
            self._update(); reply = " ".join(str(p) for p in self.pos)
        elif cmd == "moving?":
            reply = "true" if self._moving() else "false"
        elif cmd == "stop":
            self._update(); self._target = list(self.pos); self._move_end = 0.0; reply = "Move aborted"
        elif cmd == "zero":
            self._update(); self.pos = [0, 0, 0]; self._target = [0, 0, 0]; reply = "position reset to 0 0 0"
        elif cmd == "release":
            reply = "done"
        elif cmd == "led_cc":
            self.led["cc"] = float(args[0]); reply = f"CC LED:{self.led['cc']}"
        elif cmd == "led_cc?":
            reply = f"CC LED:{self.led['cc']}"
        elif cmd == "led_pwm":
            self.led["pwm"][int(args[0])] = float(args[1]); reply = f"PWM:{args[0]}:{args[1]}"
        elif cmd == "led_channels?":
            reply = "CC:1 PWM:2"
        else:
            reply = f"Command not recognised: '{line}', Type 'help' for a list of commands."
        if isinstance(reply, list):
            self._out.extend(reply)
        else:
            self._out.append(reply)

    def read_line(self) -> str | None:
        return self._out.popleft() if self._out else None

    def flush_input(self) -> None:
        self._out.clear()

    def close(self) -> None:
        pass
