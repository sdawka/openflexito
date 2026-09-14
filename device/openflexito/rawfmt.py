"""Wire formats for still captures: the OFRW raw record (v2, with a JSON trailer), CSI2P-style
10-bit packing, multi-frame averaging and the OFBK bracket container. Pure numpy/struct, shared
by the real and the fake camera and unit-tested without hardware.

OFRW record (`/raw.bin`, `/flat.bin`, each raw item of `/bracket.bin`)
----------------------------------------------------------------------
    offset  size  field
    0       4     magic b"OFRW"
    4       4     width      (u32 LE)  pixels per row
    8       4     height     (u32 LE)
    12      2     bit_depth  (u16 LE)  10 for a single frame, 16 for an averaged (frames > 1) capture
    14      2     black_level(u16 LE)  in the record's own scale (64 at 10 bit, 4096 at 16 bit)
    16      8     bayer      ASCII, NUL padded ("BGGR", "RGGB", ...)
    24      N     pixel data (see below)
    24+N    J     trailer: UTF-8 JSON object (RAW_TRAILER_VERSION = 2)
    24+N+J  4     J (u32 LE), byte length of the JSON
    24+N+J+4 4    magic b"OFRM"

The 24-byte header and the pixel data are unchanged from v1, so a v1 reader (header + width *
height * 2 bytes) keeps working and simply ignores the trailer. A v2 reader checks that the last
4 bytes are b"OFRM", reads the u32 in front of them and parses the JSON before it.

Pixel data:
  * unpacked (default): little-endian uint16, row-major, width * height * 2 bytes. Values are
    0..1023 at bit_depth 10 or 0..65472 (= 1023 * 64) at bit_depth 16.
  * packed (`packed: true` in the trailer, only at bit_depth 10): SBGGR10_CSI2P layout, 4 pixels
    in 5 bytes, width * height * 5 / 4 bytes, rows contiguous (width must be a multiple of 4).
    Bytes 0..3 hold the high 8 bits of pixels 0..3; byte 4 holds the low 2 bits: pixel 0 in
    bits 0-1, pixel 1 in bits 2-3, pixel 2 in bits 4-5, pixel 3 in bits 6-7.
        p0 = b0 << 2 | (b4      & 3)
        p1 = b1 << 2 | (b4 >> 2 & 3)
        p2 = b2 << 2 | (b4 >> 4 & 3)
        p3 = b3 << 2 | (b4 >> 6 & 3)

Trailer JSON (all keys always present, values may be null when the camera did not report them):
    version 2, width, height, bit_depth, black_level, white_level, bayer, packed, frames,
    frame_timestamps [ns per averaged frame], ts (SensorTimestamp ns of the first frame),
    exposure (us), gain, digital_gain, colour_gains [r, b], colour_temperature (K), lux,
    focus_fom, frame_duration (us), ccm [9 floats, row-major], ccm_ct (K of the tuning entry
    used), flat (bool), still true, matched true, t (device CLOCK_BOOTTIME ns at encode time).

Multi-frame averaging (frames > 1): the N mosaics are summed as uint32 and the mean is scaled to
16 bit, value16 = round(sum * 64 / N). The scale-up keeps the fractional precision the average
gained (up to 3 extra bits for N = 8) instead of throwing it away; the record's own header says
bit_depth 16 and black_level 4096, white_level 65472, so a reader that honours those fields needs
no special case. A single frame stays byte-identical to v1 (10 bit).

OFBK bracket container (`/bracket.bin`)
---------------------------------------
    0       4     magic b"OFBK"
    4       4     count (u32 LE)
    then count items, each:
            4     meta_len (u32 LE)
            meta_len  UTF-8 JSON: the frame's metadata (same shape as a still X-Frame, plus
                      `factor`, `index` and `kind`: "jpeg" | "raw")
            4     data_len (u32 LE)
            data_len  JPEG bytes, or a complete OFRW record (v2) when raw was requested
"""

from __future__ import annotations

import json
import struct
from typing import Any

from .clock import now_ns

RAW_MAGIC = b"OFRW"
RAW_TRAILER_MAGIC = b"OFRM"
RAW_TRAILER_VERSION = 2
RAW_HEADER = struct.Struct("<4sIIHH8s")  # magic, width, height, bit_depth, black_level, bayer order
BRACKET_MAGIC = b"OFBK"
U32 = struct.Struct("<I")

