from openflexito.leds import PATTERNS, LedController, pattern_string


def test_pattern_string_holds_levels():
    assert pattern_string([(True, 100), (False, 200)], 255) == "255 100 255 0 0 200 0 0"


def test_led_controller_writes_pattern(tmp_path):
    led = tmp_path / "ACT"
    led.mkdir()
    (led / "max_brightness").write_text("255\n")
    (led / "trigger").write_text("none timer [mmc0] pattern\n")
    ctl = LedController(led)
    assert ctl.mode == "pattern"
    ctl.set_state("hotspot")
    assert (led / "trigger").read_text() == "pattern"
    assert (led / "pattern").read_text() == pattern_string(PATTERNS["hotspot"], 255)
    assert (led / "repeat").read_text() == "-1"


def test_led_controller_missing_path_is_noop(tmp_path):
    ctl = LedController(tmp_path / "nope")
    ctl.set_state("error")  # must not raise
    assert ctl.available is False
