"""calibration.json: JSON objects by key, `when` stamped, deletion, clear, events, size and key
validation, survives a restart (a new store on the same state_dir)."""
import asyncio
import json

import pytest

from openflexito.calibration import MAX_VALUE_BYTES, CalibrationStore
from openflexito.events import EventBus


class Sink:
    def __init__(self):
        self.got = []

    def publish(self, name, params):
        self.got.append((name, params))


async def test_set_get_delete_and_persist(tmp_path):
    ev = Sink()
    st = CalibrationStore(tmp_path, ev)
    assert await st.get() == {}
    r = await st.set("csm", {"matrix": [[1, 0], [0, 1]], "when": "2026-10-05T12:00:00Z"})
    assert r == {"key": "csm", "when": "2026-10-05T12:00:00Z"}
    r2 = await st.set("z", {"backlash": 200})
    assert r2["when"].endswith("Z")                      # stamped when the client sent none
    assert (await st.get("z"))["value"]["backlash"] == 200
    assert st.summary() == {"csm": "2026-10-05T12:00:00Z", "z": r2["when"]}
    assert ev.got[0] == ("calibration", {"key": "csm", "when": "2026-10-05T12:00:00Z"})

    again = CalibrationStore(tmp_path, None)              # service restart
    assert (await again.get("csm"))["value"]["matrix"] == [[1, 0], [0, 1]]

    assert await st.set("csm", None) == {"key": "csm", "when": None}
    assert (await st.get("csm"))["value"] is None
    assert ev.got[-1] == ("calibration", {"key": "csm", "when": None})
    assert await st.clear() == {"cleared": ["z"]}
    assert json.loads((tmp_path / "calibration.json").read_text()) == {}


async def test_validation(tmp_path):
    st = CalibrationStore(tmp_path)
    with pytest.raises(ValueError):
        await st.set("Bad Key", {"a": 1})
    with pytest.raises(ValueError):
        await st.set("csm", [1, 2, 3])
    with pytest.raises(ValueError):
        await st.set("flat", {"data": [0.123456] * (MAX_VALUE_BYTES // 4)})
    with pytest.raises(ValueError):
        await st.get("no-such")


def test_corrupt_file_is_ignored(tmp_path):
    (tmp_path / "calibration.json").write_text("{not json")
    st = CalibrationStore(tmp_path)
    assert st.summary() == {}
    (tmp_path / "calibration.json").write_text(json.dumps({"ok": {"a": 1}, "Bad": {"b": 2}, "list": [1]}))
    assert CalibrationStore(tmp_path).summary() == {"ok": None}


async def test_rpc_surface_and_status(tmp_path):
    from openflexito.app import Device
    from openflexito.config import CameraConfig, Config, StageConfig
    cfg = Config(state_dir=tmp_path, webapp_dir=None, led_path=tmp_path / "no-led",
                 camera=CameraConfig(fake=True, stream_size=(160, 120), lores_size=(40, 30), full_size=(64, 48)),
                 stage=StageConfig(fake=True, poll_interval=0.005))
    dev = Device(cfg)
    dev.events.bind(asyncio.get_running_loop())
    dev.open_hardware()
    dev.register_rpc()
    try:
        await dev.power.set(on=False)                      # not guarded: works in standby too
        assert await dev.rpc.call("calibration.set", {"key": "scale", "value": {"umPerPx": 0.5, "when": "t"}}) == {"key": "scale", "when": "t"}
        assert (await dev.rpc.call("calibration.get", {"key": "scale"}))["value"]["umPerPx"] == 0.5
        assert dev.status()["calibration"] == {"scale": "t"}
        assert "calibration.clear" in {m["name"] for m in dev.rpc.schema()["methods"]}
    finally:
        if dev.stage:
            dev.stage.close()
