"""HTTP/WebSocket surface: static webapp, MJPEG streams, snapshot, raw capture, JSON-RPC."""

from __future__ import annotations

import asyncio
import json
import logging
from importlib import resources
from pathlib import Path

from aiohttp import WSMsgType, web

from .camera import CameraBase, FrameHub
from .events import EventBus
from .rpc import PARSE_ERROR, RpcRegistry

log = logging.getLogger(__name__)
BOUNDARY = "frame"


@web.middleware
async def cors_middleware(request: web.Request, handler):
    if request.method == "OPTIONS":
        resp = web.Response(status=204)
    else:
        resp = await handler(request)
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Expose-Headers"] = "X-Timestamp, X-Seq, X-Frame"
    return resp


def build_app(rpc: RpcRegistry, events: EventBus, camera: CameraBase | None, webapp_dir: Path | None,
              status_provider) -> web.Application:
    app = web.Application(middlewares=[cors_middleware])
    app["rpc"], app["events"], app["camera"], app["status"] = rpc, events, camera, status_provider

    app.router.add_get("/health", health)
    app.router.add_get("/rpc/schema", rpc_schema)
    app.router.add_post("/rpc", rpc_http)
    app.router.add_get("/ws", websocket)
    if camera is not None:
        async def stream_main(r): return await mjpeg(r, camera.main)
        async def stream_lores(r): return await mjpeg(r, camera.lores)
        app.router.add_get("/stream.mjpg", stream_main)
        app.router.add_get("/stream-lores.mjpg", stream_lores)
        app.router.add_get("/snapshot.jpg", snapshot)
        app.router.add_get("/raw.bin", raw)

    if webapp_dir and (webapp_dir / "index.html").is_file():
        async def index(r): return web.FileResponse(webapp_dir / "index.html")
        app.router.add_get("/", index)
        app.router.add_static("/assets", webapp_dir / "assets", show_index=False)
        # any other path: static file if it exists, else the SPA entry point
        async def spa(r):
            candidate = (webapp_dir / r.match_info["tail"]).resolve()
            if candidate.is_file() and webapp_dir.resolve() in candidate.parents:
                return web.FileResponse(candidate)
            return web.FileResponse(webapp_dir / "index.html")
        app.router.add_get("/{tail:.+}", spa)
        log.info("serving webapp from %s", webapp_dir)
    else:
        app.router.add_get("/", fallback_page)
        log.warning("no webapp build at %s; serving fallback page", webapp_dir)
    return app


async def health(request: web.Request) -> web.Response:
    return web.json_response(request.app["status"]())


async def rpc_schema(request: web.Request) -> web.Response:
    return web.json_response(request.app["rpc"].schema())


async def rpc_http(request: web.Request) -> web.Response:
    rpc: RpcRegistry = request.app["rpc"]
    try:
        message = await request.json()
    except (ValueError, UnicodeDecodeError):
        return web.json_response({"jsonrpc": "2.0", "id": None,
                                  "error": {"code": PARSE_ERROR, "message": "invalid JSON"}}, status=400)
    if isinstance(message, dict) and "id" not in message:
        message = {**message, "id": 1}  # HTTP callers always want an answer
    response = await rpc.handle(message)
    return web.json_response(response if response is not None else {"jsonrpc": "2.0", "id": None, "result": None})


async def websocket(request: web.Request) -> web.WebSocketResponse:
    rpc: RpcRegistry = request.app["rpc"]
    events: EventBus = request.app["events"]
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=4 * 1024 * 1024)
    await ws.prepare(request)
    queue = events.subscribe()
    hello = {"jsonrpc": "2.0", "method": "event.hello", "params": request.app["status"]()}
    await ws.send_str(json.dumps(hello))

    async def pump():
        try:
            while True:
                msg = await queue.get()
                await ws.send_str(json.dumps(msg))
        except (asyncio.CancelledError, ConnectionResetError):
            pass
        except Exception:  # noqa: BLE001  a dead pump would leave a silent client; log and close
            log.exception("websocket event pump failed")
            await ws.close()

    pump_task = asyncio.ensure_future(pump())
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except ValueError:
                    await ws.send_str(json.dumps({"jsonrpc": "2.0", "id": None,
                                                  "error": {"code": PARSE_ERROR, "message": "invalid JSON"}}))
                    continue
                items = data if isinstance(data, list) else [data]
                responses = [r for r in await asyncio.gather(*(rpc.handle(i) for i in items)) if r is not None]
                if responses:
                    await ws.send_str(json.dumps(responses if isinstance(data, list) else responses[0]))
            elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                break
    finally:
        pump_task.cancel()
        events.unsubscribe(queue)
    return ws


async def mjpeg(request: web.Request, hub: FrameHub) -> web.StreamResponse:
    resp = web.StreamResponse(status=200, headers={
        "Content-Type": f"multipart/x-mixed-replace; boundary={BOUNDARY}",
        "Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache", "Connection": "close",
        "Access-Control-Allow-Origin": "*",
    })
    await resp.prepare(request)
    hub.clients += 1
    if hub.on_clients:
        hub.on_clients(hub)
    request.app["status"](changed=True)
    last = hub.seq - 1 if hub.jpeg else hub.seq
    try:
        while True:
            jpeg, meta = await hub.next_frame(last)
            last = meta["seq"]
            header = (f"--{BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: {len(jpeg)}\r\n"
                      f"X-Seq: {meta['seq']}\r\nX-Timestamp: {meta.get('ts') or ''}\r\n"
                      f"X-Frame: {json.dumps(meta, separators=(',', ':'))}\r\n\r\n").encode()
            await resp.write(header + jpeg + b"\r\n")
    except (ConnectionResetError, asyncio.CancelledError, ConnectionError):
        pass
    finally:
        hub.clients -= 1
        if hub.on_clients:
            hub.on_clients(hub)
        request.app["status"](changed=True)
    return resp


async def snapshot(request: web.Request) -> web.Response:
    camera: CameraBase = request.app["camera"]
    full = request.query.get("full") in ("1", "true")
    jpeg = await camera.snapshot(full=full)
    if not jpeg:
        raise web.HTTPServiceUnavailable(text="no frame yet")
    meta = camera.main.meta
    return web.Response(body=jpeg, content_type="image/jpeg", headers={
        "Cache-Control": "no-store", "X-Seq": str(meta.get("seq", "")), "X-Timestamp": str(meta.get("ts") or ""),
        "X-Frame": json.dumps(meta, separators=(",", ":")),
    })


async def raw(request: web.Request) -> web.Response:
    camera: CameraBase = request.app["camera"]
    data = await camera.capture_raw()
    return web.Response(body=data, content_type="application/octet-stream",
                        headers={"Cache-Control": "no-store", "Content-Disposition": "inline; filename=raw.bin"})


async def fallback_page(request: web.Request) -> web.Response:
    html = resources.files("openflexito").joinpath("fallback/index.html").read_text()
    return web.Response(text=html, content_type="text/html")
