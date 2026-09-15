"""Standby: camera stopped, illumination remembered and off, stage released, image endpoints 503,
camera/stage RPCs refused, all reversed on wake. Uses the real Device wiring (--fake camera + stage)
so the RPC/HTTP surface matches production."""
import asyncio

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
    s = device.status()
    assert s["power"] == {"on": True, "since": device.power.since}
    assert isinstance(s["power"]["since"], int) and s["power"]["since"] > 0


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
    assert got == {"on": True, "since": device.power.since}
    off = await device.rpc.call("power.set", {"on": False})
    assert off["on"] is False
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
