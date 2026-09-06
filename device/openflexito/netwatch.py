"""Observe NetworkManager to classify connectivity: online | hotspot | offline | unknown."""

from __future__ import annotations

import asyncio
import logging
import shutil

log = logging.getLogger(__name__)


async def _nmcli(*args: str) -> str | None:
    if not shutil.which("nmcli"):
        return None
    try:
        proc = await asyncio.create_subprocess_exec(
            "nmcli", "-t", *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        return out.decode(errors="replace")
    except (OSError, asyncio.TimeoutError):
        return None


async def network_state(hotspot_connection: str) -> dict:
    active = await _nmcli("-f", "NAME,TYPE,DEVICE", "connection", "show", "--active")
    if active is None:
        return {"state": "unknown", "connections": [], "ip": None}
    rows = [r.split(":") for r in active.splitlines() if r]
    wifi = [r for r in rows if len(r) >= 2 and r[1] in ("802-11-wireless", "wifi")]
    names = [r[0] for r in rows]
    ip = None
    ip_out = await _nmcli("-f", "IP4.ADDRESS", "device", "show")
    if ip_out:
        for line in ip_out.splitlines():
            if line.startswith("IP4.ADDRESS") and ":" in line:
                addr = line.split(":", 1)[1].split("/")[0]
                if addr and not addr.startswith("127."):
                    ip = addr
                    break
    if hotspot_connection in names:
        state = "hotspot"
    elif wifi or any(r[1] in ("802-3-ethernet", "ethernet") for r in rows if len(r) >= 2):
        state = "online"
    else:
        state = "offline"
    return {"state": state, "connections": names, "ip": ip}


async def wifi_scan() -> list[dict]:
    out = await _nmcli("-f", "SSID,SIGNAL,SECURITY,IN-USE", "device", "wifi", "list", "--rescan", "yes")
    result = []
    for line in (out or "").splitlines():
        parts = line.rsplit(":", 3)
        if len(parts) == 4 and parts[0]:
            result.append({"ssid": parts[0].replace("\\:", ":"), "signal": int(parts[1] or 0),
                           "security": parts[2], "in_use": parts[3].strip() == "*"})
    return result


async def wifi_join(ssid: str, psk: str | None = None) -> dict:
    if not shutil.which("nmcli"):
        return {"ok": False, "error": "nmcli not available"}
    args = ["nmcli", "device", "wifi", "connect", ssid]
    if psk:
        args += ["password", psk]
    proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    out, _ = await asyncio.wait_for(proc.communicate(), timeout=60)
    return {"ok": proc.returncode == 0, "output": out.decode(errors="replace").strip()}
