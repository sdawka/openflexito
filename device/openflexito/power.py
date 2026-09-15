"""Standby control. "Off" means standby, not poweroff: the Pi stays booted and reachable so the
webapp (or, later, a physical button) can switch it back on. `PowerController` holds the state and
does the work; a future GPIO button handler needs only call `await device.power.toggle()` to get
identical behaviour to the browser's power button.

Standby: the camera is stopped (encoders + picamera2), illumination is turned off (remembering the
previous levels so waking can restore them), the stage motors are released, and the status LED goes
to its "off" pattern. Waking reverses all of that; the LED's real pattern is recomputed by the usual
state machine on the status loop's next tick. HTTP/WS stay up throughout: `power.*` and `system.*`
keep working while off, `web.py` answers the image endpoints with 503, and `app.py` refuses
camera/stage RPCs with a clear error.

`IdleWatcher` drives the same standby transition automatically after `idle_minutes` of inactivity
(0 disables it). Activity is classified at RPC-registration time rather than by a name list in the
dispatcher: `PowerController.guard()` (the same wrapper `app.py` already uses to refuse camera/stage
RPCs while off) takes a `mutating` flag and bumps the idle timer for mutating calls only, so a new
RPC that forgets to pick a flag fails loudly (TypeError at registration) rather than silently not
counting. Still/raw/bracket HTTP fetches bump it directly from `web.py`. A WebSocket connection can
also hold the device awake by calling `power.activity(active=True)` on a 60 s heartbeat (`CURRENT_CONN`,
set by `web.py` around each dispatched message, tells `activity()` which connection is calling); the
hold expires at 2.5x that interval if the heartbeat stops, and is dropped immediately on disconnect.
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import time
from pathlib import Path
from typing import TYPE_CHECKING
from contextvars import ContextVar

from .clock import now_ns

if TYPE_CHECKING:
    from .app import Device

log = logging.getLogger(__name__)

DEFAULT_IDLE_MINUTES = 10.0
HEARTBEAT_INTERVAL_S = 60.0
HEARTBEAT_TIMEOUT_S = HEARTBEAT_INTERVAL_S * 2.5   # a stale heartbeat stops holding the device awake
POLL_INTERVAL_S = 0.25                             # cheap: just comparing timestamps

# Set by web.py around each RPC dispatched over a given WebSocket, so `power.activity` (an RPC, with
# no connection identity of its own) knows which connection is declaring itself active. None over
# HTTP or when no connection is in scope.
CURRENT_CONN: ContextVar[object | None] = ContextVar("current_conn", default=None)


class IdleWatcher:
    """Auto-standby timer for a PowerController. `bump()` on activity, `set_conn_active()` for a
    WebSocket connection's heartbeat hold; `run()` is a background task that trips standby once
    `minutes` have passed with neither."""

    def __init__(self, power: "PowerController", minutes: float = DEFAULT_IDLE_MINUTES):
        self.power = power
        self.minutes = float(minutes)
        self._last = now_ns()
        self._conns: dict[object, float] = {}  # connection -> monotonic() deadline while held active

    def bump(self) -> None:
        self._last = now_ns()

    def set_conn_active(self, conn, active: bool) -> None:
        """A WebSocket connection declaring itself active (or not) via `power.activity`."""
        if conn is None:  # e.g. called over plain HTTP: nothing to hold, just the one-off bump in activity()
            return
        if active:
            self._conns[conn] = time.monotonic() + HEARTBEAT_TIMEOUT_S
        else:
            self._conns.pop(conn, None)

    def on_disconnect(self, conn) -> None:
        self._conns.pop(conn, None)

    def _held(self) -> bool:
        """Any connection with a live heartbeat hold is keeping the device awake; expired ones are
        dropped as a side effect so a crashed tab doesn't hold standby off forever."""
        now = time.monotonic()
        for conn, deadline in list(self._conns.items()):
            if deadline <= now:
                del self._conns[conn]
        return bool(self._conns)

    def idle_in(self) -> int:
        """Seconds until auto standby, or -1 when disabled or already off."""
        if not self.power.on or self.minutes <= 0:
            return -1
        if self._held():
            return int(self.minutes * 60)
        elapsed = (now_ns() - self._last) / 1e9
        return max(0, int(self.minutes * 60 - elapsed))

    async def run(self) -> None:
        while True:
            await asyncio.sleep(POLL_INTERVAL_S)
            if not self.power.on or self.minutes <= 0 or self._held():
                continue
            elapsed = (now_ns() - self._last) / 1e9
            if elapsed >= self.minutes * 60:
                log.info("auto standby after %.1f minute(s) idle", self.minutes)
                await self.power.set(False, reason="idle")


