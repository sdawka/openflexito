import pytest

from openflexito.fake_board import FakeTransport
from openflexito.sangaboard import Sangaboard, SangaboardError, candidate_ports


def test_handshake_reads_info(board, transport):
    assert board.info.firmware == "Sangaboard Firmware v1.0.4"
    assert board.info.board == "Sangaboard v0.5"
    assert board.info.step_time_us == 50
    assert board.info.n_motors == 3
    assert "Stage" in board.info.modules
    assert "blocking_moves false" in transport.sent
    assert transport.blocking is False


def test_position_and_move(board, transport):
    assert board.position() == (0, 0, 0)
    transport.blocking = True
    board.move_rel(10, -20, 30)
    assert board.position() == (10, -20, 30)
    assert board.moving() is False


def test_unknown_command_raises(board):
    with pytest.raises(SangaboardError):
        board.query("frobnicate")


def test_bad_version_rejected():
    with pytest.raises(SangaboardError):
        Sangaboard(FakeTransport(firmware="Some Other Device v9"), "x")


def test_led_commands(board, transport):
    board.led_cc(0.5)
    board.led_pwm(1, 0.25)
    board.led_cc(2.0)  # clamped
    assert transport.led["cc"] == 1.0
    assert transport.led["pwm"][1] == 0.25
    assert board.led_channels() == {"cc": 1, "pwm": 2}


def test_candidate_ports_explicit():
    assert candidate_ports("/dev/ttyFOO") == ["/dev/ttyFOO"]
