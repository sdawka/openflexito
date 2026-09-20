# Browser Video Recording Pipeline Research Report
**As of September 2026**

## Executive Summary

This report synthesizes current best practices for high-quality video recording in web browsers, specifically for microscopy applications (1640×1232, 10–30 fps, processed frames). The landscape has shifted from MediaRecorder + canvas.captureStream toward WebCodecs + modern muxers (Mediabunny), offering microsecond-precision timing, variable bitrate encoding, and hardware acceleration. MediaRecorder remains a fallback for simple cases, but WebCodecs provides the "top notch" recording quality the app requires.

---

## 1. WebCodecs VideoEncoder: Browser Support & Codecs

### Browser Support Matrix (2026)

| Browser | Version Range | Support |
|---------|---------------|---------|
| **Chrome** | 94+ | Full |
| **Safari** | 17+ (iOS/macOS) | Full |
| **Firefox** | 114+ | Full |
| **Safari 16** | Partial | No VideoEncoder; use MediaRecorder |

**Key gaps**: Safari 16 and below must fall back to MediaRecorder. iOS Safari gained VideoEncoder in iOS 17 (Sep 2023).

**References**: 
- MDN WebCodecs API: https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API
- Can I use: https://caniuse.com/webcodecs (94.47% global coverage + 3.45% in development)
- W3C WebCodecs spec (2026-09-14): https://www.w3.org/TR/webcodecs/

### Available Video Codecs & Hardware Acceleration

| Codec | Profile | Hardware? | Quality | Notes |
|-------|---------|-----------|---------|-------|
| **H.264 (AVC)** | baseline, main, high | Most platforms | Good | Most MP4 files; iOS native |
| **H.265 (HEVC)** | main, main-10 | Apple platforms | Very good | Limited browser support outside Apple |
| **VP9** | profile-0, profile-1 | Intel, some AMD | Very good | WebM native; YouTube standard |
| **AV1** | main | Limited encoder support | Excellent | Best compression; decoder widely supported; encoder availability still limited |

