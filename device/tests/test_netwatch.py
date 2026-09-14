import asyncio
from pathlib import Path

from openflexito.netwatch import classify, network_state, parse_device_status, parse_ip4, read_speed_mbit

HOTSPOT = "openflexito-hotspot"
STATUS_WIRED_WIFI = "eth0:ethernet:connected:openflexito-wired\nwlan0:wifi:connected:Home\\:5G\nlo:loopback:connected (externally):lo\n"
STATUS_WIRED_ONLY = "eth0:ethernet:connected:openflexito-wired\nwlan0:wifi:disconnected:\nlo:loopback:unmanaged:\n"
STATUS_WIFI = "eth0:ethernet:unavailable:\nwlan0:wifi:connected:Home\nlo:loopback:unmanaged:\n"
STATUS_HOTSPOT = "eth0:ethernet:unavailable:\nwlan0:wifi:connected:openflexito-hotspot\n"
STATUS_NOTHING = "eth0:ethernet:unavailable:\nwlan0:wifi:disconnected:\n"


def ip4(**kw):
    return "".join(f"GENERAL.DEVICE:{k}\nIP4.ADDRESS[1]:{v}/24\n" for k, v in kw.items())


def test_parse_device_status_unescapes_colons():
    rows = parse_device_status(STATUS_WIRED_WIFI)
    assert rows[0] == {"interface": "eth0", "type": "ethernet", "state": "connected", "connection": "openflexito-wired"}
    assert rows[1]["connection"] == "Home:5G"


def test_parse_ip4_takes_first_address_per_device():
    text = "GENERAL.DEVICE:eth0\nIP4.ADDRESS[1]:192.168.1.50/24\nIP4.ADDRESS[2]:169.254.9.9/16\nGENERAL.DEVICE:lo\nIP4.ADDRESS[1]:127.0.0.1/8\n"
    assert parse_ip4(text) == {"eth0": "192.168.1.50"}


def test_wired_beats_wifi_and_reports_speed():
    st = classify(parse_device_status(STATUS_WIRED_WIFI), parse_ip4(ip4(eth0="192.168.1.50", wlan0="192.168.1.51")),
                  HOTSPOT, {"eth0": 1000})
    assert st["state"] == "online" and st["link"] == "ethernet" and st["interface"] == "eth0"
    assert st["ip"] == "192.168.1.50" and st["speed_mbit"] == 1000 and st["link_local"] is False
    assert sorted(st["connections"]) == ["Home:5G", "openflexito-wired"]


def test_direct_cable_is_link_local():
    st = classify(parse_device_status(STATUS_WIRED_ONLY), parse_ip4(ip4(eth0="169.254.23.7")), HOTSPOT, {"eth0": 100})
    assert st["link"] == "ethernet" and st["link_local"] is True and st["ip"] == "169.254.23.7" and st["speed_mbit"] == 100


def test_wired_without_address_does_not_count():
    st = classify(parse_device_status(STATUS_WIRED_WIFI), parse_ip4(ip4(wlan0="192.168.1.51")), HOTSPOT)
    assert st["link"] == "wifi" and st["ip"] == "192.168.1.51"


def test_wifi_client():
    st = classify(parse_device_status(STATUS_WIFI), parse_ip4(ip4(wlan0="10.0.0.9")), HOTSPOT)
    assert st == {**st, "state": "online", "link": "wifi", "ip": "10.0.0.9", "interface": "wlan0", "speed_mbit": None}


def test_hotspot():
    st = classify(parse_device_status(STATUS_HOTSPOT), parse_ip4(ip4(wlan0="10.42.0.1")), HOTSPOT)
    assert st["state"] == "hotspot" and st["link"] == "hotspot" and st["ip"] == "10.42.0.1"


def test_nothing():
    st = classify(parse_device_status(STATUS_NOTHING), {}, HOTSPOT)
    assert st["state"] == "offline" and st["link"] == "none" and st["ip"] is None and st["connections"] == []


def test_read_speed_from_sysfs(tmp_path: Path):
    (tmp_path / "eth0").mkdir(); (tmp_path / "eth0" / "speed").write_text("1000\n")
    (tmp_path / "eth1").mkdir(); (tmp_path / "eth1" / "speed").write_text("-1\n")
    assert read_speed_mbit("eth0", tmp_path) == 1000
    assert read_speed_mbit("eth1", tmp_path) is None
    assert read_speed_mbit("nope", tmp_path) is None


def test_fake_reports_a_wired_link():
    st = asyncio.run(network_state(HOTSPOT, fake=True))
    assert st["link"] == "ethernet" and st["state"] == "online" and st["speed_mbit"] == 1000 and st["interfaces"]
