import pytest

from openflexito.events import EventBus
from openflexito.fake_board import FakeTransport
from openflexito.sangaboard import Sangaboard
from openflexito.stage import Stage


@pytest.fixture
def transport():
    return FakeTransport(step_time_us=50)  # fast moves for tests


@pytest.fixture
def board(transport):
    return Sangaboard(transport, "fake")


@pytest.fixture
def events():
    return EventBus()


@pytest.fixture
def stage(board, events, tmp_path):
    return Stage(board, tmp_path, events, backlash={"x": 100, "y": 100, "z": 100},
                 inverted={"x": True, "y": False, "z": True}, poll_interval=0.005)
