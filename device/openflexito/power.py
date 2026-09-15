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
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING

from .clock import now_ns

if TYPE_CHECKING:
    from .app import Device

log = logging.getLogger(__name__)


class PowerController:
    def __init__(self, device: "Device"):
        self.device = device
        self.on = True
        self.since = now_ns()
        self._saved_light: dict | None = None
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
        except (OSError, ValueError):
            pass

    def _save(self) -> None:
        try:
            self.device.cfg.state_dir.mkdir(parents=True, exist_ok=True)
            self._file.write_text(json.dumps({"on": self.on, "since": self.since}))
        except OSError as e:
            log.warning("could not save power state: %s", e)

    # ---- RPC surface (power.get / power.set / power.toggle) ----------------------------------

    def status(self) -> dict:
        return {"on": self.on, "since": self.since}

    async def get(self) -> dict:
        """Current power state: on (bool), since (ns CLOCK_BOOTTIME of the last change)."""
        return self.status()

    async def set(self, on: bool) -> dict:
        """Switch standby on or off; a no-op if already in that state."""
        on = bool(on)
        if on != self.on:
            await (self._wake() if on else self._standby())
            self.on = on
            self.since = now_ns()
            self._save()
            self.device.events.publish("status", {"power": self.status()})
            self.device.status(changed=True)  # wake status_loop to recompute the LED pattern now
        return self.status()

    async def toggle(self) -> dict:
        """Flip standby. The single entry point a physical button handler should call."""
        return await self.set(not self.on)

    def guard(self, fn):
        """Wrap a camera/stage RPC so it raises a clear error while in standby, instead of poking
        stopped/released hardware. Preserves `fn`'s signature (via functools.wraps) so `/rpc/schema`
        still reflects its real parameters."""
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            if not self.on:
                raise RuntimeError("device is in standby; call power.set(on=true) to wake it first")
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
