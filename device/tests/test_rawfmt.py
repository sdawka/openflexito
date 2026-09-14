"""Wire formats (rawfmt.py): OFRW v2 record + trailer, CSI2P packing, averaging, OFBK container."""
import numpy as np

from openflexito.rawfmt import (RAW_HEADER, RAW_MAGIC, RAW_TRAILER_MAGIC, average_mosaics, ccm_for, decode_bracket,
                                decode_raw, encode_bracket, encode_raw, frame_meta, pack_csi2p_10, unpack_csi2p_10)

TUNING = {"algorithms": [{"rpi.ccm": {"ccms": [{"ct": 2800, "ccm": [1] * 9}, {"ct": 5000, "ccm": [2] * 9}]}}]}


def test_single_frame_record_is_v1_compatible_plus_trailer():
    mosaic = np.arange(8 * 4, dtype="<u2").reshape(4, 8)
    data, trailer = encode_raw([mosaic], [{"ts": 7, "exposure": 100, "colour_temperature": 4000}],
                               bayer="BGGR", black_level=64, tuning=TUNING)
    magic, w, h, depth, black, bayer = RAW_HEADER.unpack_from(data)
    assert (magic, w, h, depth, black, bayer.rstrip(b"\0")) == (RAW_MAGIC, 8, 4, 10, 64, b"BGGR")
    assert data[RAW_HEADER.size:RAW_HEADER.size + 64] == mosaic.tobytes(), "v1 readers see header + pixels unchanged"
    assert data[-4:] == RAW_TRAILER_MAGIC
    header, pixels, t2 = decode_raw(data)
    assert pixels == mosaic.tobytes() and t2 == trailer
    assert trailer["version"] == 2 and trailer["frames"] == 1 and trailer["frame_timestamps"] == [7]
    assert trailer["white_level"] == 1023 and trailer["packed"] is False and trailer["flat"] is False
    assert trailer["ccm"] == [2.0] * 9 and trailer["ccm_ct"] == 5000, "nearest tuning CCM to the frame's CT"
    assert trailer["exposure"] == 100 and trailer["still"] is True


def test_averaging_scales_to_16_bit_and_keeps_fractions():
    frames = [np.full((2, 4), v, dtype="<u2") for v in (100, 101, 101, 102)]
    mean, depth, scale = average_mosaics(frames)
    assert (depth, scale) == (16, 64) and mean.dtype == np.dtype("<u2")
    assert int(mean[0, 0]) == round(101 * 64)
    data, trailer = encode_raw(frames, [{"ts": i} for i in range(4)], bayer="RGGB", black_level=64)
    header, pixels, _ = decode_raw(data)
    assert header["bit_depth"] == 16 and header["black_level"] == 4096 and trailer["white_level"] == 65472
    assert trailer["frame_timestamps"] == [0, 1, 2, 3] and trailer["ts"] == 0
    single, d1, s1 = average_mosaics(frames[:1])
    assert (d1, s1) == (10, 1) and single[0, 0] == 100


def test_csi2p_packing_roundtrip():
    rng = np.random.default_rng(0)
    mosaic = rng.integers(0, 1024, size=(6, 16), dtype=np.uint16)
    packed = pack_csi2p_10(mosaic)
    assert len(packed) == 6 * 16 * 5 // 4
    # spot-check the layout on the first quad
    p = mosaic[0, :4]
    assert packed[0] == p[0] >> 2 and packed[3] == p[3] >> 2
    assert packed[4] == (p[0] & 3) | (p[1] & 3) << 2 | (p[2] & 3) << 4 | (p[3] & 3) << 6
    assert np.array_equal(unpack_csi2p_10(packed, 16, 6), mosaic)
    data, trailer = encode_raw([mosaic], [{}], bayer="BGGR", black_level=64, packed=True)
    header, pixels, _ = decode_raw(data)
    assert trailer["packed"] is True and header["bit_depth"] == 10 and len(pixels) == len(packed)


def test_bracket_container_roundtrip():
    items = [({"factor": 0.5, "kind": "jpeg"}, b"\xff\xd8abc"), ({"factor": 2, "kind": "jpeg"}, b"\xff\xd8defgh")]
    blob = encode_bracket(items)
    assert blob[:4] == b"OFBK" and decode_bracket(blob) == items


def test_frame_meta_and_ccm_fallbacks():
    m = frame_meta({"SensorTimestamp": 5, "ColourGains": (1.5, 2.0), "Lux": np.float32(2.5)}, still=True)
    assert m["ts"] == 5 and m["colour_gains"] == [1.5, 2.0] and m["lux"] == 2.5 and m["still"] is True
    assert m["exposure"] is None and "t" in m
    assert ccm_for({}, 5000) == (None, None)
    assert ccm_for(TUNING, None)[1] == 2800
