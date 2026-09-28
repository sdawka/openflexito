"""HTTP/WebSocket surface: static webapp, MJPEG streams, snapshot, raw capture, H.264 recording, the
fast JPEG + z-sweep stream for live extended depth of field (`/edof.bin`), JSON-RPC."""

from __future__ import annotations

import asyncio
import json
import logging
import struct
import threading
from importlib import resources
from pathlib import Path

from aiohttp import WSMsgType, web

from .camera import CameraBase, FrameHub
from .events import EventBus
from .power import CURRENT_CONN
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
    resp.headers["Access-Control-Expose-Headers"] = "X-Timestamp, X-Seq, X-Frame, X-Record, X-Edof"
    return resp


def build_app(rpc: RpcRegistry, events: EventBus, camera: CameraBase | None, webapp_dir: Path | None,
              status_provider, power=None, stage=None) -> web.Application:
    app = web.Application(middlewares=[cors_middleware])
    app["rpc"], app["events"], app["camera"], app["status"], app["power"] = rpc, events, camera, status_provider, power
    app["stage"] = stage

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
        app.router.add_get("/flat.bin", flat)
        app.router.add_get("/bracket.bin", bracket)
        app.router.add_get("/record.h264", record)
        app.router.add_get("/edof.bin", edof)

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
    power = request.app["power"]
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
                # tells power.activity() (an RPC, with no connection identity of its own) which
                # WebSocket is calling, so its heartbeat hold is tracked per connection
                token = CURRENT_CONN.set(ws)
                try:
                    responses = [r for r in await asyncio.gather(*(rpc.handle(i) for i in items)) if r is not None]
                finally:
                    CURRENT_CONN.reset(token)
                if responses:
                    await ws.send_str(json.dumps(responses if isinstance(data, list) else responses[0]))
            elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                break
    finally:
        pump_task.cancel()
        events.unsubscribe(queue)
        if power is not None:
            power.idle.on_disconnect(ws)  # drop this connection's heartbeat hold, if any
    return ws


def _require_power(request: web.Request) -> None:
    """The image endpoints refuse with 503 while the device is in standby (power.py)."""
    power = request.app["power"]
    if power is not None and not power.on:
        raise web.HTTPServiceUnavailable(text="device is in standby")


def _require_not_recording(request: web.Request) -> None:
    """Stills, RAW and brackets switch the camera mode, which a running recording holds."""
    camera: CameraBase = request.app["camera"]
    if camera.recording is not None:
        raise web.HTTPConflict(text="a video recording is running; stop it first")
    if camera.fast is not None:
        raise web.HTTPConflict(text="live extended focus is running; stop it first")


def _bump_activity(request: web.Request) -> None:
    """A still/raw/bracket fetch is a discrete user action (unlike the mere existence of an MJPEG
    stream connection, which does not count - power.py's module docstring) so it resets the
    auto-standby idle timer."""
    power = request.app["power"]
    if power is not None:
        power.idle.bump()


async def mjpeg(request: web.Request, hub: FrameHub) -> web.StreamResponse:
    _require_power(request)
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


def _frame_headers(meta: dict, extra: dict | None = None) -> dict:
    return {"Cache-Control": "no-store", "X-Seq": str(meta.get("seq", "")), "X-Timestamp": str(meta.get("ts") or ""),
            "X-Frame": json.dumps(meta, separators=(",", ":")), **(extra or {})}


async def snapshot(request: web.Request) -> web.Response:
    """Latest stream frame, or with `full=1` a full-resolution still. `X-Frame` carries the frame's
    own metadata: for a still that is the still request's metadata plus `still: true`."""
    _require_power(request)
    _bump_activity(request)
    camera: CameraBase = request.app["camera"]
    full = request.query.get("full") in ("1", "true")
    if full:
        _require_not_recording(request)
        try:
            jpeg, meta = await camera.still()
        except RuntimeError as e:
            raise web.HTTPServiceUnavailable(text=str(e))
        meta = {**meta, "seq": camera.main.meta.get("seq", "")}
    else:
        jpeg = await camera.snapshot(full=False)
        meta = camera.main.meta
    if not jpeg:
        raise web.HTTPServiceUnavailable(text="no frame yet")
    return web.Response(body=jpeg, content_type="image/jpeg", headers=_frame_headers(meta))


