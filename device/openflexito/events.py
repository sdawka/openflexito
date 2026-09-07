"""Fan-out of server-side events (frame metadata, position, status) to WebSocket clients."""

from __future__ import annotations

import asyncio
from typing import Any


class EventBus:
    def __init__(self, loop: asyncio.AbstractEventLoop | None = None):
        self._loop = loop
        self._subscribers: set[asyncio.Queue] = set()
        self.on_change = None  # optional callback(count) when a subscriber joins or leaves

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self, maxsize: int = 256) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=maxsize)
        self._subscribers.add(q)
        if self.on_change:
            self.on_change(len(self._subscribers))
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)
        if self.on_change:
            self.on_change(len(self._subscribers))

    @property
    def count(self) -> int:
        return len(self._subscribers)

    def publish(self, name: str, params: dict[str, Any]) -> None:
        """Publish from the event loop thread."""
        msg = {"jsonrpc": "2.0", "method": f"event.{name}", "params": params}
        for q in list(self._subscribers):
            if q.full():
                try:
                    q.get_nowait()  # drop oldest so slow clients lag rather than block
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(msg)

    def publish_threadsafe(self, name: str, params: dict[str, Any]) -> None:
        """Publish from any thread (camera encoder, stage worker)."""
        if self._loop is None:
            return
        try:
            self._loop.call_soon_threadsafe(self.publish, name, params)
        except RuntimeError:  # loop closed: we are shutting down, drop the event
            pass
