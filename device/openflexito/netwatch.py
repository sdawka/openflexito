"""Observe NetworkManager to classify connectivity.

`network_state()` returns, besides the original `state` (online | hotspot | offline | unknown),
`connections` and `ip`, a `link` field saying which physical path carries the traffic:
`ethernet` (a cable to a router or straight to a laptop; the latter shows `link_local: true`,
169.254.x.x), `wifi` (client of a router), `hotspot` (the Pi's own access point) or `none`.
Ethernet wins over WiFi when both are up because on a Pi 3B+ it is the fast path (~200-300 Mbit/s
against 10-90 for the single-stream radio); `ip` prefers the same interface so `microscope.local`
and the address shown in the app agree. `speed_mbit` is the Ethernet link speed from sysfs.
The parsing is pure (`classify`) so it can be unit-tested with canned nmcli output.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import shutil
from pathlib import Path

log = logging.getLogger(__name__)

ETHERNET_TYPES = ("802-3-ethernet", "ethernet")
WIFI_TYPES = ("802-11-wireless", "wifi")

FAKE_STATE = {
    "state": "online", "connections": ["openflexito-wired"], "ip": "192.168.1.50",
    "link": "ethernet", "interface": "eth0", "link_local": False, "speed_mbit": 1000,
    "interfaces": [{"interface": "eth0", "type": "ethernet", "connection": "openflexito-wired",
                    "ip": "192.168.1.50", "link_local": False, "speed_mbit": 1000}],
}


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


def _unescape(s: str) -> str:
    return s.replace("\\:", ":")


def parse_device_status(text: str) -> list[dict]:
    """`nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status` -> rows (nmcli escapes ':' as '\\:')."""
    rows = []
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = [_unescape(p) for p in line.replace("\\:", "\x00").split(":")]
        parts = [p.replace("\x00", ":") for p in parts]
        if len(parts) < 4:
            continue
        dev, typ, state, conn = parts[0], parts[1], parts[2], ":".join(parts[3:])
        rows.append({"interface": dev, "type": typ, "state": state, "connection": conn or None})
    return rows


def parse_ip4(text: str) -> dict[str, str]:
    """`nmcli -t -f GENERAL.DEVICE,IP4.ADDRESS device show` -> {interface: first IPv4 without prefix}."""
    out: dict[str, str] = {}
    dev = None
    for line in text.splitlines():
        if line.startswith("GENERAL.DEVICE:"):
            dev = line.split(":", 1)[1].strip()
        elif line.startswith("IP4.ADDRESS") and ":" in line and dev:
            addr = line.split(":", 1)[1].split("/")[0].strip()
            if addr and not addr.startswith("127.") and dev not in out:
                out[dev] = addr
    return out


def is_link_local(ip: str | None) -> bool:
    try:
        return bool(ip) and ipaddress.ip_address(ip).is_link_local
    except ValueError:
        return False


def read_speed_mbit(interface: str, sysfs: Path = Path("/sys/class/net")) -> int | None:
    try:
        v = int((sysfs / interface / "speed").read_text().strip())
        return v if v > 0 else None
    except (OSError, ValueError):
        return None


def classify(devices: list[dict], ip4: dict[str, str], hotspot_connection: str,
             speeds: dict[str, int | None] | None = None) -> dict:
    """Pure classification. Ethernet with an address beats WiFi; the hotspot only counts when nothing
    else carries traffic (the app stays reachable on 10.42.0.1 either way)."""
    speeds = speeds or {}
    ifaces = []
    for d in devices:
        if d["type"] in ETHERNET_TYPES or d["type"] in WIFI_TYPES:
            ip = ip4.get(d["interface"])
            connected = d["state"].startswith("connected") and bool(d["connection"])
            kind = "ethernet" if d["type"] in ETHERNET_TYPES else "wifi"
            if kind == "wifi" and d["connection"] == hotspot_connection:
                kind = "hotspot"
            ifaces.append({"interface": d["interface"], "type": kind, "connection": d["connection"] if connected else None,
                           "ip": ip if connected else None, "link_local": is_link_local(ip) if connected else False,
                           "speed_mbit": speeds.get(d["interface"]) if kind == "ethernet" and connected else None})
    names = [i["connection"] for i in ifaces if i["connection"]]
    eth = [i for i in ifaces if i["type"] == "ethernet" and i["ip"]]
    wifi = [i for i in ifaces if i["type"] == "wifi" and i["connection"]]
    hotspot = [i for i in ifaces if i["type"] == "hotspot" and i["connection"]]
    if eth:
        primary, link, state = eth[0], "ethernet", "online"
    elif wifi:
        primary, link, state = wifi[0], "wifi", "online"
    elif hotspot:
        primary, link, state = hotspot[0], "hotspot", "hotspot"
    else:
        primary, link, state = None, "none", "offline"
    return {
        "state": state, "connections": names, "ip": primary["ip"] if primary else None,
        "link": link, "interface": primary["interface"] if primary else None,
        "link_local": bool(primary and primary["link_local"]),
        "speed_mbit": primary.get("speed_mbit") if primary else None,
        "interfaces": ifaces,
    }


async def network_state(hotspot_connection: str, fake: bool = False) -> dict:
    if fake:
        return dict(FAKE_STATE)
    status = await _nmcli("-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status")
    if status is None:
        return {"state": "unknown", "connections": [], "ip": None, "link": "none", "interface": None,
                "link_local": False, "speed_mbit": None, "interfaces": []}
    devices = parse_device_status(status)
    ip_out = await _nmcli("-f", "GENERAL.DEVICE,IP4.ADDRESS", "device", "show")
    ip4 = parse_ip4(ip_out or "")
    speeds = {d["interface"]: read_speed_mbit(d["interface"]) for d in devices if d["type"] in ETHERNET_TYPES}
    return classify(devices, ip4, hotspot_connection, speeds)


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