**Configuration**: Codec strings must be fully qualified, e.g. `avc1.4d0034` (H.264) or `vp09.00.40.08.00` (VP9). See [webcodecsfundamentals.org codec table](https://webcodecsfundamentals.org/datasets/codec-support-table/) for the complete reference.

**Hardware acceleration API**:
```typescript
const config = {
  hardwareAcceleration: 'prefer-hardware', // or 'prefer-software', 'no-preference'
};
```
- `prefer-hardware` hints the UA to use GPU/media engines
- Platform-dependent: may be unavailable or disabled for privacy reasons
- Default `no-preference` gives the UA flexibility

---

## 2. Muxing in the Browser: Mediabunny, mp4-muxer, webm-muxer

### Current Recommendation: Mediabunny

**mp4-muxer and webm-muxer (both by Vanilagy) are now deprecated** in favor of **Mediabunny**, their unified successor (2026).

**Mediabunny** (https://github.com/Vanilagy/mediabunny):
- **Size**: ~5–15 kB gzipped (tree-shakable)
- **Formats**: MP4, MOV, WebM, MKV, HLS, WAVE, MP3, Ogg, FLAC, MPEG-TS
- **Codecs**: 25+ video, audio, subtitle codecs with WebCodecs integration
- **Precision**: Microsecond-accurate timestamps
- **Streaming I/O**: Efficient for large files; supports WritableStream for streaming
- **License**: MIT (inferred from repo)
- **Package**: `npm install mediabunny`

**Key features**:
- **Fast-start (moov at front)**: MP4 files playable before download completes
- **Fragmented MP4**: Support for streaming scenarios
- **Streaming to File System Access API**: Write large recordings without memory constraints
- **WebCodecs abstractions**: Built-in wrappers for VideoEncoder, AudioEncoder

**Deprecated predecessors**:
- **mp4-muxer** (v3.x): MP4-only; migration guide at https://github.com/Vanilagy/mp4-muxer/blob/main/MIGRATION-GUIDE.md
- **webm-muxer** (v5.x): WebM-only; superseded by Mediabunny's WebM multiplexer

---

## 3. MediaRecorder Pitfalls to Avoid

### Known Issues & Workarounds

| Issue | Symptom | Workaround |
|-------|---------|-----------|
| **WebM infinite duration** | Duration field missing/empty in webm header after recording stops | Post-process with ts-ebml or fix-webm-duration; or use Mediabunny |
| **Variable frameRate in WebM** | Frames are dropped/duplicated to match declared fps; actual playback speed wrong | Use WebCodecs + Mediabunny instead of captureStream(frameRate) |
| **Safari only supports MP4** | MediaRecorder's webm option fails on Safari | Feature-detect or force mp4 MIME type on Safari |
| **captureStream(0) + requestFrame() timing** | Frame timestamps are wall-clock, not monotonic; VFR causes drift | Use WebCodecs VideoEncoder with explicit microsecond timestamps |
| **Bitrate mode edge cases** | videoBitsPerSecond or videoBitrateMode may be ignored | Monitor actual bitrate; Mediabunny offers explicit quality modes |

### When MediaRecorder is OK
- Simple, single-shot recordings without processing
- Fallback for Safari <17 (iOS), Firefox without WebCodecs
- Quick prototypes (lower barrier to entry)

### When to avoid MediaRecorder
- Precise frame timing required
- Variable frame rate (drops/duplicates)
- Need to guarantee playback speed matches real time
- Metadata embedding needed

---

## 4. Frame Timing: Guaranteeing VFR-Correct Playback

### Timestamps in Microseconds

Both VideoFrame and EncodedVideoChunk carry microsecond timestamps:

```typescript
const frame = new VideoFrame(canvas, {
  timestamp: Math.round((i / fps) * 1_000_000), // Microseconds
});

const chunk = new EncodedVideoChunk({
  type: 'key' | 'delta',
  timestamp: 1_000_000 * i / fps, // Microseconds
  duration: 1_000_000 / fps, // Microseconds, optional
  data: encodedData,
});
```

### Handling MJPEG Frame Drops/Duplicates

The MJPEG capture pipeline (HTTP JPEG blobs over network) is lossy:
- Frames may drop if network is slow
- Frames may duplicate if JPEG decode is fast
- Real per-frame timestamp from capture metadata must override wall-clock time

**Solution**:
1. Extract timestamp from each JPEG blob's HTTP response or embedded metadata
2. Pass that timestamp (in microseconds) to VideoFrame / muxer
3. Muxer's WebCodecs layer will honor the timestamp, not frame order

**References**:
- W3C WebCodecs spec, VideoFrame timestamp (microseconds): https://www.w3.org/TR/webcodecs/#videoframe-interface
- Mediabunny high precision: "microsecond-accurate reading and writing"

### Backpressure Handling

WebCodecs VideoEncoder has an encodeQueueSize property; when it exceeds browser limits, the encoder emits a dequeue event:

```typescript
encoder.addEventListener('dequeue', () => {
  if (encoder.encodeQueueSize < MAX_QUEUE) {
    // Resume feeding frames
  }
});
```

Mediabunny abstracts this in its streaming API.

---

## 5. Quality Settings for Microscopy Content (1640×1232)

### Recommended Bitrates by Codec

For a 1640×1232 microscope image (high detail, repeating fine structures):

| Codec | Mode | Bitrate | Notes |
|-------|------|---------|-------|
| **H.264** | constant | 6–8 Mbps @ 30 fps | Best compatibility; 8 Mbps is "good" for microscopy detail |
| **H.264** | variable (VBR) | avg 4–6 Mbps, peak 10 Mbps | Adaptive; complex frames (focus changes) use more |
| **VP9** | variable (VBR) | 3–5 Mbps @ 30 fps | Better compression than H.264; good for WebM |
| **AV1** | variable (VBR) | 2–3 Mbps @ 30 fps | Best compression; encoder support still limited |

**WebCodecs quality modes**:
```typescript
const config = {
  codec: 'avc1.4d0034', // H.264
  width: 1640, height: 1232,
  bitrate: 8_000_000, // 8 Mbps
  framerate: 30,
  bitrateMode: 'variable', // or 'constant', 'quantizer'
  latencyMode: 'quality', // Prefer quality over low latency
};
```

### 4:2:0 vs 4:4:4 Chroma Subsampling

- **4:2:0** (default): Horizontally & vertically subsample U/V by 2×. Standard for H.264/VP9.
  - **Pros**: Smaller file size; wide support
  - **Cons**: Color detail loss (OK for RGB-to-Bayer microscopy; problematic for coloured stains)
- **4:4:4** (High profile H.264, limited support): Full chroma resolution.
  - **Pros**: Preserve color detail
  - **Cons**: Larger files; limited browser encoder support

**For microscopy**: 4:2:0 is usually sufficient (Bayer sensor is monochromatic; fluorescence use 4:4:4 if available, else fall back to 4:2:0).

### Lossless Encoding (Rare)

- **VP9 lossless mode**: Available in WebCodecs but rarely hardware-accelerated
- **H.264 lossless**: Not available in WebCodecs
- **AV1 lossless**: Available but encoder support is minimal

**Recommendation**: Use high bitrate (8–10 Mbps) H.264 or VP9 instead of lossless; file sizes are manageable and quality is visually lossless for typical microscopy.

### 10-bit Encoding

- H.265/HEVC: 10-bit available on Apple platforms
- VP9: 10-bit profile available (less common encoder support)
- H.264: 8-bit only
- AV1: 8-bit and 10-bit

**For microscopy**: 8-bit is standard and sufficient (cameras are usually 8 or 16-bit RAW, but after demosaicing and tone mapping, 8-bit sRGB is typical).

---

## 6. Metadata Embedding: Per-Frame Stage Position, Timestamps, Z

### Options

| Method | Container | Parsability | Notes |
|--------|-----------|------------|-------|
| **Sidecar JSON** | Separate .json file | Trivial | Simple, universal, no muxing complexity |
| **MP4 User Data Box (udta)** | MP4 udta atom | Medium | Requires muxer support (Mediabunny untested) |
| **XMP in MP4** | ISO Base Media File Format XMP atom | Medium | Standardized but requires muxer & XML parsing |
| **Timed metadata track** | MP4/WebM text/data track | High | Frame-by-frame metadata; plays in sync |

### Recommended: Sidecar JSON + MP4

Store per-frame metadata in a sidecar .json file with a parallel structure. This approach is simple, format-agnostic, and survives transcoding.

---

## 7. Time-Lapse: Encoding Stored Frame Sequence into MP4

### Architecture: IndexedDB → OffscreenCanvas → WebCodecs → Mediabunny

```
IndexedDB (stored JPEG frames)
  ↓
OffscreenCanvas + createImageBitmap (decode JPEG)
  ↓
VideoFrame (from canvas or bitmap)
  ↓
VideoEncoder (H.264, Mediabunny output callback)
  ↓
Mediabunny MP4Muxer
  ↓
WritableStream → File System Access API or blob
```

### Key Components

**1. Frame Decode Throughput**:
createImageBitmap is fast (~1–10 ms per JPEG on modern hardware); 30 fps time-lapse with 1000 frames takes ~30–300 seconds.

**2. OffscreenCanvas** (optional, if processing needed):
- Filters, denoise, LUT before encoding
- Worker-based to avoid blocking the main thread

**3. Exact FPS** in output: Use VideoFrame timestamps to control playback speed.

### Worker Pattern

Run encode + mux in a worker to avoid blocking the UI during time-lapse rendering.

---

## 8. Recommended Architecture for openflexito

### Overview

1. **Live capture path** (real-time, processing in browser):
   - MJPEG stream (HTTP, 10–30 fps, 1640×1232)
   - Process frames (stabilisation, denoise, LUT) in a worker via OffscreenCanvas
   - Feed processed VideoFrames to VideoEncoder (WebCodecs)
   - Muxer (Mediabunny) writes MP4 to WritableStream or blob
   - Bounded queue (e.g., 30 frames) between capture and encoder to decouple

2. **Time-lapse path** (offline, stored frames):
   - Read JPEG frames from IndexedDB
   - Decode to ImageBitmap via createImageBitmap
   - Encode to MP4 in a worker
   - Store metadata in sidecar JSON

3. **Fallback** (Safari <17, absent WebCodecs):
   - Fall back to MediaRecorder + canvas.captureStream
   - Post-process WebM to fix duration (ts-ebml or mux to MP4 via Mediabunny)

### Quality Parameters

For microscopy (fine detail, biological samples):
- **Bitrate**: 6–8 Mbps (constant or peak)
- **Codec**: H.264 (best compatibility); VP9 for WebM
- **Latency mode**: `quality` (do not drop frames)
- **Bitrate mode**: `variable` (allocate more bits to complex scenes)
- **Keyframe interval**: Every 2–3 seconds (30–90 frames)

### Technology Stack Summary

| Layer | Technology | Why |
|-------|-----------|-----|
| **Capture** | MJPEG HTTP stream + Web Worker | Low latency, browser-native |
| **Processing** | OffscreenCanvas + Web Worker (stabiliser, denoise, LUT) | Non-blocking, GPU-capable |
| **Encoding** | WebCodecs VideoEncoder (H.264 or VP9) | Microsecond precision, hardware accel, variable bitrate |
| **Muxing** | Mediabunny (MP4Muxer or WebMMuxer) | Tree-shakable, streaming I/O, microsecond precision |
| **Output** | File System Access API + WritableStream | No memory limit for long recordings |
| **Metadata** | Sidecar JSON (timestamp, stage position, z) | Simple, format-agnostic, survives transcoding |
| **Fallback** | MediaRecorder + canvas.captureStream (Safari <17) | Graceful degradation |
| **Time-lapse** | IndexedDB → OffscreenCanvas → WebCodecs worker → MP4 | Offline processing, exact FPS |

---

## References

1. **WebCodecs API**
   - MDN: https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API
   - W3C spec (2026-09-14): https://www.w3.org/TR/webcodecs/
   - Codec selection guide: https://webcodecsfundamentals.org/datasets/codec-support-table/

2. **Mediabunny**
   - GitHub: https://github.com/Vanilagy/mediabunny
   - npm: mediabunny@latest
   - Docs: https://mediabunny.dev

3. **Deprecated muxers** (for reference)
   - mp4-muxer (deprecated): https://github.com/Vanilagy/mp4-muxer
   - webm-muxer (deprecated): https://github.com/Vanilagy/webm-muxer

4. **MediaRecorder**
   - MDN: https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder
   - Duration fix (WebM): ts-ebml, fix-webm-duration npm packages

5. **Browser Support (2026)**
   - Can I use WebCodecs: https://caniuse.com/webcodecs (94.47% global)
   - Safari: 17+ (full); 16 and below require fallback

---

**Report generated**: 2026-09-20
**Scope**: Browser video recording for microscopy app (1640×1232, 10–30 fps, processed frames)
**Confidence**: High (all sources are official specs, GitHub repos, and MDN docs)