# Metadata keys copied from a libcamera request into the frame dict (libcamera name -> ours).
META_KEYS = {
    "SensorTimestamp": "ts", "ExposureTime": "exposure", "AnalogueGain": "gain", "DigitalGain": "digital_gain",
    "ColourGains": "colour_gains", "FocusFoM": "focus_fom", "Lux": "lux", "FrameDuration": "frame_duration",
    "ColourTemperature": "colour_temperature",
}


def json_safe(value: Any) -> Any:
    """Turn libcamera metadata (numpy scalars, tuples) into plain JSON types."""
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if hasattr(value, "item") and not isinstance(value, (bytes, str)):
        try:
            return value.item()
        except (TypeError, ValueError):
            return str(value)
    if isinstance(value, (bool, int, float, str)) or value is None:
        return value
    return str(value)


def frame_meta(md: dict, **extra) -> dict:
    """Our frame-metadata dict (the `event.frame` shape) from a libcamera metadata dict."""
    out: dict[str, Any] = {ours: json_safe(md.get(theirs)) for theirs, ours in META_KEYS.items()}
    out["colour_gains"] = list(out["colour_gains"] or [])
    out["t"] = now_ns()
    out.update(extra)
    return out


def ccm_for(tuning: dict, colour_temperature: float | None) -> tuple[list[float] | None, float | None]:
    """The `rpi.ccm` matrix of the tuning whose ct is nearest the frame's colour temperature."""
    ccms = []
    for alg in (tuning or {}).get("algorithms", []):
        if isinstance(alg, dict) and isinstance(alg.get("rpi.ccm"), dict):
            ccms = alg["rpi.ccm"].get("ccms") or []
    if not ccms:
        return None, None
    ct = float(colour_temperature) if colour_temperature else None
    best = min(ccms, key=lambda c: abs(float(c.get("ct", 0)) - ct)) if ct is not None else ccms[0]
    return [float(x) for x in best.get("ccm", [])] or None, float(best.get("ct", 0)) or None


def pack_raw(width: int, height: int, bit_depth: int, black_level: int, bayer: str, data: bytes) -> bytes:
    """v1 record: header + pixel bytes (kept for the tests and as the base of v2)."""
    return RAW_HEADER.pack(RAW_MAGIC, width, height, bit_depth, black_level, bayer.encode()[:8].ljust(8, b"\0")) + data


