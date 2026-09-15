"""Standby: camera stopped, illumination remembered and off, stage released, image endpoints 503,
camera/stage RPCs refused, all reversed on wake. Uses the real Device wiring (--fake camera + stage)
so the RPC/HTTP surface matches production."""
import asyncio
import json
import types

import pytest
from aiohttp.test_utils import TestClient, TestServer

from openflexito.app import Device
from openflexito.config import CameraConfig, Config, StageConfig
from openflexito.web import build_app


@pytest.fixture
async def device(tmp_path):
    cfg = Config(
        state_dir=tmp_path, webapp_dir=None, led_path=tmp_path / "no-led",
        camera=CameraConfig(fake=True, stream_size=(160, 120), lores_size=(40, 30), full_size=(64, 48)),
        stage=StageConfig(fake=True, poll_interval=0.005),
    )
    dev = Device(cfg)
    loop = asyncio.get_running_loop()
    dev.events.bind(loop)
    dev.open_hardware()
    dev.register_rpc()
    dev.camera.bind(loop)
    await dev.camera.start()
    yield dev
    if dev.camera:
        await dev.camera.stop()
    if dev.stage:
        dev.stage.close()


@pytest.fixture
async def client(device):
    app = build_app(device.rpc, device.events, device.camera, None, device.status, power=device.power)
    async with TestClient(TestServer(app)) as c:
        yield c


async def test_status_shape_includes_power(device):
    s = device.status()["power"]
    assert s["on"] is True and s["idle_minutes"] == 10.0 and s["reason"] == "request"
    assert 590 <= s["idle_in"] <= 600  # ~10 minutes, just started
    assert isinstance(s["since"], int) and s["since"] > 0


async def test_toggle_round_trip(device):
    r1 = await device.rpc.call("power.toggle", None)
    assert r1["on"] is False and r1["since"] >= device.power.since - 1
    assert device.camera.status()["fake"] is True
    assert not device.camera._thread.is_alive()  # stopped
    assert device.stage._energised is False  # released

    r2 = await device.rpc.call("power.toggle", None)
    assert r2["on"] is True
    assert device.camera._thread is not None and device.camera._thread.is_alive()  # restarted


async def test_power_get_and_set(device):
    got = await device.rpc.call("power.get", None)
    assert got["on"] is True and got["since"] == device.power.since
    off = await device.rpc.call("power.set", {"on": False})
    assert off["on"] is False and off["idle_in"] == -1  # no auto standby while already off
    same = await device.rpc.call("power.set", {"on": False})  # no-op, doesn't error
    assert same["on"] is False and same["since"] == off["since"]


async def test_illumination_remembered_and_restored(device):
    await device.rpc.call("light.set", {"cc": 0.75, "pwm": [0.5]})
    await device.rpc.call("power.set", {"on": False})
    board_led = device.stage.board._t.led  # FakeTransport's recorded LED state
    assert board_led["cc"] == 0.0
    assert board_led["pwm"][0] == 0.0

    await device.rpc.call("power.set", {"on": True})
    assert board_led["cc"] == 0.75
    assert board_led["pwm"][0] == 0.5
    assert (await device.rpc.call("light.get", None))["cc"] == 0.75


async def test_camera_and_stage_rpcs_refused_while_off(device):
    await device.rpc.call("power.set", {"on": False})
    with pytest.raises(RuntimeError, match="standby"):
        await device.rpc.call("camera.status", None)
    with pytest.raises(RuntimeError, match="standby"):
        await device.rpc.call("stage.move_rel", {"x": 10})
    # power.* and system.* keep working
    assert (await device.rpc.call("power.get", None))["on"] is False
    assert (await device.rpc.call("system.status", None))["power"]["on"] is False


async def test_image_endpoints_503_while_off(client, device):
    r = await client.get("/snapshot.jpg")
    assert r.status != 503
    await device.rpc.call("power.set", {"on": False})
    for path in ("/snapshot.jpg", "/raw.bin", "/flat.bin", "/bracket.bin"):
        r = await client.get(path)
        assert r.status == 503, path
    async with client.get("/stream.mjpg") as r:
        assert r.status == 503

    await device.rpc.call("power.set", {"on": True})
    for _ in range(20):
        r = await client.get("/snapshot.jpg")
        if r.status == 200:
            break
        await asyncio.sleep(0.05)
    assert r.status == 200


