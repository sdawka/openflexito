import asyncio
import json

import pytest
from aiohttp.test_utils import TestClient, TestServer

from openflexito.camera import RAW_HEADER, RAW_MAGIC, FakeCamera
from openflexito.config import CameraConfig
from openflexito.events import EventBus
from openflexito.rpc import INVALID_PARAMS, METHOD_NOT_FOUND, RpcRegistry
from openflexito.web import build_app


async def test_registry_schema_and_dispatch():
    r = RpcRegistry()

    async def add(a: int, b: int = 1) -> int:
        """Add numbers."""
        return a + b
    r.register("math.add", add)
    schema = r.schema()["methods"][0]
    assert schema["name"] == "math.add" and schema["params"][1]["default"] == 1 and schema["doc"] == "Add numbers."
    assert await r.handle({"jsonrpc": "2.0", "id": 1, "method": "math.add", "params": {"a": 2}}) == {"jsonrpc": "2.0", "id": 1, "result": 3}
    assert (await r.handle({"id": 2, "method": "nope"}))["error"]["code"] == METHOD_NOT_FOUND
    assert (await r.handle({"id": 3, "method": "math.add", "params": {"zz": 1}}))["error"]["code"] == INVALID_PARAMS
    assert await r.handle({"method": "math.add", "params": [1, 2]}) is None  # notification


@pytest.fixture
async def client(tmp_path):
    events = EventBus()
    events.bind(asyncio.get_running_loop())
    cam = FakeCamera(CameraConfig(fake=True, stream_size=(160, 120), lores_size=(40, 30), full_size=(64, 48)),
                     tmp_path, events, fps=30)
    cam.bind(asyncio.get_running_loop())
    rpc = RpcRegistry()
    rpc.register("camera.set_controls", cam.set_controls)
    rpc.register("ping", lambda: "pong")
    status = lambda changed=False: {"led": "online", "clients": cam.main.clients}
    app = build_app(rpc, events, cam, None, status)
    await cam.start()
    async with TestClient(TestServer(app)) as c:
        yield c, cam, events
    await cam.stop()


async def test_http_rpc_and_schema(client):
    c, cam, _ = client
    r = await c.post("/rpc", json={"method": "ping"})
    assert (await r.json())["result"] == "pong"
    r = await c.get("/rpc/schema")
    assert [m["name"] for m in (await r.json())["methods"]] == ["camera.set_controls", "ping"]
    r = await c.get("/health")
    assert (await r.json())["led"] == "online"


async def test_websocket_hello_events_and_rpc(client):
    c, cam, events = client
    ws = await c.ws_connect("/ws")
    hello = json.loads((await ws.receive()).data)
    assert hello["method"] == "event.hello"
    await ws.send_json({"jsonrpc": "2.0", "id": 7, "method": "camera.set_controls", "params": {"ExposureTime": 1234}})
    got_frame = got_reply = False
    for _ in range(60):
        msg = json.loads((await ws.receive()).data)
        if msg.get("id") == 7:
            got_reply = msg["result"]["ExposureTime"] == 1234
        if msg.get("method") == "event.frame":
            got_frame = msg["params"]["size"] > 0 and "ts" in msg["params"]
        if got_frame and got_reply:
            break
    assert got_frame and got_reply
    await ws.close()


async def test_mjpeg_stream_and_snapshot(client):
    c, cam, _ = client
    async with c.get("/stream.mjpg") as r:
        assert r.headers["Content-Type"].startswith("multipart/x-mixed-replace")
        chunk = await r.content.readuntil(b"\r\n\r\n")
        assert b"X-Frame:" in chunk and b"Content-Length:" in chunk
        assert cam.main.clients == 1
    await asyncio.sleep(0.05)
    assert cam.main.clients == 0
    for _ in range(20):
        r = await c.get("/snapshot.jpg")
        if r.status == 200:
            break
        await asyncio.sleep(0.05)
    body = await r.read()
    assert body[:2] == b"\xff\xd8"
    r = await c.get("/snapshot.jpg?full=1")
    assert (await r.read())[:2] == b"\xff\xd8"


async def test_raw_capture_header(client):
    c, cam, _ = client
    r = await c.get("/raw.bin")
    data = await r.read()
    magic, w, h, depth, black, bayer = RAW_HEADER.unpack_from(data)
    assert magic == RAW_MAGIC and (w, h) == (64, 48) and depth == 10 and black == 64
    assert bayer.rstrip(b"\0") == b"BGGR"
    assert len(data) == RAW_HEADER.size + w * h * 2