def _int_query(request: web.Request, name: str, default: int) -> int:
    try:
        return int(request.query.get(name, default))
    except ValueError:
        raise web.HTTPBadRequest(text=f"{name} must be an integer")


async def _raw_response(request: web.Request, flat: bool, default_frames: int, filename: str) -> web.Response:
    _require_power(request)
    _require_not_recording(request)
    _bump_activity(request)
    camera: CameraBase = request.app["camera"]
    frames = _int_query(request, "frames", default_frames)
    packed = request.query.get("packed") in ("1", "true")
    try:
        data, trailer = await camera.capture_raw(frames=frames, packed=packed, flat=flat)
    except ValueError as e:
        raise web.HTTPBadRequest(text=str(e))
    except RuntimeError as e:
        raise web.HTTPServiceUnavailable(text=str(e))
    return web.Response(body=data, content_type="application/octet-stream",
                        headers=_frame_headers(trailer, {"Content-Disposition": f"inline; filename={filename}"}))


async def raw(request: web.Request) -> web.Response:
    """OFRW v2 raw record. `frames=N` (1..max_raw_frames) averages N mosaics captured in one mode
    switch (16-bit result); `packed=1` returns CSI2P 10-bit packing (single frame only). The JSON
    trailer is repeated in `X-Frame`. Layout: rawfmt.py."""
    return await _raw_response(request, flat=False, default_frames=1, filename="raw.bin")


async def flat(request: web.Request) -> web.Response:
    """Flat-field capture: the same multi-frame averaged raw as `/raw.bin?frames=N` (default 4) with
    `flat: true` in the trailer; take it with the sample removed, the browser derives gain maps."""
    return await _raw_response(request, flat=True, default_frames=4, filename="flat.bin")


async def bracket(request: web.Request) -> web.Response:
    """Exposure bracket: `factors=0.5,1,2` (x current exposure), `raw=1` for OFRW items instead of
    JPEG. One mode switch, gain and colour gains locked. OFBK container (rawfmt.py); `X-Frame`
    carries the summary (factors, exposures, per-frame metadata)."""
    _require_power(request)
    _require_not_recording(request)
    _bump_activity(request)
    camera: CameraBase = request.app["camera"]
    try:
        factors = [float(x) for x in request.query.get("factors", "0.5,1,2").split(",") if x.strip()]
    except ValueError:
        raise web.HTTPBadRequest(text="factors must be comma-separated numbers")
    raw_items = request.query.get("raw") in ("1", "true")
    try:
        data, summary = await camera.capture_bracket(factors, raw=raw_items)
    except ValueError as e:
        raise web.HTTPBadRequest(text=str(e))
    except RuntimeError as e:
        raise web.HTTPServiceUnavailable(text=str(e))
    return web.Response(body=data, content_type="application/octet-stream",
                        headers=_frame_headers(summary, {"Content-Disposition": "inline; filename=bracket.bin"}))


RECORD_MAGIC = b"OFVP"
RECORD_HEADER = struct.Struct("<4sIqI")  # magic, payload length, timestamp ns (-1 = unknown), flags (bit 0 = keyframe)