class PowerController:
    def __init__(self, device: "Device"):
        self.device = device
        self.on = True
        self.since = now_ns()
        self.reason = "request"  # of the last on/off transition: "request" (manual) or "idle" (timer)
        self._saved_light: dict | None = None
        self.idle = IdleWatcher(self)
        self._load()

    # ---- persistence (survives a service restart while in standby) --------------------------

    @property
    def _file(self) -> Path:
        return self.device.cfg.state_dir / "power.json"

    def _load(self) -> None:
        try:
            d = json.loads(self._file.read_text())
            self.on = bool(d.get("on", True))
            self.since = int(d.get("since", self.since))
            self.reason = str(d.get("reason", self.reason))
            self.idle.minutes = float(d.get("idle_minutes", self.idle.minutes))
        except (OSError, ValueError):
            pass

    def _save(self) -> None:
        try:
            self.device.cfg.state_dir.mkdir(parents=True, exist_ok=True)
            self._file.write_text(json.dumps({"on": self.on, "since": self.since, "reason": self.reason,
                                              "idle_minutes": self.idle.minutes}))
        except OSError as e:
            log.warning("could not save power state: %s", e)

    # ---- RPC surface (power.get / power.set / power.toggle / power.activity / power.set_idle) --

    def status(self) -> dict:
        return {"on": self.on, "since": self.since, "reason": self.reason,
                "idle_minutes": self.idle.minutes, "idle_in": self.idle.idle_in()}

    async def get(self) -> dict:
        """Current power state: on (bool), since (ns CLOCK_BOOTTIME of the last change), reason
        ("request" for a manual toggle, "idle" for the auto-standby timer) for that change,
        idle_minutes (auto-standby timeout, 0 = disabled) and idle_in (seconds until it trips, -1
        if n/a)."""
        return self.status()

    async def set(self, on: bool, reason: str = "request") -> dict:
        """Switch standby on or off; a no-op if already in that state. `reason` ("request" for a
        manual toggle, "idle" from the auto-standby timer) is persisted and shows up in `status()`
        (so a tab that connects after the fact still knows why), not just the change event."""
        on = bool(on)
        if on != self.on:
            await (self._wake() if on else self._standby())
            self.on = on
            self.since = now_ns()
            self.reason = reason
            self.idle.bump()  # any transition resets the countdown: waking at minute 9 must not
            self._save()      # immediately re-trip at minute 10
            self.device.events.publish("status", {"power": self.status()})
            self.device.status(changed=True)  # wake status_loop to recompute the LED pattern now
        return self.status()

    async def toggle(self, reason: str = "request") -> dict:
        """Flip standby. The single entry point a physical button handler should call."""
        return await self.set(not self.on, reason=reason)

    async def activity(self, active: bool, reason: str = "") -> dict:
        """WebSocket heartbeat: declare this connection active (holding the device awake) or not.
        Call again within 2.5x the 60 s interval or the hold lapses; `reason` is informational only
        (e.g. "visible", "recording"). Declaring active also counts as one-off activity itself, so a
        single call (including over plain HTTP, which holds nothing) still bumps the timer."""
        self.idle.set_conn_active(CURRENT_CONN.get(), active)
        if active:
            self.idle.bump()
        return {"on": self.on, "since": self.since, "idle_in": self.idle.idle_in()}

    async def set_idle(self, minutes: float) -> dict:
        """Set the auto-standby timeout in minutes; 0 disables it. Persisted alongside on/off."""
        self.idle.minutes = max(0.0, float(minutes))
        self.idle.bump()
        self._save()
        self.device.events.publish("status", {"power": self.status()})
        return self.status()

    def guard(self, fn, mutating: bool = True):
        """Wrap a camera/stage RPC: refuse while in standby (instead of poking stopped/released
        hardware), and, for `mutating` calls, bump the idle timer. Read-only calls (status,
        position, get_*) pass `mutating=False` so polling them can't hold the device awake forever.
        Preserves `fn`'s signature (via functools.wraps) so `/rpc/schema` still reflects its real
        parameters."""
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            if not self.on:
                raise RuntimeError("device is in standby; call power.set(on=true) to wake it first")
            if mutating:
                self.idle.bump()
            return fn(*args, **kwargs)
        return wrapper

    # ---- transitions ---------------------------------------------------------------------------

    async def _standby(self) -> None:
        dev = self.device
        if dev.camera is not None:
            await dev.camera.stop()
        if dev.stage is not None:
            await self._lights_off()
            await dev.stage.release()
        dev.leds.set_state("off")

    async def _wake(self) -> None:
        dev = self.device
        if dev.camera is not None:
            await dev.camera.start()
        if dev.stage is not None:
            await self._lights_restore()
        # the real LED pattern (streaming/online/offline/...) is recomputed by status_loop

    async def _lights_off(self) -> None:
        dev = self.device
        self._saved_light = {"cc": dev._light["cc"], "pwm": dict(dev._light["pwm"])}
        loop = asyncio.get_running_loop()
        board = dev.stage.board
        await loop.run_in_executor(None, board.led_cc, 0.0)
        for i in range(dev._light_channels.get("pwm", 0)):
            await loop.run_in_executor(None, board.led_pwm, i, 0.0)

    async def _lights_restore(self) -> None:
        dev = self.device
        saved, self._saved_light = self._saved_light, None
        if not saved:
            return
        loop = asyncio.get_running_loop()
        board = dev.stage.board
        await loop.run_in_executor(None, board.led_cc, saved["cc"])
        for i, v in saved["pwm"].items():
            await loop.run_in_executor(None, board.led_pwm, i, v)
        dev._light = saved
        dev.events.publish("light", dev._light_dict())