def pack_csi2p_10(mosaic) -> bytes:
    """10-bit mosaic (uint16, h x w, w % 4 == 0) -> SBGGR10_CSI2P bytes, 4 pixels in 5 bytes."""
    import numpy as np
    h, w = mosaic.shape
    if w % 4:
        raise ValueError("packed raw needs a width that is a multiple of 4")
    a = np.asarray(mosaic, dtype=np.uint16).reshape(h, w // 4, 4)
    hi = (a >> 2).astype(np.uint8)
    lo = (a & 3).astype(np.uint8)
    b4 = lo[:, :, 0] | (lo[:, :, 1] << 2) | (lo[:, :, 2] << 4) | (lo[:, :, 3] << 6)
    return np.concatenate([hi, b4[:, :, None]], axis=2).reshape(h, w * 5 // 4).tobytes()


def unpack_csi2p_10(data: bytes, width: int, height: int):
    """Inverse of pack_csi2p_10 (reference implementation for the tests / the browser port)."""
    import numpy as np
    b = np.frombuffer(data, dtype=np.uint8).reshape(height, width // 4, 5).astype(np.uint16)
    out = np.empty((height, width // 4, 4), dtype=np.uint16)
    for i in range(4):
        out[:, :, i] = (b[:, :, i] << 2) | ((b[:, :, 4] >> (2 * i)) & 3)
    return out.reshape(height, width)


class MosaicAccumulator:
    """Running uint32 sum of raw mosaics so N frames never sit in memory at once (16 MB each on the
    Pi 3). `add` is a single numpy add per frame; `result` yields (mosaic, bit_depth, scale): one
    frame is returned untouched at its native depth, several are averaged and scaled to 16 bit
    (see module doc)."""

    def __init__(self, bit_depth: int = 10):
        self.bit_depth, self.count, self._first, self._acc = bit_depth, 0, None, None

    def add(self, frame) -> None:
        import numpy as np
        if self.count == 0:
            # always a copy: on the camera `frame` is a view into a request buffer that is released
            # (and refilled) as soon as the caller returns
            self._first = np.array(frame, dtype="<u2", order="C", copy=True)
        else:
            if self._acc is None:
                self._acc = self._first.astype(np.uint32)
            self._acc += frame
        self.count += 1

    def result(self) -> tuple[Any, int, int]:
        import numpy as np
        if self.count == 0:
            raise ValueError("no frames")
        if self.count == 1:
            return self._first, self.bit_depth, 1
        scale = 1 << (16 - self.bit_depth)
        mean16 = (self._acc * scale + self.count // 2) // self.count
        return np.ascontiguousarray(mean16, dtype="<u2"), 16, scale


def average_mosaics(frames: list, bit_depth: int = 10) -> tuple[Any, int, int]:
    """Convenience wrapper over MosaicAccumulator for a list of frames."""
    acc = MosaicAccumulator(bit_depth)
    for f in frames:
        acc.add(f)
    return acc.result()


def encode_raw(frames, metas: list[dict], *, bayer: str, black_level: int, bit_depth: int = 10,
               packed: bool = False, flat: bool = False, tuning: dict | None = None) -> tuple[bytes, dict]:
    """Build a v2 OFRW record from N mosaics captured in one mode switch (a list of frames or a
    MosaicAccumulator, one metadata dict per frame). Returns (bytes, trailer)."""
    acc = frames if isinstance(frames, MosaicAccumulator) else None
    if acc is None:
        acc = MosaicAccumulator(bit_depth)
        for f in frames:
            acc.add(f)
    if acc.count == 0:
        raise ValueError("no frames")
    if packed and acc.count > 1:
        raise ValueError("packed raw is only available for a single frame")
    mosaic, depth, scale = acc.result()
    h, w = mosaic.shape[:2]
    bit_depth = acc.bit_depth
    first = dict(metas[0]) if metas else {}
    ct = first.get("colour_temperature")
    ccm, ccm_ct = ccm_for(tuning or {}, ct)
    trailer = {
        "version": RAW_TRAILER_VERSION, "width": int(w), "height": int(h), "bit_depth": depth,
        "black_level": int(black_level) * scale, "white_level": ((1 << bit_depth) - 1) * scale,
        "bayer": bayer, "packed": bool(packed), "frames": acc.count,
        "frame_timestamps": [m.get("ts") for m in metas],
        **{k: first.get(k) for k in ("ts", "exposure", "gain", "digital_gain", "colour_gains", "colour_temperature",
                                     "lux", "focus_fom", "frame_duration")},
        "ccm": ccm, "ccm_ct": ccm_ct, "flat": bool(flat), "still": True, "matched": True, "t": now_ns(),
    }
    data = pack_csi2p_10(mosaic) if packed else mosaic.tobytes()
    body = pack_raw(w, h, depth, int(black_level) * scale, bayer, data)
    js = json.dumps(json_safe(trailer), separators=(",", ":")).encode()
    return body + js + U32.pack(len(js)) + RAW_TRAILER_MAGIC, trailer


def decode_raw(record: bytes) -> tuple[dict, bytes, dict | None]:
    """Parse a v1 or v2 record -> (header dict, pixel bytes, trailer or None). Reference decoder."""
    magic, w, h, depth, black, bayer = RAW_HEADER.unpack_from(record)
    if magic != RAW_MAGIC:
        raise ValueError("not an OFRW record")
    header = {"width": w, "height": h, "bit_depth": depth, "black_level": black, "bayer": bayer.rstrip(b"\0").decode()}
    trailer = None
    end = len(record)
    if record[-4:] == RAW_TRAILER_MAGIC:
        (jlen,) = U32.unpack_from(record, len(record) - 8)
        trailer = json.loads(record[len(record) - 8 - jlen:len(record) - 8])
        end = len(record) - 8 - jlen
    return header, record[RAW_HEADER.size:end], trailer


def encode_bracket(items: list[tuple[dict, bytes]]) -> bytes:
    """OFBK container from [(meta, data), ...]; see module doc."""
    out = [BRACKET_MAGIC, U32.pack(len(items))]
    for meta, data in items:
        js = json.dumps(json_safe(meta), separators=(",", ":")).encode()
        out += [U32.pack(len(js)), js, U32.pack(len(data)), data]
    return b"".join(out)


def decode_bracket(blob: bytes) -> list[tuple[dict, bytes]]:
    """Reference decoder for the tests."""
    if blob[:4] != BRACKET_MAGIC:
        raise ValueError("not an OFBK container")
    (count,) = U32.unpack_from(blob, 4)
    pos, items = 8, []
    for _ in range(count):
        (mlen,) = U32.unpack_from(blob, pos); pos += 4
        meta = json.loads(blob[pos:pos + mlen]); pos += mlen
        (dlen,) = U32.unpack_from(blob, pos); pos += 4
        items.append((meta, blob[pos:pos + dlen])); pos += dlen
    return items