async def record(request: web.Request) -> web.StreamResponse:
    """Video recording: the camera switches to its recording configuration (config.py
    `record_*`) for as long as this response is being read, and every H.264 access unit the
    hardware encoder produces is written as `RECORD_HEADER` + Annex B payload. `X-Record` describes
    the stream (codec, size, fps, bitrate, keyframe period). Closing the connection ends the
    recording, so a crashed tab can never leave the camera in the recording mode. Query: `fps`
    (1..record_max_fps, default max), `bitrate` in bit/s (default max), `keyframe` seconds (default 1)."""
    _require_power(request)
    _bump_activity(request)
    camera: CameraBase = request.app["camera"]
    try:
        fps = int(request.query.get("fps", camera.cfg.record_max_fps))
        bitrate = int(request.query.get("bitrate", camera.cfg.record_max_bitrate))
        keyframe = float(request.query.get("keyframe", 1))
    except ValueError:
        raise web.HTTPBadRequest(text="fps and bitrate must be integers, keyframe a number")
    try:
        tap, info = await camera.start_recording(fps, bitrate, keyframe)
    except RuntimeError as e:
        raise web.HTTPConflict(text=str(e))
    request.app["status"](changed=True)
    resp = web.StreamResponse(status=200, headers={
        "Content-Type": "application/octet-stream", "Cache-Control": "no-cache, no-store", "Connection": "close",
        "X-Record": json.dumps(info, separators=(",", ":")),
    })
    try:
        await resp.prepare(request)
        while True:
            item = await tap.queue.get()
            if item is None:
                if tap.overflowed:
                    log.warning("recording ended: the client fell %d packets behind", tap.MAX_QUEUED)
                break
            data, ts_ns, key = item
            await resp.write(RECORD_HEADER.pack(RECORD_MAGIC, len(data), -1 if ts_ns is None else int(ts_ns), 1 if key else 0) + data)
    except (ConnectionResetError, asyncio.CancelledError, ConnectionError):
        pass
    finally:
        await camera.stop_recording()
        request.app["status"](changed=True)
    return resp


EDOF_MAGIC = b"OFES"
# magic | u8 type | 3 pad | u32 payload length | i64 time ns (-1 unknown) | u32 frame seq
EDOF_HEADER = struct.Struct("<4sBxxxIqI")
EDOF_FRAME, EDOF_LEG, EDOF_LEG_END, EDOF_STATUS = 1, 2, 3, 4
EDOF_MAX_STEPS = 10_000  # per leg; a typo'd sweep must not drive the objective into the slide
EDOF_STALL_S = 2.0  # no frame for this long = the camera stalled: end the response (and the sweeps)


