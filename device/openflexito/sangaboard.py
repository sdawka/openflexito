"""Minimal Sangaboard serial client (independent implementation of the line protocol).

Protocol: ASCII commands terminated by "\n"; replies are lines terminated by "\r\n";
multi-line replies end with a line "--END--". 115200 8N1. Moves are non-blocking after
`blocking_moves false`; poll `moving?` to know when the stage has stopped.
"""

from __future__ import annotations

import glob
import logging
import re
import threading
import time
from dataclasses import dataclass

import serial  # pyserial

log = logging.getLogger(__name__)

VERSION_RE = re.compile(r"(Sangaboard Firmware|OpenFlexure Motor Board) v(.*)")
END_MARKER = "--END--"


class SangaboardError(Exception):
    pass


@dataclass
class BoardInfo:
    port: str
    firmware: str
    board: str
    step_time_us: int
    n_motors: int
    modules: list[str]


class SerialTransport:
    """Thin wrapper so tests can substitute a fake."""

    def __init__(self, port: str, baud: int, timeout: float):
        self._ser = serial.Serial(port, baudrate=baud, timeout=timeout, write_timeout=timeout)

    def write_line(self, line: str) -> None:
        self._ser.write((line + "\n").encode("ascii"))
        self._ser.flush()

    def read_line(self) -> str | None:
        raw = self._ser.readline()
        if not raw:
            return None
        return raw.decode("ascii", errors="replace").rstrip("\r\n")

    def flush_input(self) -> None:
        self._ser.reset_input_buffer()

    def close(self) -> None:
        self._ser.close()


def candidate_ports(explicit: str | None = None) -> list[str]:
    if explicit:
        return [explicit]
    ports: list[str] = []
    for pattern in ("/dev/ttyAMA0", "/dev/serial0", "/dev/ttyACM*", "/dev/ttyUSB*", "/dev/ttyS0"):
        ports.extend(sorted(glob.glob(pattern)))
    seen: set[str] = set()
    return [p for p in ports if not (p in seen or seen.add(p))]


class Sangaboard:
    def __init__(self, transport, port_name: str = "?"):
        self._t = transport
        self._lock = threading.RLock()
        self.info = self._handshake(port_name)

    # ---- connection -------------------------------------------------------------------

    @classmethod
    def open(cls, port: str | None = None, baud: int = 115200, timeout: float = 2.0) -> "Sangaboard":
        errors = []
        for candidate in candidate_ports(port):
            try:
                transport = SerialTransport(candidate, baud, timeout)
            except (serial.SerialException, OSError) as e:
                errors.append(f"{candidate}: {e}")
                continue
            try:
                board = cls(transport, candidate)
                log.info("Sangaboard on %s: %s (%s)", candidate, board.info.firmware, board.info.board)
                return board
            except SangaboardError as e:
                errors.append(f"{candidate}: {e}")
                transport.close()
        raise SangaboardError("no Sangaboard found: " + "; ".join(errors) if errors else "no serial ports")

    def _handshake(self, port_name: str) -> BoardInfo:
        time.sleep(0.05)
        self._t.flush_input()
        firmware = None
        for _ in range(3):
            reply = self.query("version")
            m = VERSION_RE.search(reply or "")
            if m:
                firmware = m.group(0)
                break
        if firmware is None:
            raise SangaboardError(f"unexpected version reply: {reply!r}")
        board = self.query("board") or "unknown"
        self.query("blocking_moves false")
        step_time = _int_in(self.query("dt?"), default=1000)
        n_motors = _int_in(self.query("n_motors?"), default=3)
        try:
            modules = [m for m in self.query_multiline("list_modules") if m]
        except SangaboardError:
            modules = []
        return BoardInfo(port_name, firmware, board, step_time, n_motors, modules)

    def close(self) -> None:
        with self._lock:
            self._t.close()

    # ---- low level -------------------------------------------------------------------

    def query(self, cmd: str) -> str:
        with self._lock:
            self._t.write_line(cmd)
            reply = self._t.read_line()
            if reply is None:
                raise SangaboardError(f"timeout waiting for reply to {cmd!r}")
            if reply.startswith("Command not recognised"):
                raise SangaboardError(reply)
            return reply

    def query_multiline(self, cmd: str) -> list[str]:
        with self._lock:
            self._t.write_line(cmd)
            lines: list[str] = []
            while True:
                line = self._t.read_line()
                if line is None:
                    raise SangaboardError(f"timeout in multi-line reply to {cmd!r}")
                if line == END_MARKER:
                    return lines
                if line.startswith("Command not recognised"):
                    raise SangaboardError(line)
                lines.append(line)

    # ---- stage -----------------------------------------------------------------------

    def move_rel(self, dx: int, dy: int, dz: int) -> None:
        self.query(f"mr {int(dx)} {int(dy)} {int(dz)}")

    def position(self) -> tuple[int, int, int]:
        reply = self.query("p?")
        parts = reply.split()
        try:
            x, y, z = (int(p) for p in parts[:3])
        except ValueError as e:
            raise SangaboardError(f"bad position reply {reply!r}") from e
        return x, y, z

    def moving(self) -> bool:
        return self.query("moving?").strip().lower() == "true"

    def stop(self) -> None:
        self.query("stop")

    def release(self) -> None:
        self.query("release")

    def zero(self) -> None:
        self.query("zero")

    def set_step_time(self, us: int) -> int:
        return _int_in(self.query(f"dt {int(us)}"), default=us)

    def set_ramp_time(self, us: int) -> int:
        return _int_in(self.query(f"ramp_time {int(us)}"), default=us)

    # ---- illumination ----------------------------------------------------------------

    def led_cc(self, value: float) -> None:
        self.query(f"led_cc {max(0.0, min(1.0, float(value))):.4f}")

    def led_pwm(self, index: int, value: float) -> None:
        self.query(f"led_pwm {int(index)} {max(0.0, min(1.0, float(value))):.4f}")

    def led_channels(self) -> dict:
        reply = self.query("led_channels?")  # "CC:1 PWM:2"
        out = {}
        for part in reply.split():
            if ":" in part:
                k, v = part.split(":", 1)
                out[k.lower()] = _int_in(v, 0)
        return out


def _int_in(text: str | None, default: int) -> int:
    if not text:
        return default
    m = re.search(r"-?\d+", text)
    return int(m.group(0)) if m else default
