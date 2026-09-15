"""Composition: hardware, RPC methods, status/LED state machine, HTTP server."""

from __future__ import annotations

import asyncio
import json
import logging
import signal
from pathlib import Path

from aiohttp import web

from . import __version__
from .camera import CameraBase, make_camera
from .config import Config
from .events import EventBus
from .leds import LedController
from . import logbuf
from .netwatch import network_state, wifi_join, wifi_scan
from .power import PowerController
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
        self.net: dict = {"state": "unknown", "ip": None, "connections": [], "link": "none", "interface": None, "link_local": False, "speed_mbit": None, "interfaces": []}
        self.led_state = "booting"
        self._status_dirty = asyncio.Event()
        self.events.on_change = lambda n: self.status(changed=True)
        self.leds.set_state("booting")
        self.power = PowerController(self)

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
                                   cfg.stage.poll_interval, cfg.stage.release_after)
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
            "power": self.power.status(),
        }

    def _compute_led_state(self) -> str:
        if not self.power.on:
            return "off"
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
                self.net = await network_state(self.cfg.hotspot_connection, fake=self.cfg.camera.fake)
            except Exception as e:  # noqa: BLE001
                log.debug("network state failed: %s", e)
            new = self._compute_led_state()
            if new != self.led_state:
                self.led_state = new
                self.leds.set_state(new)
                self.events.publish("status", {"led": new, "network": self.net, "errors": self.errors})
            try:  # nmcli costs ~0.3 s of a Pi 3 core per poll; changes wake the loop early via _status_dirty
                await asyncio.wait_for(self._status_dirty.wait(), timeout=10.0)
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
        r.register("system.reboot", lambda: _thread(logbuf.request, self.cfg.state_dir, "reboot"), "Reboot the device.")
        r.register("system.shutdown", lambda: _thread(logbuf.request, self.cfg.state_dir, "poweroff"), "Power off the device.")

        async def system_logs(lines: int = 200, level: str = "INFO", source: str = "journal") -> dict:
            """Recent logs. source: 'journal' (persistent, includes crashes, survives reboots) or
            'app' (in-memory structured records). level: DEBUG|INFO|WARNING|ERROR|CRITICAL."""
            lines = max(1, min(int(lines), 5000))
            if source == "app":
                return {"source": "app", "records": logbuf.ring.tail(lines, level)}
            text = await _thread(logbuf.journal_tail, lines, level)
            usage = await _thread(logbuf.journal_usage)
            return {"source": "journal", "lines": text, "disk_usage": usage}

        async def system_clear_logs() -> dict:
            """Clear the in-memory records and delete the persistent journal for this device."""
            logbuf.ring.clear()
            result = await _thread(logbuf.journal_clear, self.cfg.state_dir)
            log.info("logs cleared by client (%s)", result)
            return {"journal": result}

        r.register("system.logs", system_logs)
        r.register("system.clear_logs", system_clear_logs)

        r.register("power.get", self.power.get, "Current power state: on, since, idle_minutes, idle_in.")
        r.register("power.set", self.power.set, "Switch standby on or off.")
        r.register("power.toggle", self.power.toggle, "Flip standby (what a physical power button calls).")
        r.register("power.activity", self.power.activity,
                   "WS heartbeat: declare this connection active/inactive so it can hold off auto standby.")
        r.register("power.set_idle", self.power.set_idle, "Set the auto-standby timeout in minutes (0 disables it).")

        g = self.power.guard  # camera/stage RPCs refuse with a clear error while in standby; mutating
                               # ones (the default) also count as activity for the idle timer

        if st is not None:
            r.register("stage.status", g(st.status, mutating=False), "Position, backlash, inversion, firmware.")
            r.register("stage.position", g(lambda: st.position, mutating=False), "Current position in program frame (steps).")
            r.register("stage.move_rel", g(st.move_rel), "Relative move in steps; compensate=false skips backlash handling.")
            r.register("stage.move_to", g(st.move_to), "Absolute move in program frame; omitted axes stay.")
            r.register("stage.jog", g(st.jog), "Newest-wins relative move without backlash compensation (cancels a running jog).")
            r.register("stage.stop", g(st.stop), "Abort the current move.")
            r.register("stage.release", g(st.release), "De-energise motor coils now.")
            r.register("stage.set_release_after", g(st.set_release_after), "Idle seconds before coils are released automatically (0 = hold for ever).")
            r.register("stage.zero", g(st.zero), "Set the current position as 0 0 0.")
            r.register("stage.restore_position", g(lambda: st.restore_position()), "Re-apply the last saved position after a board power cycle.")
            r.register("stage.set_backlash", g(st.set_backlash), "Set backlash steps per axis.")
            r.register("stage.set_inverted", g(st.set_inverted), "Set axis inversion (hardware -> program frame).")
            r.register("stage.set_step_time", g(lambda us: _thread(st.board.set_step_time, int(us))), "Set minimum step delay in microseconds.")

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
            try:
                self._light_channels = st.board.led_channels()  # e.g. {"cc": 1, "pwm": 2}: the PWM outputs can drive extra LEDs
            except SangaboardError as e:
                log.warning("led_channels? failed: %s", e)
                self._light_channels = {"cc": 1, "pwm": 0}
            r.register("light.set", g(light_set), "Set illumination (counts as activity; refused while in standby).")
            r.register("light.get", self._light_dict, "Last set illumination values plus the board's channel counts.")

        if cam is not None:
            r.register("camera.status", g(cam.status, mutating=False), "Sensor, stream size, controls, client count.")
            r.register("camera.get_controls", g(cam.get_controls, mutating=False), "Persistent libcamera controls.")
            r.register("camera.set_controls", g(cam.set_controls),
                       "Set controls: ExposureTime (us), AnalogueGain, ColourGains [r,b], AeEnable, AwbEnable, Brightness, Contrast, Saturation, Sharpness.")
            r.register("camera.get_tuning", g(cam.get_tuning, mutating=False), "Current libcamera tuning JSON.")
            r.register("camera.set_tuning", g(cam.set_tuning), "Replace the tuning JSON and restart the camera.")
            r.register("camera.reset_tuning", g(cam.reset_tuning), "Restore the bundled tuning file.")
            r.register("camera.set_stream_size", g(cam.set_stream_size), "Change stream resolution (width, height).")
            r.register("camera.metadata", g(cam.capture_metadata, mutating=False), "Latest libcamera request metadata.")
            r.register("camera.set_still_clean", g(cam.set_still_clean),
                       "Stills only (full-res JPEG, RAW, brackets): ISP denoise off and Sharpness 0 when enabled.")

    def _light_dict(self) -> dict:
        ch = getattr(self, "_light_channels", {"cc": 1, "pwm": 0})
        pwm = [self._light["pwm"].get(i, 0.0) for i in range(max(int(ch.get("pwm", 0)), len(self._light["pwm"])))]
        return {"cc": self._light["cc"], "pwm": pwm, "channels": ch}

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
        logbuf.install_loop_hook(asyncio.get_running_loop())
        loop = asyncio.get_running_loop()
        self.events.bind(loop)
        self.open_hardware()
        self.register_rpc()
        if self.camera:
            self.camera.bind(loop)
            if self.power.on:
                try:
                    await self.camera.start()
                except Exception as e:  # noqa: BLE001
                    self.errors["camera"] = str(e)
                    log.exception("camera start failed")
        if self.stage and not self.power.on:
            await self.stage.release()
        if self.stage and self.stage.lost_position():
            log.warning("board position reset detected; call stage.restore_position to re-apply %s", self.stage._saved_hw)

        app = build_app(self.rpc, self.events, self.camera, self.cfg.webapp_dir, self.status, power=self.power)
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        site = web.TCPSite(runner, self.cfg.host, self.cfg.port)
        await site.start()
        log.info("openflexito %s listening on http://%s:%s", __version__, self.cfg.host or "[::]", self.cfg.port)

        status_task = asyncio.ensure_future(self.status_loop())
        idle_task = asyncio.ensure_future(self.power.idle.run())
        stop = asyncio.Event()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, stop.set)
            except NotImplementedError:
                pass
        await stop.wait()
        log.info("shutting down")
        status_task.cancel()
        idle_task.cancel()
        self.leds.set_state("off")
        if self.camera:
            await self.camera.stop()
        if self.stage:
            self.stage.close()
        await runner.cleanup()


async def _thread(fn, *args):
    return await asyncio.get_running_loop().run_in_executor(None, fn, *args)

