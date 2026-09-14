import asyncio
import json

import pytest
from aiohttp.test_utils import TestClient, TestServer

import numpy as np

from openflexito.camera import RAW_HEADER, RAW_MAGIC
from openflexito.rawfmt import decode_bracket, decode_raw, unpack_csi2p_10
from openflexito.fake_camera import FakeCamera
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
    still = json.loads(r.headers["X-Frame"])
    assert still["still"] is True and still["matched"] is True and (still["width"], still["height"]) == (64, 48)
    assert {"ts", "exposure", "gain", "digital_gain", "colour_gains", "lux", "frame_duration", "colour_temperature"} <= set(still)
    assert r.headers["X-Timestamp"] == str(still["ts"])


async def test_raw_capture_header(client):
    """The v1 header + pixel layout is unchanged; the v2 trailer follows the pixels and is echoed in X-Frame."""
    c, cam, _ = client
    r = await c.get("/raw.bin")
    data = await r.read()
    magic, w, h, depth, black, bayer = RAW_HEADER.unpack_from(data)
    assert magic == RAW_MAGIC and (w, h) == (64, 48) and depth == 10 and black == 64
    assert bayer.rstrip(b"\0") == b"BGGR"
    assert len(data) > RAW_HEADER.size + w * h * 2 and data[-4:] == b"OFRM"
    header, pixels, trailer = decode_raw(data)
    assert len(pixels) == w * h * 2 and trailer == json.loads(r.headers["X-Frame"])
    assert trailer["frames"] == 1 and trailer["bit_depth"] == 10 and trailer["white_level"] == 1023
    assert trailer["exposure"] == cam.controls["ExposureTime"] and len(trailer["ccm"]) == 9
    assert r.headers["X-Timestamp"] == str(trailer["ts"])


async def test_raw_multi_frame_average_reduces_noise(client):
    c, cam, _ = client
    r1 = await c.get("/raw.bin?frames=1")
    r8 = await c.get("/raw.bin?frames=8")
    assert r1.status == 200 and r8.status == 200
    _, p1, t1 = decode_raw(await r1.read())
    h8, p8, t8 = decode_raw(await r8.read())
    assert t8["frames"] == 8 and len(t8["frame_timestamps"]) == 8 and h8["bit_depth"] == 16 and h8["black_level"] == 4096
    a1 = np.frombuffer(p1, dtype="<u2").astype(float)
    a8 = np.frombuffer(p8, dtype="<u2").astype(float) / 64
    clean = cam._raw_mosaic().astype(float).ravel()  # a further noisy frame: the mean must be nearer the others' mean than one frame is
    assert np.std(a8 - clean) < np.std(a1 - clean)
    assert abs(a8.mean() - a1.mean()) < 2


async def test_raw_packed_and_flat_and_validation(client):
    c, cam, _ = client
    r = await c.get("/raw.bin?packed=1")
    header, pixels, trailer = decode_raw(await r.read())
    assert trailer["packed"] is True and len(pixels) == 64 * 48 * 5 // 4
    unpacked = unpack_csi2p_10(pixels, 64, 48)
    assert unpacked.max() <= 1023 and unpacked.min() >= 40
    r = await c.get("/flat.bin")
    header, pixels, trailer = decode_raw(await r.read())
    assert trailer["flat"] is True and trailer["frames"] == 4 and header["bit_depth"] == 16
    assert r.headers["Content-Disposition"].endswith("flat.bin")
    assert (await c.get("/raw.bin?frames=9")).status == 400
    assert (await c.get("/raw.bin?frames=2&packed=1")).status == 400
    assert (await c.get("/raw.bin?frames=x")).status == 400


async def test_bracket_endpoint(client):
    c, cam, _ = client
    await cam.set_controls(AeEnable=False, ExposureTime=4000)
    r = await c.get("/bracket.bin?factors=0.5,1,2")
    assert r.status == 200
    items = decode_bracket(await r.read())
    summary = json.loads(r.headers["X-Frame"])
    assert summary["count"] == 3 and summary["exposures"] == [2000, 4000, 8000] and len(summary["frames"]) == 3
    assert [m["exposure"] for m, _ in items] == [2000, 4000, 8000]
    assert all(d[:2] == b"\xff\xd8" and m["kind"] == "jpeg" and m["still"] for m, d in items)
    r = await c.get("/bracket.bin?factors=1,2&raw=1")
    items = decode_bracket(await r.read())
    for meta, rec in items:
        header, pixels, trailer = decode_raw(rec)
        assert header["bit_depth"] == 10 and trailer["exposure"] == meta["exposure"] and meta["kind"] == "raw"
    assert (await c.get("/bracket.bin?factors=1,2,3,4,5,6,7,8,9")).status == 400
    assert (await c.get("/bracket.bin?factors=abc")).status == 400
