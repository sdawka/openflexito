import asyncio
import json

from openflexito.stage import Stage


def _moves(transport):
    return [tuple(int(v) for v in s.split()[1:]) for s in transport.sent if s.startswith("mr ")]


async def test_move_rel_applies_inversion_and_backlash(stage, transport, events):
    events.bind(asyncio.get_running_loop())
    # Program +50 in x -> hardware -50 (x inverted). Engagement starts at 1, so moving in the
    # -backlash direction leaves the axis disengaged -> overshoot by backlash (100) then return.
    res = await stage.move_rel(x=50)
    assert _moves(transport) == [(-150, 0, 0), (100, 0, 0)]
    assert res["position"] == {"x": 50, "y": 0, "z": 0}
    assert stage.position["x"] == 50
    assert transport.pos == [-50, 0, 0]


async def test_move_in_preferred_direction_has_no_correction(stage, transport, events):
    events.bind(asyncio.get_running_loop())
    await stage.move_rel(y=40)  # y not inverted, +40 hw keeps engagement at 1
    assert _moves(transport) == [(0, 40, 0)]


async def test_compensate_false_is_raw(stage, transport, events):
    events.bind(asyncio.get_running_loop())
    await stage.move_rel(x=50, compensate=False)
    assert _moves(transport) == [(-50, 0, 0)]


async def test_move_to_and_persistence(stage, transport, events, tmp_path):
    events.bind(asyncio.get_running_loop())
    await stage.move_to(x=10, y=20, z=30, compensate=False)
    assert stage.position == {"x": 10, "y": 20, "z": 30}
    saved = json.loads((tmp_path / "position.json").read_text())
    assert saved["hw"] == {"x": -10, "y": 20, "z": -30}


async def test_restore_position_after_power_cycle(stage, transport, events, tmp_path, board):
    events.bind(asyncio.get_running_loop())
    await stage.move_rel(z=300, compensate=False)
    transport.pos = [0, 0, 0]
    transport._target = [0, 0, 0]  # board forgot
    stage2 = Stage(board, tmp_path, events, poll_interval=0.005)
    assert stage2.lost_position()
    assert stage2.position["z"] == 0
    stage2.restore_position()
    assert stage2.position["z"] == 300


async def test_position_events_have_timestamps(stage, transport, events):
    events.bind(asyncio.get_running_loop())
    q = events.subscribe()
    await stage.move_rel(z=20, compensate=False)
    await asyncio.sleep(0.01)
    msgs = []
    while not q.empty():
        msgs.append(q.get_nowait())
    assert msgs[0]["method"] == "event.position" and msgs[0]["params"]["moving"] is True
    assert msgs[-1]["params"]["moving"] is False
    assert msgs[-1]["params"]["t"] > msgs[0]["params"]["t"]


async def test_stop_cancels_long_move(stage, transport, events):
    events.bind(asyncio.get_running_loop())
    transport.step_time_us = 2000
    stage.board.info.step_time_us = 2000
    task = asyncio.ensure_future(stage.move_rel(x=1000, compensate=False))  # 2 s move
    await asyncio.sleep(0.15)
    await stage.stop()
    res = await task
    assert res["cancelled"] is True
    assert "stop" in transport.sent
    assert abs(stage.position["x"]) < 1000