async def test_rpc_schema_keeps_real_param_types(device):
    schema = {m["name"]: m for m in device.rpc.schema()["methods"]}
    assert schema["stage.move_rel"]["params"][0]["name"] == "x"
    assert schema["power.set"]["params"][0]["name"] == "on"


async def test_reason_persists_in_status_and_across_restart(device, tmp_path):
    """A tab that connects *after* the device has already gone to standby (the common case: it was
    asleep too) must still see why - so `reason` lives in the persisted status, not just the event
    published at the moment of the transition."""
    await device.rpc.call("power.set", {"on": False, "reason": "idle"})
    assert device.power.status()["reason"] == "idle"
    assert (await device.rpc.call("power.get", None))["reason"] == "idle"
    assert (await device.rpc.call("system.status", None))["power"]["reason"] == "idle"
    saved = json.loads((tmp_path / "power.json").read_text())
    assert saved["reason"] == "idle"

    # a fresh PowerController (as after a service restart) picks the persisted reason back up
    from openflexito.power import PowerController
    fresh = PowerController(types.SimpleNamespace(cfg=device.cfg))
    assert fresh.on is False and fresh.reason == "idle"


async def test_idle_in_is_sane_immediately_after_wake(device):
    await device.rpc.call("power.set", {"on": False})
    r = await device.rpc.call("power.set", {"on": True})
    assert r["idle_in"] >= int(device.power.idle.minutes * 60) - 1  # not -1, not stuck at 0


# ---- auto standby (idle timer) ---------------------------------------------------------------

IDLE_S = 3.0            # the short "idle_minutes" used for tests, in seconds
MARGIN_S = IDLE_S + 0.6  # comfortably past the threshold + poll interval
BEFORE_S = IDLE_S - 1.5  # comfortably before it


@pytest.fixture
async def idle_watching(device):
    """Runs the background idle-check loop (normally started by Device.run()) against a short
    timeout so tests don't sleep for real minutes."""
    device.power.idle.minutes = IDLE_S / 60
    device.power.idle.bump()  # start the window fresh, not from whenever the device fixture built
    task = asyncio.ensure_future(device.power.idle.run())
    yield device
    task.cancel()


async def _next_event(queue: asyncio.Queue, method: str, *, tries: int = 500, timeout: float = 3.0) -> dict:
    """The event bus also carries frame/position/light traffic; skip to the first message matching
    `method` (or raise on timeout)."""
    for _ in range(tries):
        msg = await asyncio.wait_for(queue.get(), timeout=timeout)
        if msg.get("method") == method:
            return msg
    raise AssertionError(f"no {method} event seen in {tries} messages")


