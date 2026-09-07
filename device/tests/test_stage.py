import asyncio
import json

import pytest

from openflexito.sangaboard import SangaboardError
from openflexito.stage import Stage


def _moves(transport):
    return [tuple(int(v) for v in s.split()[1:]) for s in transport.sent if s.startswith("mr ")]


async def test_move_rel_applies_inversion_and_backlash(stage, transport, events):
    events.bind(asyncio.get_running_loop())
    # Program +50 in x -> hardware -50 (x inverted). Moving in the -backlash direction leaves the
    # axis disengaged -> overshoot by backlash (100) then return (v3 _move_with_backlash_correction).
    res = await stage.move_rel(x=50)
    assert _moves(transport) == [(-150, 0, 0), (100, 0, 0)]
    assert res["position"] == {"x": 50, "y": 0, "z": 0}
    assert stage.position["x"] == 50
    assert transport.pos == [-50, 0, 0]


async def test_move_in_preferred_direction_has_no_correction(stage, transport, events):
    events.bind(asyncio.get_running_loop())
    # The engagement state starts at 0 (unknown, as in v3), so even the first + move is corrected.
    await stage.move_rel(y=40)
    assert _moves(transport) == [(0, -60, 0), (0, 100, 0)]
    assert stage.status()["engaged"]["y"] == 1.0
    transport.sent.clear()
    await stage.move_rel(y=40)  # now engaged in +hw: a further + move needs no correction
    assert _moves(transport) == [(0, 40, 0)]


async def test_only_moving_axes_are_corrected_by_default(stage, transport, events):
    events.bind(asyncio.get_running_loop())
    # x and y are disengaged (state 0) but a z-only move must not wiggle them (v3 MOVEMENT_AXES)
    await stage.move_rel(z=-30)  # z inverted -> +30 hw, state 0.3 < 1 -> corrected on z only
    assert _moves(transport) == [(0, 0, -70), (0, 0, 100)]


async def test_named_compensation_modes(stage, transport, events):
    events.bind(asyncio.get_running_loop())
    await stage.move_rel(z=-30, compensate="xy")  # v3 XY_ONLY: correct x and y even though only z moves
    assert _moves(transport) == [(-100, -100, 30), (100, 100, 0)]
    transport.sent.clear()
    await stage.move_rel(x=10, compensate="z")  # v3 Z_ONLY: z ended at 0.3 above, so it is corrected, x is not
    assert _moves(transport) == [(-10, 0, -100), (0, 0, 100)]
    transport.sent.clear()
    await stage.move_rel(x=10, compensate="all")  # v3 ALL_AXES: y and z are engaged by now, x is not
    assert _moves(transport) == [(-110, 0, 0), (100, 0, 0)]
    with pytest.raises(ValueError):
        await stage.move_rel(x=10, compensate="sideways")
    assert not stage.moving


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


async def test_serial_failure_mid_move_clears_moving_flag(stage, transport, events):
    events.bind(asyncio.get_running_loop())
    original = transport.write_line

    def broken(line):
        if line.startswith("mr "):
            raise SangaboardError("link lost")
        original(line)
    transport.write_line = broken
    with pytest.raises(SangaboardError):
        await stage.move_rel(x=10, compensate=False)
    assert stage.moving is False
    assert stage.live_position() == stage.position


def test_stale_reply_is_flushed_before_next_query(board, transport):
    transport._out.append("p? reply that nobody read")  # e.g. arrived after a timeout
    assert board.position() == (0, 0, 0)


def test_set_step_time_updates_duration_estimate(board):
    assert board.set_step_time(2500) == 2500
    assert board.info.step_time_us == 2500
