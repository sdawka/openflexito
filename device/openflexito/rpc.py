"""JSON-RPC 2.0 method registry with a self-describing schema."""

from __future__ import annotations

import asyncio
import inspect
import logging
import typing
from typing import Any, Awaitable, Callable

log = logging.getLogger(__name__)

PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL_ERROR = (
    -32700, -32600, -32601, -32602, -32603)


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None):
        super().__init__(message)
        self.code, self.message, self.data = code, message, data


def _type_name(annotation) -> str:
    if annotation is inspect.Parameter.empty:
        return "any"
    origin = typing.get_origin(annotation)
    if origin is typing.Union or str(origin) == "<class 'types.UnionType'>":
        return " | ".join(_type_name(a) for a in typing.get_args(annotation))
    if origin in (list, tuple):
        return "array"
    if origin is dict:
        return "object"
    if annotation is type(None):
        return "null"
    return getattr(annotation, "__name__", str(annotation))


class RpcRegistry:
    def __init__(self):
        self._methods: dict[str, Callable[..., Awaitable[Any] | Any]] = {}
        self._docs: dict[str, dict] = {}

    def method(self, name: str, doc: str | None = None):
        def deco(fn):
            self.register(name, fn, doc)
            return fn
        return deco

    def register(self, name: str, fn: Callable, doc: str | None = None) -> None:
        sig = inspect.signature(fn)
        params = []
        for p in sig.parameters.values():
            if p.name == "self" or p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
                continue
            params.append({
                "name": p.name,
                "type": _type_name(p.annotation),
                "required": p.default is inspect.Parameter.empty,
                **({"default": p.default} if p.default is not inspect.Parameter.empty else {}),
            })
        self._methods[name] = fn
        self._docs[name] = {"name": name, "params": params, "doc": (doc or inspect.getdoc(fn) or "").strip()}

    def schema(self) -> dict:
        return {"jsonrpc": "2.0", "methods": [self._docs[k] for k in sorted(self._docs)]}

    async def call(self, name: str, params: Any) -> Any:
        fn = self._methods.get(name)
        if fn is None:
            raise RpcError(METHOD_NOT_FOUND, f"unknown method {name}")
        try:
            if params is None:
                result = fn()
            elif isinstance(params, dict):
                result = fn(**params)
            elif isinstance(params, list):
                result = fn(*params)
            else:
                raise RpcError(INVALID_PARAMS, "params must be object or array")
        except TypeError as e:
            raise RpcError(INVALID_PARAMS, str(e)) from e
        if inspect.isawaitable(result):
            result = await result
        return result

    async def handle(self, message: Any) -> dict | None:
        """Handle one decoded JSON-RPC request; returns the response object (None for notifications)."""
        if not isinstance(message, dict):
            return _error(None, INVALID_REQUEST, "request must be an object")
        req_id = message.get("id")
        method = message.get("method")
        if not isinstance(method, str):
            return _error(req_id, INVALID_REQUEST, "missing method")
        try:
            result = await self.call(method, message.get("params"))
        except RpcError as e:
            if req_id is None:
                return None
            return _error(req_id, e.code, e.message, e.data)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - surface to the client
            log.exception("rpc %s failed", method)
            if req_id is None:
                return None
            return _error(req_id, INTERNAL_ERROR, f"{type(e).__name__}: {e}")
        if req_id is None:
            return None
        return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _error(req_id, code: int, message: str, data: Any = None) -> dict:
    err = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return {"jsonrpc": "2.0", "id": req_id, "error": err}