async def _ws_call(ws, method: str, params: dict, req_id: int = 1) -> dict:
    """Send one RPC over an open WebSocket and return its result, skipping interleaved events."""
    await ws.send_json({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
    for _ in range(500):
        msg = json.loads((await asyncio.wait_for(ws.receive(), timeout=3.0)).data)
        if msg.get("id") == req_id:
            return msg["result"]
    raise AssertionError(f"no reply to {method}")


async def test_auto_standby_after_idle(idle_watching):
    dev = idle_watching
    await asyncio.sleep(MARGIN_S)
    assert dev.power.on is False


async def test_read_only_rpcs_do_not_reset_the_idle_timer(idle_watching):
    dev = idle_watching
    for _ in range(6):
        try:
            await dev.rpc.call("stage.status", None)  # read-only: must not hold the device awake
        except RuntimeError:
            break  # it already idled out under load; that's the assertion below
        await asyncio.sleep(MARGIN_S / 6)
    assert dev.power.on is False


async def test_mutating_rpc_resets_the_idle_timer(idle_watching):
    dev = idle_watching
    for _ in range(6):
        await dev.rpc.call("stage.jog", {"x": 1})  # mutating: keeps bumping the timer
        await asyncio.sleep(BEFORE_S / 3)
    assert dev.power.on is True
    await asyncio.sleep(MARGIN_S)  # no more activity now: it does trip eventually
    assert dev.power.on is False


async def test_idle_standby_does_not_refire_once_already_off(idle_watching):
    dev = idle_watching
    r = await dev.rpc.call("power.set", {"on": False})  # already off, manually, before the timer trips
    await asyncio.sleep(MARGIN_S)
    assert dev.power.on is False
    assert dev.power.since == r["since"]  # the idle loop never re-triggered a transition


async def test_wake_resets_the_idle_countdown(idle_watching):
    dev = idle_watching
    await asyncio.sleep(MARGIN_S)
    assert dev.power.on is False  # auto standby tripped
    await dev.rpc.call("power.set", {"on": True})  # manual wake
    await asyncio.sleep(BEFORE_S)
    assert dev.power.on is True  # must not immediately re-trip
    await asyncio.sleep(MARGIN_S - BEFORE_S + 0.6)
    assert dev.power.on is False  # but does trip again after a fresh idle window


async def test_status_event_carries_reason(device):
    queue = device.events.subscribe()
    await device.rpc.call("power.set", {"on": False})
    msg = await _next_event(queue, "event.status")
    assert msg["params"]["power"]["reason"] == "request"
    device.events.unsubscribe(queue)


async def test_idle_reason_on_auto_standby(idle_watching):
    dev = idle_watching
    queue = dev.events.subscribe()
    msg = await _next_event(queue, "event.status", timeout=MARGIN_S + 1)
    assert msg["params"]["power"]["reason"] == "idle"
    dev.events.unsubscribe(queue)


async def test_set_idle_persists_and_reports_in_status(device, tmp_path):
    r = await device.rpc.call("power.set_idle", {"minutes": 0.5})
    assert r["idle_minutes"] == 0.5
    assert (await device.rpc.call("system.status", None))["power"]["idle_minutes"] == 0.5
    saved = json.loads((tmp_path / "power.json").read_text())
    assert saved["idle_minutes"] == 0.5


async def test_set_idle_zero_disables_auto_standby(idle_watching):
    dev = idle_watching
    await dev.rpc.call("power.set_idle", {"minutes": 0})
    await asyncio.sleep(MARGIN_S)
    assert dev.power.on is True
    assert (await dev.rpc.call("power.get", None))["idle_in"] == -1


# ---- WebSocket activity heartbeat -------------------------------------------------------------

async def test_ws_activity_hold_keeps_device_awake(idle_watching, client):
    ws = await client.ws_connect("/ws")
    await ws.receive()  # event.hello
    await _ws_call(ws, "power.activity", {"active": True})
    await asyncio.sleep(MARGIN_S)  # longer than idle_minutes, but the hold should keep it awake
    assert idle_watching.power.on is True
    await ws.close()
    await asyncio.sleep(MARGIN_S)  # the hold is dropped on disconnect: it now trips
    assert idle_watching.power.on is False


async def test_ws_activity_false_stops_holding(idle_watching, client):
    ws = await client.ws_connect("/ws")
    await ws.receive()
    await _ws_call(ws, "power.activity", {"active": True})
    await _ws_call(ws, "power.activity", {"active": False}, req_id=2)
    await asyncio.sleep(MARGIN_S)
    assert idle_watching.power.on is False
    await ws.close()


async def test_open_stream_connection_alone_does_not_hold_it_awake(idle_watching, client):
    dev = idle_watching
    async with client.get("/stream.mjpg") as r:
        assert r.status == 200
        await asyncio.sleep(MARGIN_S)  # the open connection, with no heartbeat, must not hold it awake
    assert dev.power.on is False


async def test_snapshot_fetch_counts_as_activity(idle_watching, client):
    dev = idle_watching
    for _ in range(6):
        r = await client.get("/snapshot.jpg")
        if r.status == 503:
            break  # it already idled out under load; that's the assertion below
        assert r.status == 200
        await asyncio.sleep(BEFORE_S / 3)
    else:
        assert dev.power.on is True  # repeated fetches kept resetting the timer
    await asyncio.sleep(MARGIN_S)  # stop fetching: it does trip once idle
    assert dev.power.on is False
