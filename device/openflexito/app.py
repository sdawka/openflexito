"""Composition: hardware, RPC methods, status/LED state machine, HTTP server."""

from __future__ import annotations

import asyncio
import json
import logging
import signal
import subprocess
from pathlib import Path

from aiohttp import web

from . import __version__
from .camera import CameraBase, make_camera
from .config import Config
from .events import EventBus
from .leds import LedController
from .netwatch import network_state, wifi_join, wifi_scan
from .rpc import RpcRegistry
from .sangaboard import Sangaboard, SangaboardError
from .stage import Stage
from .web import build_app

log = logging.getLogger(__name__)


class Device:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.events = EventBus()
        self.rpc = RpcRegistry()
        self.leds = LedController(cfg.led_path)
        self.camera: CameraBase | None = None
        self.stage: Stage | None = None
        self.errors: dict[str, str] = {}
        self.net: dict = {"state": "unknown", "ip": None, "connections": []}
        self.led_state = "booting"
        self._status_dirty = asyncio.Event()
        self.events.on_change = lambda n: self.status(changed=True)
        self.leds.set_state("booting")

    # ---- hardware bring-up -------------------------------------------------------------------

    def open_hardware(self) -> None:
        cfg = self.cfg
        cfg.state_dir.mkdir(parents=True, exist_ok=True)
        if cfg.stage.enabled:
            try:
                if cfg.stage.fake:
                    from .fake_board import FakeTransport
                    board = Sangaboard(FakeTransport(), "fake")
                else:
                    board = Sangaboard.open(cfg.stage.port, cfg.stage.baud)
                self.stage = Stage(board, cfg.state_dir, self.events, cfg.stage.backlash, cfg.stage.inverted,
                                   cfg.stage.poll_interval)
            except (SangaboardError, OSError) as e:
                self.errors["stage"] = str(e)
                log.error("stage unavailable: %s", e)
        if cfg.camera.enabled:
            try:
                self.camera = make_camera(cfg.camera, cfg.state_dir, self.events)
                if hasattr(self.camera, "position_provider") and self.stage is not None:
                    stage = self.stage  # fake camera: couple the synthetic specimen to the stage
                    self.camera.position_provider = stage.live_position
            except Exception as e:  # noqa: BLE001
                self.errors["camera"] = str(e)
                log.error("camera unavailable: %s", e)

    # ---- status ------------------------------------------------------------------------------

    def status(self, changed: bool = False) -> dict:
        clients = self.camera.main.clients + self.camera.lores.clients if self.camera else 0
        if changed:
            self._status_dirty.set()
            if self.camera:
                self.camera.set_active(clients > 0 or self.events.count > 0)
        return {
            "version": __version__,
            "led": self.led_state,
            "network": self.net,
            "errors": self.errors,
            "camera": self.camera.status() if self.camera else None,
            "stage": self.stage.status() if self.stage else None,
            "stream_clients": clients,
        }

    def _compute_led_state(self) -> str:
        if self.errors:
            return "error"
        clients = self.camera.main.clients + self.camera.lores.clients if self.camera else 0
        net = self.net.get("state")
        if net == "hotspot":
            return "hotspot"
        if net == "offline":
            return "offline"
        if clients > 0:
            return "streaming"
        return "online"

    async def status_loop(self) -> None:
        while True:
            try:
                self.net = await network_state(self.cfg.hotspot_connection)
            except Exception as e:  # noqa: BLE001
                log.debug("network state failed: %s", e)
            new = self._compute_led_state()
            if new != self.led_state:
                self.led_state = new
                self.leds.set_state(new)
                self.events.publish("status", {"led": new, "network": self.net, "errors": self.errors})
            try:
                await asyncio.wait_for(self._status_dirty.wait(), timeout=3.0)
            except asyncio.TimeoutError:
                pass
            self._status_dirty.clear()

    # ---- RPC surface -------------------------------------------------------------------------

    def register_rpc(self) -> None:
        r = self.rpc
        st, cam = self.stage, self.camera

        r.register("system.status", lambda: self.status(), "Full device status (also sent as event.hello).")
        r.register("system.schema", lambda: r.schema(), "List RPC methods.")
        r.register("system.config", lambda: self.cfg.to_dict(), "Effective configuration.")
        r.register("system.wifi_scan", wifi_scan, "Scan for WiFi networks via NetworkManager.")
        r.register("system.wifi_join", wifi_join, "Join a WiFi network (ssid, psk).")
        r.register("system.reboot", lambda: _systemctl("reboot"), "Reboot the device.")
        r.register("system.shutdown", lambda: _systemctl("poweroff"), "Power off the device.")

        if st is not None:
            r.register("stage.status", st.status, "Position, backlash, inversion, firmware.")
            r.register("stage.position", lambda: st.position, "Current position in program frame (steps).")
            r.register("stage.move_rel", st.move_rel, "Relative move in steps; compensate=false skips backlash handling.")
            r.register("stage.move_to", st.move_to, "Absolute move in program frame; omitted axes stay.")
            r.register("stage.jog", st.jog, "Newest-wins relative move without backlash compensation (cancels a running jog).")
            r.register("stage.stop", st.stop, "Abort the current move.")
            r.register("stage.release", st.release, "De-energise motor coils.")
            r.register("stage.zero", st.zero, "Set the current position as 0 0 0.")
            r.register("stage.restore_position", lambda: st.restore_position(), "Re-apply the last saved position after a board power cycle.")
            r.register("stage.set_backlash", st.set_backlash, "Set backlash steps per axis.")
            r.register("stage.set_inverted", st.set_inverted, "Set axis inversion (hardware -> program frame).")
            r.register("stage.set_step_time", lambda us: _thread(st.board.set_step_time, int(us)), "Set minimum step delay in microseconds.")

            async def light_set(cc: float | None = None, pwm: list[float] | None = None) -> dict:
                """Set illumination: cc = constant-current LED 0..1, pwm = list of PWM channel values 0..1."""
                loop = asyncio.get_running_loop()
                if cc is not None:
                    await loop.run_in_executor(None, st.board.led_cc, float(cc))
                    self._light["cc"] = float(cc)
                for i, v in enumerate(pwm or []):
                    await loop.run_in_executor(None, st.board.led_pwm, i, float(v))
                    self._light["pwm"][i] = float(v)
                self.events.publish("light", self._light_dict())
                self._save_light()
                return self._light_dict()
            self._light = self._load_light()
            r.register("light.set", light_set)
            r.register("light.get", self._light_dict, "Last set illumination values.")

        if cam is not None:
            r.register("camera.status", cam.status, "Sensor, stream size, controls, client count.")
            r.register("camera.get_controls", cam.get_controls, "Persistent libcamera controls.")
            r.register("camera.set_controls", cam.set_controls,
                       "Set controls: ExposureTime (us), AnalogueGain, ColourGains [r,b], AeEnable, AwbEnable, Brightness, Contrast, Saturation, Sharpness.")
            r.register("camera.get_tuning", cam.get_tuning, "Current libcamera tuning JSON.")
            r.register("camera.set_tuning", cam.set_tuning, "Replace the tuning JSON and restart the camera.")
            r.register("camera.reset_tuning", cam.reset_tuning, "Restore the bundled tuning file.")
            r.register("camera.set_stream_size", cam.set_stream_size, "Change stream resolution (width, height).")
            r.register("camera.metadata", cam.capture_metadata, "Latest libcamera request metadata.")

    def _light_dict(self) -> dict:
        return {"cc": self._light["cc"], "pwm": [self._light["pwm"][k] for k in sorted(self._light["pwm"])]}

    # The board keeps the LED state across a service restart but cannot report it, so remember it.
    def _light_file(self) -> Path:
        return self.cfg.state_dir / "light.json"

    def _load_light(self) -> dict:
        try:
            d = json.loads(self._light_file().read_text())
            return {"cc": float(d.get("cc", 0.0)), "pwm": {int(k): float(v) for k, v in d.get("pwm", {}).items()}}
        except (OSError, ValueError, AttributeError):
            return {"cc": 0.0, "pwm": {}}

    def _save_light(self) -> None:
        try:
            self._light_file().write_text(json.dumps({"cc": self._light["cc"], "pwm": {str(k): v for k, v in self._light["pwm"].items()}}))
        except OSError as e:
            log.warning("could not save light state: %s", e)

    # ---- lifecycle ---------------------------------------------------------------------------

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        self.events.bind(loop)
        self.open_hardware()
        self.register_rpc()
        if self.camera:
            self.camera.bind(loop)
            try:
                await self.camera.start()
            except Exception as e:  # noqa: BLE001
                self.errors["camera"] = str(e)
                log.exception("camera start failed")
        if self.stage and self.stage.lost_position():
            log.warning("board position reset detected; call stage.restore_position to re-apply %s", self.stage._saved_hw)

        app = build_app(self.rpc, self.events, self.camera, self.cfg.webapp_dir, self.status)
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        site = web.TCPSite(runner, self.cfg.host, self.cfg.port)
        await site.start()
        log.info("openflexito %s listening on http://%s:%s", __version__, self.cfg.host or "[::]", self.cfg.port)

        status_task = asyncio.ensure_future(self.status_loop())
        stop = asyncio.Event()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, stop.set)
            except NotImplementedError:
                pass
        await stop.wait()
        log.info("shutting down")
        status_task.cancel()
        self.leds.set_state("off")
        if self.camera:
            await self.camera.stop()
        if self.stage:
            self.stage.close()
        await runner.cleanup()


async def _thread(fn, *args):
    return await asyncio.get_running_loop().run_in_executor(None, fn, *args)


async def _systemctl(action: str) -> dict:
    try:
        subprocess.Popen(["systemctl", action])
        return {"ok": True}
    except OSError as e:
        return {"ok": False, "error": str(e)}
