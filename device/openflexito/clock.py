"""Monotonic clock shared with libcamera's SensorTimestamp (CLOCK_BOOTTIME, nanoseconds)."""

import time


def now_ns() -> int:
    try:
        return time.clock_gettime_ns(time.CLOCK_BOOTTIME)  # type: ignore[attr-defined]
    except (AttributeError, OSError):
        return time.monotonic_ns()
