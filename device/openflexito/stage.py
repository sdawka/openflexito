"""Stage control: software position, backlash compensation, non-blocking moves with timestamps.

The Sangaboard is authoritative for the hardware position (`p?`), but it forgets it when
powered off. We mirror it to disk together with an offset so the last known position can be
restored. Backlash handling follows the OpenFlexure v3 model (`things/stage/__init__.py`,
BaseStage): a per-axis engagement state in [0, 1] tracks which side of the gear backlash we are
on (0 = unknown/disengaged at start-up, as in v3); a compensated move whose final state on a
checked axis would be < 1 is split into (move - backlash) followed by +backlash on those axes.
Which axes are checked mirrors v3's BacklashCompensation: by default only the axes that move
(MOVEMENT_AXES); callers may ask for "all", "xy" or "z" (v3's scans use XY_ONLY, autofocus
Z_ONLY). Everything below the program/hardware frame conversion works in the hardware frame,
so the preferred direction is +hardware on each axis.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from .clock import now_ns
from .events import EventBus
from .sangaboard import Sangaboard, SangaboardError

log = logging.getLogger(__name__)

AXES = ("x", "y", "z")


class StageBusy(Exception):
    pass


COMPENSATION_MODES = ("moving", "all", "xy", "z")


def compensation_axes(mode, move: dict[str, int]) -> tuple[str, ...]:
    """Axes to backlash-check for a move (v3 BacklashCompensation semantics).
    True/"moving" -> axes with a non-zero move; "all" -> every axis; "xy"/"z" -> those axes;
    False/None -> none (raw move)."""
    if mode is False or mode is None:
        return ()
    if mode is True or mode == "moving":
        return tuple(a for a in AXES if move.get(a, 0) != 0)
    if mode == "all":
        return AXES
    if mode == "xy":
        return ("x", "y")
    if mode == "z":
        return ("z",)
    raise ValueError(f"compensate must be a bool or one of {COMPENSATION_MODES}, not {mode!r}")


@dataclass
class MoveResult:
    start: dict
    end: dict
    t0_ns: int
    t1_ns: int
    cancelled: bool


class Stage:
    def __init__(
        self,
        board: Sangaboard,
        state_dir: Path,
        events: EventBus,
        backlash: dict[str, int] | None = None,
        inverted: dict[str, bool] | None = None,
        poll_interval: float = 0.05,
        release_after: float = 2.0,
    ):
        self.board = board
        self.events = events
        self.state_file = Path(state_dir) / "position.json"
        self.backlash = dict(backlash or {"x": 200, "y": 200, "z": 200})
        self.inverted = dict(inverted or {"x": True, "y": False, "z": True})
        self.poll_interval = poll_interval
        self.release_after = release_after
        self._energised = True          # the firmware energises coils on the first move and never releases
        self._release_timer: threading.Timer | None = None
        self._engaged = {a: 0.0 for a in AXES}   # 1 = engaged in +backlash direction; 0 = unknown (v3 starts here)
        self._offset = {a: 0 for a in AXES}      # program hw-frame offset for restored positions
        self._hw = {a: 0 for a in AXES}
        self._moving = False
        self._live: tuple[dict, dict, int, float] | None = None
        self._cancel = threading.Event()
        self._busy = threading.Lock()
        self._state_lock = threading.Lock()  # _save_state runs on the worker and the loop thread
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="stage")
        self._jog_pending: dict | None = None
        self._jog_lock = threading.Lock()
        self._load_state()
        self._refresh_hw()

    # ---- frames --------------------------------------------------------------------------

    def _sign(self, axis: str) -> int:
        return -1 if self.inverted.get(axis) else 1

    def _to_program(self, hw: dict[str, int]) -> dict[str, int]:
        return {a: self._sign(a) * (hw[a] + self._offset[a]) for a in AXES}

    @property
    def position(self) -> dict[str, int]:
        return self._to_program(self._hw)

    def live_position(self) -> dict[str, int]:
        """Position estimate *during* a move (constant speed between t0 and t0+duration), in the
        program frame. Used by the fake camera so a sweep renders a moving specimen; clients do
        the same interpolation from `event.position` (t0/t1)."""
        live = self._live
        if not self._moving or live is None:
            return self.position
        start_hw, target_hw, t0, duration = live
        f = 1.0 if duration <= 0 else min(1.0, max(0.0, (now_ns() - t0) / 1e9 / duration))
        return self._to_program({a: int(round(start_hw[a] + (target_hw[a] - start_hw[a]) * f)) for a in AXES})

    @property
    def moving(self) -> bool:
        return self._moving

    def status(self) -> dict:
        return {
            "position": self.position,
            "hw_position": dict(self._hw),
            "moving": self._moving,
            "backlash": dict(self.backlash),
            "inverted": dict(self.inverted),
            "engaged": dict(self._engaged),
            "step_time_us": self.board.info.step_time_us,
            "energised": self._energised,
            "release_after": self.release_after,
            "firmware": self.board.info.firmware,
            "board": self.board.info.board,
            "port": self.board.info.port,
        }

    # ---- persistence ---------------------------------------------------------------------

    def _load_state(self) -> None:
        try:
            data = json.loads(self.state_file.read_text())
            self._offset.update({a: int(data.get("offset", {}).get(a, 0)) for a in AXES})
            self._saved_hw = {a: int(data.get("hw", {}).get(a, 0)) for a in AXES}
            self.backlash.update({a: int(v) for a, v in data.get("backlash", {}).items() if a in AXES})
            if "release_after" in data:
                self.release_after = float(data["release_after"])
            self.inverted.update({a: bool(v) for a, v in data.get("inverted", {}).items() if a in AXES})
        except (OSError, ValueError, json.JSONDecodeError):
            self._saved_hw = None

    def _save_state(self) -> None:
        # what restore_position() falls back to must be the last *saved* position, not the one this
        # process booted with, or a second power loss without a restart restores a stale position
        self._saved_hw = dict(self._hw)
        try:
            with self._state_lock:
                self.state_file.parent.mkdir(parents=True, exist_ok=True)
                tmp = self.state_file.with_suffix(".tmp")
                tmp.write_text(json.dumps({
                    "hw": self._hw, "offset": self._offset,
                    "backlash": self.backlash, "inverted": self.inverted, "release_after": self.release_after,
                }))
                tmp.replace(self.state_file)
        except OSError as e:
            log.warning("could not save stage state: %s", e)

    def restore_position(self) -> dict[str, int]:
        """If the board was power-cycled (position reset), re-apply the last saved position."""
        if not getattr(self, "_saved_hw", None):
            return self.position
        self._refresh_hw()
        for a in AXES:
            self._offset[a] = self._saved_hw[a] + self._offset[a] - self._hw[a]
        self._save_state()
        self._emit_position(False)
        return self.position

    def lost_position(self) -> bool:
        saved = getattr(self, "_saved_hw", None)
        return bool(saved) and all(self._hw[a] == 0 for a in AXES) and any(saved[a] != 0 for a in AXES)

    # ---- hardware helpers (worker thread) ------------------------------------------------

    def _refresh_hw(self) -> dict[str, int]:
        x, y, z = self.board.position()
        self._hw = {"x": x, "y": y, "z": z}
        return self._hw

    def _emit_position(self, moving: bool, **extra) -> None:
        try:
            self.events.publish_threadsafe("position", {
                "t": now_ns(), "position": self.position, "hw": dict(self._hw), "moving": moving, **extra,
            })
        except Exception:  # noqa: BLE001  reporting must never break a move on the worker thread
            log.exception("position event failed")

    # ---- coil release ---------------------------------------------------------------------

    def _cancel_release(self) -> None:
        t, self._release_timer = self._release_timer, None
        if t is not None:
            t.cancel()

    def _schedule_release(self) -> None:
        """Arm a timer that de-energises the coils once the stage has been idle for `release_after`."""
        self._cancel_release()
        if self.release_after and self.release_after > 0:
            t = threading.Timer(self.release_after, self._release_if_idle)
            t.daemon = True
            self._release_timer = t
            t.start()

    def _release_if_idle(self) -> None:
        if self._moving or self._busy.locked():
            return
        try:
            self.board.release()
            self._energised = False
            self._save_state()
        except SangaboardError as e:
            log.warning("motor release failed: %s", e)

    def _hw_move(self, d: dict[str, int]) -> MoveResult:
        """One raw relative hardware move; blocks until the board reports it has stopped."""
        if all(v == 0 for v in d.values()):
            return MoveResult(dict(self._hw), dict(self._hw), now_ns(), now_ns(), False)
        self._cancel_release()
        self._energised = True   # the firmware re-energises on the next step command
        start_hw = dict(self._hw)
        duration = max(abs(v) for v in d.values()) * self.board.info.step_time_us / 1e6
        target = {a: start_hw[a] + d[a] for a in AXES}
        cancelled = False
        t0 = now_ns()
        # Everything after this point runs inside try/finally: if the serial link fails mid-move
        # the moving flag, live estimate and saved position must still be put right, otherwise
        # the device reports "moving" forever and the fake camera renders a stale position.
        self._moving = True
        try:
            self._live = (start_hw, target, t0, duration)
            self.board.move_rel(d["x"], d["y"], d["z"])
            self._emit_position(True, target_hw=target, duration=duration)
            if duration > 0.2 and self._cancel.wait(max(0.0, duration - 0.1)):
                cancelled = True
            while not cancelled and self.board.moving():
                if self._cancel.wait(self.poll_interval):
                    cancelled = True
            if cancelled:
                self.board.stop()
                time.sleep(0.05)
        finally:
            self._moving = False
            self._live = None
            try:
                self._refresh_hw()
            except SangaboardError as e:
                log.error("position readback failed after move: %s", e)
            t1 = now_ns()
            # v3 update_position: state += delta / backlash, clamped to [0, 1]
            for a in AXES:
                bl = self.backlash.get(a, 0)
                if bl:
                    self._engaged[a] = min(1.0, max(0.0, self._engaged[a] + (self._hw[a] - start_hw[a]) / bl))
            self._save_state()
            self._emit_position(False, cancelled=cancelled)
            self._schedule_release()
        return MoveResult(start_hw, dict(self._hw), t0, t1, cancelled)

    def _move_rel_sync(self, move: dict[str, int], compensate) -> MoveResult:
        axes = compensation_axes(compensate, move)  # validate before touching the hardware
        if not self._busy.acquire(blocking=False):
            raise StageBusy("stage is already moving")
        try:
            self._cancel.clear()
            if not axes:
                return self._hw_move(move)
            # v3 _move_with_backlash_correction: predict the (unclamped) state after the move on
            # the checked axes; any axis ending below 1 gets a +backlash correction move.
            correction = {a: 0 for a in AXES}
            for a in axes:
                bl = self.backlash.get(a, 0)
                final = 1.0 if bl == 0 else self._engaged[a] + move[a] / bl
                if final < 1.0:
                    correction[a] = bl
            if any(correction.values()):
                first = self._hw_move({a: move[a] - correction[a] for a in AXES})
                if first.cancelled:
                    return first
                second = self._hw_move(correction)
                return MoveResult(first.start, second.end, first.t0_ns, second.t1_ns, second.cancelled)
            return self._hw_move(move)
        finally:
            self._busy.release()

    def _program_to_hw_delta(self, dx: int, dy: int, dz: int) -> dict[str, int]:
        prog = {"x": int(dx), "y": int(dy), "z": int(dz)}
        return {a: self._sign(a) * prog[a] for a in AXES}

    # ---- async API -------------------------------------------------------------------------

    async def _run(self, fn, *args):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, fn, *args)

    async def move_rel(self, x: int = 0, y: int = 0, z: int = 0, compensate: bool | str = True) -> dict:
        """Relative move in program-frame steps. compensate: true = backlash-correct the axes that
        move (v3 MOVEMENT_AXES), "all" | "xy" | "z" = correct those axes even if they do not move
        (v3 ALL_AXES / XY_ONLY / Z_ONLY), false = raw move."""
        res = await self._run(self._move_rel_sync, self._program_to_hw_delta(x, y, z), compensate)
        return self._result_dict(res)

    async def move_to(self, x: int | None = None, y: int | None = None, z: int | None = None,
                      compensate: bool | str = True) -> dict:
        cur = self.position
        target = {"x": cur["x"] if x is None else int(x),
                  "y": cur["y"] if y is None else int(y),
                  "z": cur["z"] if z is None else int(z)}
        delta = {a: target[a] - cur[a] for a in AXES}
        return await self.move_rel(delta["x"], delta["y"], delta["z"], compensate)

    async def jog(self, x: int = 0, y: int = 0, z: int = 0) -> dict:
        """Newest-wins jog: if a move is in progress, cancel it and run the latest request."""
        if self._busy.locked():
            self._cancel.set()
        return await self.move_rel(x, y, z, compensate=False)

    async def stop(self) -> dict:
        self._cancel.set()
        if not self._busy.locked():
            await self._run(self.board.stop)
            await self._run(self._refresh_hw)
        return {"position": self.position}

    async def release(self) -> dict:
        self._cancel_release()
        def _rel():
            self.board.release()
            self._energised = False
        await self._run(_rel)
        return {"position": self.position, "energised": False}

    async def set_release_after(self, seconds: float) -> dict:
        """Seconds of idle time before the coils are de-energised (0 = hold for ever)."""
        self.release_after = max(0.0, float(seconds))
        self._save_state()
        if self.release_after and not self._moving:
            self._schedule_release()
        else:
            self._cancel_release()
        return {"release_after": self.release_after}

    async def zero(self) -> dict:
        def _zero():
            self.board.zero()
            self._offset = {a: 0 for a in AXES}
            self._refresh_hw()
            self._save_state()
            self._emit_position(False)
        await self._run(_zero)
        return {"position": self.position}

    async def set_backlash(self, x: int | None = None, y: int | None = None, z: int | None = None) -> dict:
        for a, v in (("x", x), ("y", y), ("z", z)):
            if v is not None:
                self.backlash[a] = int(v)
        self._save_state()
        return dict(self.backlash)

    async def set_inverted(self, x: bool | None = None, y: bool | None = None, z: bool | None = None) -> dict:
        for a, v in (("x", x), ("y", y), ("z", z)):
            if v is not None:
                self.inverted[a] = bool(v)
        self._save_state()
        self._emit_position(self._moving)
        return dict(self.inverted)

    def _result_dict(self, res: MoveResult) -> dict:
        return {
            "position": self.position,
            "t0": res.t0_ns, "t1": res.t1_ns,
            "start_hw": res.start, "end_hw": res.end,
            "cancelled": res.cancelled,
        }

    def close(self) -> None:
        self._cancel_release()
        self._cancel.set()
        self._executor.shutdown(wait=False)
        try:
            self.board.close()
        except SangaboardError:
            pass