async def edof(request: web.Request) -> web.StreamResponse:
    """Live extended depth of field. While this response is being read the camera runs a fast
    sensor mode (config.py `fast_modes`) and, with `steps`, the stage sweeps z back and forth by
    that many motor steps per leg (stage.py `oscillate`, the first leg +steps from the current z).
    `X-Edof` describes the stream ({codec, mode, width, height, fps, bitrate, sensor_size, started,
    steps, step_us, backlash_z}). The body is a sequence of `EDOF_HEADER` records whose seq is the
    running frame counter: type 1 = one JPEG frame (time = SensorTimestamp), 2 = a sweep leg
    started, 3 = it ended (JSON from `oscillate`, plus the frames `dropped` so far because the
    reader fell behind), 4 = status (JSON: {error} if the sweeps failed, {sweeps_stopped, legs} if
    stage.stop or standby ended them while the camera carries on; {error: "no frames from the
    camera"} just before the response ends, when no frame came for `EDOF_STALL_S`). All image maths
    happens in the browser; closing the connection stops the sweeps, returns z to where they started
    and restores the stream mode; standby or a stalled camera ends the response. Query: `mode`
    (crop|full), `fps`, `bitrate`, `steps` (0 = camera only)."""
    _require_power(request)
    _bump_activity(request)
    camera: CameraBase = request.app["camera"]
    stage = request.app["stage"]
    try:
        mode = request.query.get("mode", "crop")
        fps = int(request.query["fps"]) if "fps" in request.query else None
        bitrate = int(request.query["bitrate"]) if "bitrate" in request.query else None
        steps = int(request.query.get("steps", 0))
    except ValueError:
        raise web.HTTPBadRequest(text="fps, bitrate and steps must be integers")
    if abs(steps) > EDOF_MAX_STEPS:
        raise web.HTTPBadRequest(text=f"steps must be within ±{EDOF_MAX_STEPS}")
    if steps:
        if stage is None:
            raise web.HTTPConflict(text="no stage to sweep")
        if stage.moving or stage.oscillating:
            raise web.HTTPConflict(text="the stage is moving")
    try:
        tap, info = await camera.start_fast(mode, fps, bitrate)
    except ValueError as e:
        raise web.HTTPBadRequest(text=str(e))
    except RuntimeError as e:
        raise web.HTTPConflict(text=str(e))
    stop = threading.Event()
    sweeps = None
    seq = 0
    # from here on everything is inside try/finally: whatever fails, the camera must leave the
    # fast mode and the stage must stop sweeping
    try:
        info = {**info, "steps": steps, "step_us": stage.board.info.step_time_us if stage else None,
                "backlash_z": stage.backlash.get("z") if stage else None}
        if steps:
            sweeps = asyncio.ensure_future(stage.oscillate(steps, lambda rec: tap.put_threadsafe((rec["type"], rec)), stop))

            def ended(f: asyncio.Future) -> None:
                if f.cancelled():
                    return
                if f.exception() is not None:
                    tap.put_threadsafe(("status", {"error": f"z sweep stopped: {f.exception()}"}))
                elif not stop.is_set():  # stage.stop / standby, not this client closing
                    tap.put_threadsafe(("status", {"sweeps_stopped": True, "legs": f.result()["legs"]}))
            sweeps.add_done_callback(ended)
        request.app["status"](changed=True)
        resp = web.StreamResponse(status=200, headers={
            "Content-Type": "application/octet-stream", "Cache-Control": "no-cache, no-store", "Connection": "close",
            "X-Edof": json.dumps(info, separators=(",", ":")),
        })
        kinds = {"leg": EDOF_LEG, "leg_end": EDOF_LEG_END, "status": EDOF_STATUS}
        await resp.prepare(request)
        loop = asyncio.get_running_loop()
        last_frame = loop.time()
        while True:
            try:
                item = await asyncio.wait_for(tap.get(), max(0.0, last_frame + EDOF_STALL_S - loop.time()))
            except asyncio.TimeoutError:
                # a stalled camera would otherwise keep the stage sweeping until the client left
                log.warning("live extended focus: no frame for %.1f s, ending the stream", EDOF_STALL_S)
                payload = json.dumps({"error": "no frames from the camera", "dropped": tap.dropped},
                                     separators=(",", ":")).encode()
                await resp.write(EDOF_HEADER.pack(EDOF_MAGIC, EDOF_STATUS, len(payload), -1, seq) + payload)
                break
            if item is None:  # stop_fast, or the camera stopped (standby)
                break
            if tap.is_frame(item):
                data, ts = item
                last_frame = loop.time()
                seq += 1
                await resp.write(EDOF_HEADER.pack(EDOF_MAGIC, EDOF_FRAME, len(data), -1 if ts is None else int(ts), seq) + data)
            else:
                kind, rec = item
                payload = json.dumps({**rec, "dropped": tap.dropped}, separators=(",", ":")).encode()
                t = rec.get("t_cmd") or rec.get("t_end") or -1
                await resp.write(EDOF_HEADER.pack(EDOF_MAGIC, kinds[kind], len(payload), int(t), seq) + payload)
    except (ConnectionResetError, asyncio.CancelledError, ConnectionError):
        pass
    finally:
        stop.set()
        if sweeps is not None:
            try:
                await sweeps  # finishes the current leg and returns z
            except Exception as e:  # noqa: BLE001  already reported in the stream
                log.warning("z sweep ended with an error: %s", e)
        await camera.stop_fast()
        request.app["status"](changed=True)
    return resp


async def fallback_page(request: web.Request) -> web.Response:
    html = resources.files("openflexito").joinpath("fallback/index.html").read_text()
    return web.Response(text=html, content_type="text/html")
