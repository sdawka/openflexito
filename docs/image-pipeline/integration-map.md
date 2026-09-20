# Integration map: colour LUT + browser-side enhance pipeline

All paths relative to `/Users/sdawka/Code/openflexito/webapp` unless absolute.
Line numbers are from the working tree at commit `34fa5a2`.

---

## 1. Live view — `src/components/StreamView.svelte` (250 lines)

### How the live image is rendered

It is a **real DOM `<img>`, not a canvas**.

- **Line 179**: `<img bind:this={img} {src} alt="microscope live view" draggable="false" crossorigin="anonymous" style:transform={shift} class:ghost={liveStack.active && !!liveStack.composite} onerror={() => (error = true)} />`
  - `crossorigin="anonymous"` is already set, so canvas sampling of this element is **not** tainted.
- **Line 59**: `const src = $derived(device.url(settings.showLores ? '/stream-lores.mjpg' : '/stream.mjpg') + '?n=' + nonce)`
- **Line 46**: `let img: HTMLImageElement | undefined = $state()`
- **Line 63**: `$effect(() => { if (device.connected) { nonce = Date.now(); error = false } })` — re-arms on reconnect. The comment at 61–62 documents that only `device.connected` may be a dependency; `nonce` is written without being read or the effect self-triggers.
- **Line 68**: `$effect(() => { const el = img; return () => { if (el) el.src = '' } })` — **mandatory unmount cleanup**. A detached `<img>` keeps downloading its MJPEG stream forever in Chrome. Any new rendering path must preserve this.
- **Lines 176–178**: error banner with a retry button that bumps `nonce`.

### `liveStack.source`

- **Line 70**: `$effect(() => { liveStack.source = img ?? null; return () => { if (liveStack.source === img) liveStack.source = null } })`
- Declared at `src/lib/services/liveStack.svelte.ts:17` as `source: HTMLImageElement | null = null` (a plain field, not `$state`).
- `liveStack.svelte.ts:70` reads `const img = this.source` inside its grab loop.
- Comment at line 69: "the live focus stack and the recorder read frames from this element". Note the recorder **no longer** reads the `<img>` for the plain stream path (see §2); only the live-stack composite path does.

### The composite-canvas overlay — the pattern to copy

This is the existing precedent for putting processed pixels over the live `<img>`:

- **Line 71**: `let compCanvas: HTMLCanvasElement | undefined = $state()`
- **Lines 72–78**:
  ```ts
  $effect(() => {
    const bmp = liveStack.composite, c = compCanvas
    if (!c) return
    if (!bmp) { c.getContext('2d')!.clearRect(0, 0, c.width, c.height); return }
    if (c.width !== bmp.width || c.height !== bmp.height) { c.width = bmp.width; c.height = bmp.height }
    c.getContext('2d')!.drawImage(bmp, 0, 0)
  })
  ```
- **Line 180**: `{#if liveStack.active}<canvas bind:this={compCanvas} class="composite" style:transform={shift}></canvas>{/if}`
- **Line 234** (`img` style): `max-width: 100%; max-height: 100%; object-fit: contain; user-select: none; pointer-events: none; will-change: transform; grid-area: 1 / 1;`
- **Line 235**: `img.ghost { opacity: 0; }`
- **Line 236**: `.composite { max-width: 100%; max-height: 100%; object-fit: contain; pointer-events: none; grid-area: 1 / 1; }`
- **Line 223**: `.view { position: relative; ... display: grid; place-items: center; overflow: hidden; cursor: grab; touch-action: none; }`

**Recommendation for a LUT/enhance canvas**: add a third element in the same `grid-area: 1 / 1` cell, carrying the same `style:transform={shift}` and `object-fit: contain`, and set `class:ghost` on the `<img>` when the LUT canvas is showing. Reuse the `liveStack.composite` idiom exactly: an `ImageBitmap` in a store, an `$effect` that resizes and `drawImage`s it.

**Frame source for the LUT canvas**: there is **no per-frame render loop in this component**. Frames arrive through the browser's own multipart `<img>` handling, which gives no "new part decoded" signal. Use `src/lib/api/mjpegStream.ts` (`MjpegStream` at line 55, `MjpegFrame` at 18, `MjpegFrameHandler` at 29, `MjpegErrorHandler` at 30) exactly as `recorder.startStream()` does. The recorder docstring at `recorder.svelte.ts:1–19` documents why sampling the `<img>` on a timer tears and duplicates/drops frames. Alternatively drive it from `liveStack`'s existing worker pipeline if the LUT should compose with smoothing/stacking.

### Overlays present

| Overlay | Lines | Notes |
|---|---|---|
| SVG layer (boxes, paths, select rect, measure polygon) | 182–206 | `viewBox="0 0 1 1" preserveAspectRatio="none"`, positioned from `geo` |
| Detection/follow labels (HTML divs) | 210–214 | `.tag`, absolute, `px()` helper at line 172 |
| Measurement points | 207–209 | `.measure-pt` |
| Crosshair | 216 | `.crosshair`, CSS gradients |
| Scale bar | 217–219 | `.scalebar`, width `scaleBar.px * scale` |

`paths` prop: `Path { points: { x: number; y: number }[]; color?: string }` at **line 24**, rendered as `<polyline class="track">` at lines 186–188. `Box` at line 21, `Pan` at line 22.

### Zoom / pan transform

There is **no zoom** on the live view. Only a translate:

- **Line 94**: `let geo = $state<{ ox, oy, w, h } | null>(null)` — the content rect inside the element under `object-fit: contain`.
- **Lines 95–98**: `$effect` recomputes `geo` on a **250 ms `setInterval`**.
- **Line 81–87**: `geometry()` computes it from `img.getBoundingClientRect()` and `naturalWidth/Height`.
- **Line 100**: `const scale = $derived(geo && img?.naturalWidth ? geo.w / img.naturalWidth : 1)` — displayed px per natural px.
- **Line 101**: `const shift = $derived(panOffset && geo ? \`translate(${panOffset[0] * scale}px, ${panOffset[1] * scale}px)\` : '')`

### Full props (lines 26–44)

```ts
{
  boxes?: Box[]
  paths?: Path[]
  panOffset?: [number, number] | null
  picking?: boolean
  onclickimage?: (p: { x; y; w; h }) => void
  onselectregion?: (r: { x; y; w; h }) => void
  onclickbox?: (b: Box) => void
  onpan?: (p: Pan) => void
  scaleInfo?: { umPerPx: number; referenceWidth: number } | null
  measuring?: boolean
  measurePoints?: Pt[]
  measureClosed?: boolean
  onmeasureclick?: (p: { x; y; w; h }) => void
  onmeasuredblclick?: () => void
}
```

Pointer model (lines 106–171): `down`/`move`/`up`/`cancel`, `CLICK_PX = 4` (52), `LONG_PRESS_MS = 450` (53), `touches: Set<number>` (55), `abortGesture()` (58). Multi-touch never drives the stage (line 132).

### Hazards

- CLAUDE.md: never write a `$state` you also read inside the same `$effect` (kills the whole app).
- Clear `img.src` on unmount.
- `geo` is polled at 4 Hz, so anything that depends on exact layout sync needs its own measurement.

---

## 2. Recorder — `src/lib/services/recorder.svelte.ts` (274 lines)

### `RecorderOptions` (lines 31–40)

```ts
export type VideoCodec = 'vp9' | 'av1' | 'vp8' | 'auto'   // line 30
export interface RecorderOptions {
  codec: VideoCodec
  /** encoder target, Mbit/s (scaled with pixel count relative to 820x616 if scaleBitrate) */
  bitrateMbps: number
  /** at most this many canvas frames/s when captureStream(0)/requestFrame is unsupported; 0 = every frame */
  maxFps: number
  /** remove hand/vibration jitter from the live-stream source (ignored for the live-stack source) */
  stabilize: boolean
}
```

Defaults at **line 55**: `options = $state<RecorderOptions>({ codec: 'vp9', bitrateMbps: 12, maxFps: 30, stabilize: true })`.

### Reactive state (lines 51–54)

`recording`, `seconds`, `frames`, `status` — all `$state`.

### Private fields (lines 56–75)

`rec: MediaRecorder | null`, `chunks: Blob[]`, `canvas: HTMLCanvasElement | null`, `ctx: CanvasRenderingContext2D | null`, `grayCanvas: OffscreenCanvas | null`, `off: (() => void) | null`, `mjpeg: MjpegStream | null`, `stabilizer: Stabilizer | null`, `wasMoving`, `margin`, `srcW`, `srcH`, `clock`, `startedAt`, `label`, `thumb: Blob | null`, `log: VideoFrameLog[]`, `mimeUsed`, `bitrateMbpsUsed`, `releaseActivity: (() => void) | null`.

### Codec statics (lines 42–95)

- `CANDIDATES` at 42–46: vp9 → `['video/webm;codecs=vp9']`; av1 → `['video/webm;codecs=av01.0.08M.08', 'video/webm;codecs=av1', 'video/mp4;codecs=av01.0.08M.08']`; vp8 → `['video/webm;codecs=vp8']`.
- `FALLBACKS = ['video/webm', 'video/mp4']` at 47.
- `GRAY_WIDTH = 260` at 48 — downscale width for the stabiliser's tracking frame.
- `static supported(m)` 77, `static mime(codec)` 80–85, `static codecSupport()` 88–90, `static codecOf(mime)` 92–95.

### Path A — `start(source, label, opts)` (lines 100–132)

Used for the **live focus-stack composite** and any non-stream source.

```ts
export type FrameSource = () => { image: CanvasImageSource; width: number; height: number } | null   // line 28
start(source: FrameSource, label: string, opts: Partial<RecorderOptions> = {}): void
```

Flow:
1. Guard `if (this.recording) return` (101).
2. `const o = { ...this.options, ...opts }` (102); `Recorder.mime(o.codec)` (103); bail with `status` if unsupported (104).
3. `const first = source()`; bail `'no frame to record yet'` if null (105–106).
4. `beginCanvas(first.width, first.height, mime, o)` (107).
5. `draw()` closure at 109–114: `source()` → `resizeIfNeeded(f.width, f.height)` → **`this.ctx!.drawImage(f.image, 0, 0, f.width, f.height)`** ← **line 112, insertion point**.
6. `attachTrack(mime, o)` in try/catch (117).
7. `const minGap = o.maxFps > 0 ? 1000 / o.maxFps : 0` (118).
8. `this.off = device.client.on('event.frame', (f: FrameMeta) => {...})` (120–130): dedupes by `f.seq`, throttles by `minGap * 0.9`, `draw()`, `track?.requestFrame?.()`, `this.frames++`, `this.log.push({ t: f.ts ?? f.t, seq: f.seq, position: { ...device.position } })` (128), thumbnail after 800 ms (129).
9. `this.finishStart()` (131).

### Path B — `startStream(label, opts)` (lines 136–163)

Used for the **plain live view**. Reads `/stream.mjpg` directly.

```ts
startStream(label = 'live view', opts: Partial<RecorderOptions> = {}): void
```

Flow:
1. Guards + mime as above (137–140).
2. `this.stabilizer = o.stabilize ? new Stabilizer(defaultStabilizeOptions) : null` (142).
3. `this.margin = o.stabilize ? Math.ceil(defaultStabilizeOptions.maxShiftPx) + 2 : 0` (143). **The recorded frame is smaller than the source by `2 * margin`.**
4. `this.wasMoving = device.moving` (144).
5. `this.mjpeg = new MjpegStream()` (147); `this.mjpeg.start(device.url('/stream.mjpg'), onFrame, onError)` (148–161).
6. On the **first** frame: `beginCanvas(frame.bitmap.width, frame.bitmap.height, mime, o)` (150), `attachTrack` (151), `finishStart()` (153).
7. Every frame: `this.drawStreamFrame(frame)` (155) → `track?.requestFrame?.()` (156) → `this.frames++` (157) → `this.log.push({ t: frame.ts ?? 0, seq: frame.seq, position: { ...device.position } })` (158) → thumbnail at frame 20 (159) → **`frame.bitmap.close()`** (160).
8. `void run.then(() => { if (this.recording) { this.status = 'stream ended'; void this.stop() } })` (162).

### `drawStreamFrame(frame)` (lines 186–202)

```ts
private drawStreamFrame(frame: MjpegFrame): void {
  const { bitmap } = frame
  this.resizeIfNeeded(bitmap.width, bitmap.height)
  let dx = 0, dy = 0
  if (this.stabilizer) {
    const moving = device.moving
    if (moving) { if (!this.wasMoving) this.stabilizer.reset(); this.wasMoving = true }
    else {
      this.wasMoving = false
      const g = this.grayOf(bitmap)
      const r = this.stabilizer.track(g, performance.now() / 1000)
      dx = r.dx; dy = r.dy
    }
  }
  const ctx = this.ctx!
  ctx.drawImage(bitmap, -this.margin - dx, -this.margin - dy, bitmap.width, bitmap.height)   // line 201
}
```

**`line 201` is the single per-frame drawing chokepoint for the stream path.**

`grayOf(bitmap)` at 204–211 uses an `OffscreenCanvas` with `willReadFrequently: true`, downscaled to `GRAY_WIDTH`, and `toGray()` from `algo/sharpness`.

### Canvas + MediaRecorder plumbing

- `beginCanvas(w, h, mime, o)` 165–176: `document.createElement('canvas')`, size `w - 2*margin` × `h - 2*margin`, `getContext('2d')`, resets `chunks`/`log`/`frames`/`thumb`.
- `resizeIfNeeded(w, h)` 178–181.
- `attachTrack(mime, o)` 217–228:
  ```ts
  const stream = this.canvas!.captureStream(0)
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void }
  const manual = typeof track.requestFrame === 'function'
  let streamUsed = stream
  if (!manual) { stream.getVideoTracks().forEach((t) => t.stop()); streamUsed = this.canvas!.captureStream(o.maxFps || 30) }
  this.bitrateMbpsUsed = o.bitrateMbps
  this.rec = new MediaRecorder(streamUsed, { mimeType: mime, videoBitsPerSecond: Math.round(o.bitrateMbps * 1e6) })
  this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data) }
  this.rec.start(1000)
  return manual ? track : null
  ```
- `captureThumbnail()` 230–232: `canvas.toBlob(..., 'image/jpeg', 0.8)`.
- `finishStart()` 234–240: starts `startedAt`, a 500 ms `seconds` clock, sets `recording = true`, and takes `this.releaseActivity = activity.hold('video recording')`.

### Frame timestamps

`VideoFrameLog` is declared in `src/lib/store/gallery.ts:21`:
```ts
export interface VideoFrameLog { t: number; seq: number; position: { x: number; y: number; z: number } }
```
`t` is **nanoseconds on CLOCK_BOOTTIME**, the same clock as libcamera `SensorTimestamp`. Path A pushes `f.ts ?? f.t` (line 128); Path B pushes `frame.ts ?? 0` (line 158).

### `stop()` → `saveVideo` (lines 244–271)

```ts
async stop(): Promise<GalleryItem | null>
```
1. If not recording: release the activity hold and return null (245).
2. `recording = false`; `this.off?.()`; `this.mjpeg?.stop()`; `clearInterval(this.clock)` (246–249).
3. `rec.stop()` and await `onstop` (252–253).
4. `durationS = (performance.now() - this.startedAt) / 1000` (254).
5. `const blob = new Blob(this.chunks, { type: rec.mimeType || this.mimeUsed || 'video/webm' })` (255).
6. Thumbnail fallback via `canvas.toBlob` (256).
7. **Lines 261–264**:
   ```ts
   const item = await saveVideo(blob, thumb, {
     durationS, fps, source: this.label, width: this.canvas!.width, height: this.canvas!.height,
     position: { ...device.position },
     codec: Recorder.codecOf(this.mimeUsed), bitrateBps: Math.round(this.bitrateMbpsUsed * 1e6), frames: log,
   })
   ```
8. `finally { this.releaseActivity?.(); this.releaseActivity = null }` (268–270) — a leaked hold pins the device awake.

Singleton export at **line 274**: `export const recorder = new Recorder()`.

### Where a LUT / enhance stage goes

- **Per-frame**: after `ctx.drawImage` at **line 201** (stream path) and **line 112** (live-stack path). Either set `ctx.filter` before the draw, or do `getImageData` → transform → `putImageData`, or `drawImage` through a second offscreen canvas. A WebGL pass would need its own canvas feeding `captureStream`.
- **Option plumbing**: add fields to `RecorderOptions` (31–40), thread through `PhotoPanel.toggleRecord()` (`PhotoPanel.svelte:102–117`) and Settings defaults.
- **Provenance**: `GalleryItem['video'].stabilised` is declared at `gallery.ts:61` but **`saveVideo` never writes it** (`gallery.ts:214`). A new `lut` / `enhanced` field would need adding both to the interface and to the `saveVideo` body, and to the Viewer details block at `Viewer.svelte:231–234`.

---

## 3. Gallery storage, Gallery route, Viewer

### 3a. `src/lib/store/gallery.ts` (313 lines)

#### Item kinds
**Line 6**: `export type ItemKind = 'snapshot' | 'scan' | 'video' | 'timelapse'`

#### `GalleryItem` (lines 23–106)

```ts
export interface GalleryItem {
  id: string                                             // 24
  kind: ItemKind                                         // 25
  name: string                                           // 26
  when: string                                           // 27  ISO
  position?: { x: number; y: number; z: number }         // 28
  controls?: object                                      // 29
  width?: number                                         // 30
  height?: number                                        // 31
  blobs: string[]                                        // 33  'image' | 'thumb' | 'tile/<n>' | ...
  stack?: {                                              // 36–47
    slices: number; stepZ: number; zs: number[]; contributions: number[]
    method?: 'blocks' | 'pyramid'; centreZ?: number; span?: number
    shifts?: { dx: number; dy: number }[]; source?: 'jpeg' | 'raw'
    depth?: { minZ: number; maxZ: number; colorMap: 'ramp'; unit?: 'steps' | 'µm'; umPerStep?: number }   // 46
  }
  superres?: {                                           // 51–55
    frames: number; used?: number; scale: number; pixfrac?: number; sharpened?: boolean
    shifts: { dx: number; dy: number; quality: number; confident?: boolean }[]
    crop: { width: number; height: number; x0: number; y0: number } | null
  }
  video?: {                                              // 57–63
    durationS: number; fps: number; source: string; mime: string
    codec?: string; bitrateBps?: number; frameCount?: number; frameLog?: string
    stabilised?: boolean                                 // 61  declared but never written
  }
  timelapse?: {                                          // 67–71
    intervalMs: number; source: 'stream' | 'full'; driftCorrected: boolean; frames: TimelapseFrameMeta[]
    format?: 'jpeg' | 'png'; locked?: { ae: boolean; awb: boolean }
    remeterEveryN?: number; refocusDropPct?: number; skipped?: number; startedAt?: string
  }
  raw?: { bitDepth: number; bayer: string; blackLevel: number; gains: [number, number]
          applied?: { lsc: boolean; ccm: boolean; gammaCurve: boolean; demosaic: string } }   // 73
  capture?: { meta: Record<string, unknown> | null; umPerPx?: number; scaleSource?: 'manual' | 'stage' }  // 78
  scan?: { ... }                                         // 79–103
  sample?: SampleRecord                                  // 105
}
```

`TimelapseFrameMeta` at **lines 14–17**:
```ts
export interface TimelapseFrameMeta {
  t: string; z: number; shift: { dx: number; dy: number }
  measureWidth?: number; slot?: number; sharpness?: number; refocused?: boolean; remetered?: boolean
}
```

#### Blob keys in use

Free-form strings held in `item.blobs`. Observed keys across the codebase:

| Key | Written by | Type |
|---|---|---|
| `image` | `saveSnapshot` (gallery.ts:200) | JPEG or 16-bit PNG |
| `thumb` | `saveSnapshot` (201), `saveVideo` (218), `saveTimelapse` (237) | JPEG |
| `video` | `saveVideo` (217) | WebM/MP4 |
| `frames` | `saveVideo` (219) | `application/json`, `VideoFrameLog[]` |
| `dng` | `rawPhoto.ts:64` via `extraBlobs` | `image/x-adobe-dng` |
| `preview` | `rawPhoto.ts:64` | JPEG |
| `depth`, `relief` | fine-stack path via `extraBlobs` | PNG |
| `depth.bin` | fine-stack path | `application/octet-stream` |
| `tile/<n>` | scan | JPEG |
| `f0000`…`fNNNN` | `saveTimelapse` (230, 236) | JPEG/PNG |

#### IndexedDB schema and versioning

**Line 108**: `const DB = 'openflexito', VERSION = 2`

**Lines 110–122**:
```ts
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' }).createIndex('when', 'when')
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs')
      if (!db.objectStoreNames.contains('embeddings')) db.createObjectStore('embeddings', { keyPath: 'key' }).createIndex('item', 'item')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
```

**Rules for adding safely**:
- **A new blob kind needs NO schema change.** The `blobs` store is keyless; keys are `\`${id}/${name}\`` via `blobKey` at **line 136**. Add the name to `item.blobs` and `putBlob(id, name, blob)`.
- **A new optional item field needs NO schema change.** Items are whole-object `put`s (`putItem` at 150–152). All existing items simply lack the field; read sites must treat it as optional (the codebase's `stack.depth.umPerStep` at line 46 is the documented precedent for "additive field, fall back gracefully").
- **Only a brand-new object store requires bumping `VERSION`** and adding another guarded `if (!db.objectStoreNames.contains(...)) db.createObjectStore(...)` line. Never remove an existing guard.
- **Line 148**: `const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v))` — `putItem` runs everything through this because structured clone cannot serialise Svelte `$state` proxies. Never hand a rune proxy to `putItem`.

#### API surface

```ts
function tx<T>(store, mode, fn): Promise<T>                       // 124–132, re-exported as _tx at 134
export const newId = () => ...                                    // 135
export async function listItems(): Promise<GalleryItem[]>         // 138–141  sorted by `when` desc
export async function getItem(id): Promise<GalleryItem|undefined>  // 143–145
export async function putItem(item: GalleryItem): Promise<void>   // 150–152
export async function putBlob(id, name, blob): Promise<string>    // 154–157
export async function getBlob(id, name): Promise<Blob|undefined>  // 159–161
export interface Embedding { key; item; blob; model; vector }     // 163
export async function putEmbedding(e)                             // 165
export async function allEmbeddings()                             // 166
export async function deleteEmbeddingsFor(itemId)                 // 167–170
export async function deleteItem(item)                            // 172–176
export async function makeThumb(blob, size = 256): Promise<Blob>  // 178–185  OffscreenCanvas, JPEG q0.8
```

#### `saveSnapshot` (lines 187–205) — the hook for "save enhanced as new item"

```ts
export async function saveSnapshot(blob: Blob, meta: {
  position?: GalleryItem['position']
  controls?: object
  name?: string
  /** extra item fields (stack, raw) and extra blobs (slices, raw data) stored alongside the image */
  extra?: Partial<Pick<GalleryItem, 'stack' | 'raw' | 'superres' | 'capture'>>
  extraBlobs?: Record<string, Blob>
  thumbFrom?: Blob
  size?: { width: number; height: number }
}): Promise<GalleryItem>
```

Body: `newId()` (190) → size from `meta.size` or `createImageBitmap` (191) → item built at 193–198 with `kind: 'snapshot'`, `blobs: ['image', 'thumb', ...extraNames]`, `sample: currentSample()`, spread `...(meta.extra ?? {})` → `putBlob(id,'image',blob)` (200) → `putBlob(id,'thumb', await makeThumb(...))` (201) → each extra blob (202) → `putItem` (203).

**To add an `enhance` provenance field**: add `enhance?: {...}` to `GalleryItem` and widen the `Pick<>` union at line 189 to `'stack' | 'raw' | 'superres' | 'capture' | 'enhance'`. Nothing else changes.

#### `saveVideo` (lines 207–222)

```ts
export async function saveVideo(blob: Blob, thumb: Blob | null, meta: {
  durationS: number; fps: number; source: string; width: number; height: number
  position?: GalleryItem['position']; codec?: string; bitrateBps?: number; frames?: VideoFrameLog[]
}): Promise<GalleryItem>
```
Name is `` `Video ${meta.source} ${meta.durationS.toFixed(0)} s` `` (212). Blobs `['video', 'thumb'?, 'frames'?]` (213).

#### `saveTimelapse` (lines 224–240)

```ts
export async function saveTimelapse(frames: Blob[], frameMeta: TimelapseFrameMeta[],
  info: Omit<NonNullable<GalleryItem['timelapse']>, 'frames'>): Promise<GalleryItem>
```

#### Export functions (lines 242–313)

- `itemFiles(item)` **245–255** (private): for each blob key, `getBlob`, infer extension at **line 250**:
  ```ts
  const ext = blob.type === 'image/png' ? 'png'
    : blob.type === 'image/x-adobe-dng' ? 'dng'
    : blob.type.startsWith('video/webm') ? 'webm'
    : blob.type.startsWith('video/') ? 'mp4'
    : blob.type === 'application/octet-stream' ? 'bin'
    : blob.type === 'application/json' ? 'json' : 'jpg'
  files.push({ name: blobFileName(item, b, ext), blob })
  ```
  then appends `` `${fileStem(item)}.json` `` with the whole item (253).
- `downloadFile(f)` **257–261**: anchor + `URL.createObjectURL`, revoked after 10 s.
- `export async function exportItem(item): Promise<void>` **264–276**: `showDirectoryPicker()` when available, else per-file downloads.
- `csvCell` **278**.
- `export async function exportSampleBundle(items, sampleName): Promise<void>` **283–313**: writes `<sample>-index.csv` plus one subfolder per item named `fileStem(it)`.

#### Naming — `src/lib/algo/naming.ts`

```ts
export interface Nameable                                       // line 6
export function slug(s: string, max = 40): string               // 15
export function timestampStem(when: string | Date, local = true): string   // 23
export function fileStem(item: Nameable, opts: { local?: boolean } = {}): string   // 37
export function blobFileName(item: Nameable, blob: string, ext: string): string    // 51
```
Format documented in CLAUDE.md: `YYYYMMDD-HHMMSS_sample_label_x_y_z_blob.ext`. Pure and shared by every export path; a new blob key automatically gets a correct filename.

### 3b. `src/components/Viewer.svelte` (274 lines)

#### Props (line 27)
```ts
let { blob = null, width, item, onclose, onSampleChange }: {
  blob?: Blob | null; width?: number; item?: GalleryItem
  onclose: () => void; onSampleChange?: (s: SampleRecord) => void
} = $props()
```

#### Display path

- **OpenSeadragon** for images, constructed in `onMount` at **lines 90–93**:
  ```ts
  viewer = OpenSeadragon({
    element: el!, prefixUrl: '', showNavigationControl: false, showNavigator: true,
    navigatorPosition: 'BOTTOM_RIGHT',
    tileSources: { type: 'image', url, buildPyramid: true } as any,
    maxZoomPixelRatio: 4, animationTime: 0.4, gestureSettingsMouse: { clickToZoom: false },
  })
  ```
  `url` is `URL.createObjectURL(blob)` (88).
- **Video**: plain `<video class="video" src={videoUrl} controls autoplay loop={videoShouldLoop}>` at **line 182**. `videoShouldLoop` at 64 (`durationS > 3`). `isVideo` at 31 (`blob.type.startsWith('video/')`).
- **Time-lapse**: delegates to `<TimelapseViewer {item} />` at **line 179**, gated on `isTimelapse` at 30.

#### The blob-swap mechanism — copy this for Enhance

- **Line 49**: `const hasDepth = $derived(!!item?.stack?.depth && !isVideo && !isTimelapse)`
- **Line 50**: `let mode = $state<'image' | 'depth' | 'relief'>('image')`
- **Line 69**: `let viewBlob = $state<Blob | null>(blob)` (with a `svelte-ignore state_referenced_locally`)
- **Lines 70–74**:
  ```ts
  $effect(() => {
    if (!hasDepth || mode === 'image') { viewBlob = blob; return }
    const wanted = mode, id = item!.id
    getBlob(id, wanted).then((b) => { if (b) viewBlob = b })
  })
  ```
- **Lines 75–83**:
  ```ts
  let shown: Blob | null = null
  $effect(() => {
    const b = viewBlob
    if (!viewer || !b || b === shown) return
    shown = b
    const url = URL.createObjectURL(b)
    viewer.open({ type: 'image', url, buildPyramid: true } as any)
    return () => URL.revokeObjectURL(url)
  })
  ```
- **Mode switcher UI, lines 171–177**:
  ```svelte
  {#if hasDepth}
    <div class="modes">
      <button class:on={mode === 'image'} onclick={() => (mode = 'image')}>Image</button>
      <button class:on={mode === 'depth'} onclick={() => (mode = 'depth')}>Depth map</button>
      <button class:on={mode === 'relief'} onclick={() => (mode = 'relief')}>Relief</button>
    </div>
  {/if}
  ```
  Styles at 272–273: `.modes { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 51; display: flex; gap: 6px; }`

**Enhance panel recipe**: mirror this. Compute the enhanced result to a Blob, assign it to `viewBlob` (the effect at 76 reopens OSD automatically), add an `Enhanced` button next to `.modes`, and offer **Save as new item** calling `saveSnapshot(enhancedBlob, { position: item.position, controls: item.controls, name: \`${item.name} enhanced\`, extra: { enhance: {...}, capture: item.capture }, size: { width, height } })`. `currentSample()` inside `saveSnapshot` will overwrite `sample`, so copy the source item's sample afterwards with `putItem` if it must be preserved exactly.

#### Docked side panel precedent

- **Line 203**: `<div class="measure-dock"><MeasurePanel compact /></div>`
- **Line 264**: `.measure-dock { position: absolute; right: 12px; top: 52px; width: 260px; z-index: 51; max-height: calc(100vh - 80px); overflow: auto; }`

This is the right place for an Enhance control panel with sliders and a live preview.

#### Other chrome

| Element | Lines |
|---|---|
| close button | 164, style 256 |
| sample toggle + editor | 165–167, 237–248, styles 265, 270–271 |
| details toggle + panel | 168–170, 206–236, styles 266–269 |
| height-map overlay | 204 (`{#if item?.scan}<HeightMapOverlay {item} />`) |
| measurement SVG overlay | 185–200, `toScreen` helper 155–160 |
| scale bar | 201, `umPerPxHere` 148–151, `scaleBar` 152 |

Zoom bookkeeping: `imgPxPerScreenPx` at 33, `refreshZoom()` 35–41, handlers registered at 94–96 for `open`/`animation`/`resize`.

Keyboard: `onKey` 107–111 — `m` toggles measurement, `Escape` cancels or closes. `syncGestures()` 116–122 disables OSD mouse nav while measuring.

Details panel content (206–236) currently renders Capture (208–220), Focus stack (221–225), Super-resolution (226–230), Video (231–234). **An "Enhanced" block belongs here**, following the `<div class="d-title">` idiom.

### 3c. `src/routes/Gallery.svelte` (186 lines)

- State: `items` (23), `thumbs: Record<string,string>` (24), `viewing: { blob; item } | null` (25), `busy` (26), `metaFilter` (29), `groupBySample` (30), `query`/`hits`/`indexing` (9–11).
- `refresh()` **58–63**: `listItems()`, then object-URLs for every `thumb` blob.
- `open(it)` **66–70**:
  ```ts
  if (it.kind === 'timelapse') { viewing = { blob: null, item: it }; return }
  const blob = await getBlob(it.id, it.kind === 'video' ? 'video' : 'image')
  if (blob) viewing = { blob, item: it }
  ```
- `remove(it)` 71–74, `doExport(it)` 75, `exportSample(name, its)` 47–50, `onSampleChange(it, s)` 51–56.
- Card snippet **114–150**. Chips at **121–135** — this is where a "LUT" or "enhanced" badge goes, e.g. beside the RAW chip at 131 and the stack chip at 132.
- Viewer mount **165**: `<Viewer blob={v.blob} width={v.item.width} item={v.item} onSampleChange={(s) => onSampleChange(v.item, s)} onclose={() => (viewing = null)} />`
- Grid styles 170–174; mobile breakpoint 182–186 (`minmax(150px, 1fr)`).

---

## 4. Time-lapse playback — `src/components/TimelapseViewer.svelte` (155 lines)

Frames are drawn onto a **plain `<canvas>`**, not OpenSeadragon.

- **Line 133**: `<canvas bind:this={canvas} style:transform={cssTransform(zp)}></canvas>`
- **Lines 90–101** — the whole render path:
  ```ts
  async function draw(i: number): Promise<void> {
    const blob = await getBlob(item.id, `f${String(i).padStart(4, '0')}`)
    if (!blob || !canvas) return
    const bmp = await createImageBitmap(blob)
    if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height }
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const shift = stabilised ? playbackShift(meta.frames[i], bmp.width) : { dx: 0, dy: 0 }
    ctx.drawImage(bmp, -shift.dx, -shift.dy)      // line 99  ← LUT insertion point
    bmp.close()
  }
  ```
- **Line 102**: `$effect(() => { void draw(index) })`

**LUT insertion**: immediately after line 99, either `getImageData` → apply → `putImageData`, or draw the bitmap into an offscreen canvas, apply, then `drawImage` the result. Note `bmp.close()` at 100 must stay after any use of the bitmap.

Zoom/pan is a **CSS transform on the canvas** (line 133), so pixel processing is unaffected by zoom. Maths lives in `src/lib/input/zoomPan.ts`: `IDENTITY`, `cssTransform`, `normalize`, `panBy`, `pinchDistance`, `pinchMidpoint`, `zoomAt`, `ZoomPanState` (imported at line 16). Handlers `zoomDown` 44–54, `zoomMove` 55–68, `zoomEnd` 69–82, `zoomCancel` 83, `zoomWheel` 84–88.

Playback: `index` (22), `playing` (23), `stabilised` (24), `togglePlay()` 104–108 with interval `Math.max(80, Math.min(500, meta.intervalMs / 10))`.

Controls bar **135–143**: Play/Pause, range scrubber, frame label, "drift-free" checkbox, **Export WebM** (140 → `exportVideo()` 111–115 → `exportTimelapseWebm(item, { stabilised })` from `src/lib/services/timelapse.svelte.ts`), **Track organisms** (141), **Export CSV** (142).

**Important**: if a LUT is applied in `draw()`, `exportTimelapseWebm` must apply the same LUT or the exported video will not match the preview.

---

## 5. Settings — `src/lib/store/settings.svelte.ts` (71 lines)

### Full interface (lines 5–40)

```ts
export interface Settings {
  deviceUrl: string        // '' = same origin
  stepXY: number
  stepZ: number
  gamepad: boolean
  invertYKeys: boolean
  showLores: boolean
  detectModel: string
  clipModel: string
  detectThreshold: number
  detectIntervalMs: number
  followDeadbandPx: number
  followIntervalMs: number
  lightPresets: Record<string, { cc: number; pwm: number[] }>
  stageStepUm: { x: number; y: number; z: number }
  showScaleBar: boolean
  videoCodec: string          // mirrors VideoCodec but kept as string, see note
  videoBitrateMbps: number
  videoStabilise: boolean
  superresScale: 2 | 3
  superresPixfrac: number
  superresSharpen: boolean
}
```

The comment at **lines 30–32** is load-bearing: `videoCodec` is `string` rather than the `VideoCodec` union **to avoid a runtime import into this plain settings module**. A LUT setting that references a type from a service must follow the same rule.

### Defaults (lines 42–56)

```ts
const defaults: Settings = {
  deviceUrl: '', stepXY: 500, stepZ: 100, gamepad: true, invertYKeys: false, showLores: false,
  detectModel: 'Xenova/yolos-tiny', clipModel: 'Xenova/clip-vit-base-patch32',
  detectThreshold: 0.5, detectIntervalMs: 800,
  followDeadbandPx: 12, followIntervalMs: 400,
  lightPresets: {
    Brightfield: { cc: 0.32, pwm: [0, 0] },
    Darkfield:   { cc: 0,    pwm: [1, 0] },
    Oblique:     { cc: 0,    pwm: [0, 1] },
    Rheinberg:   { cc: 0.1,  pwm: [1, 0] },
  },
  stageStepUm: { x: 0.088, y: 0.088, z: 0.050 },
  showScaleBar: true,
  videoCodec: 'vp9', videoBitrateMbps: 12, videoStabilise: true,
  superresScale: 2, superresPixfrac: 0.5, superresSharpen: false,
}
```

### Persistence (lines 3, 58–71)

```ts
const KEY = 'openflexito.settings'
function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults }
  } catch { return { ...defaults } }
}
export const settings = $state<Settings>(load())
export function saveSettings(): void {
  try { localStorage.setItem(KEY, JSON.stringify(settings)) } catch { /* private mode etc. */ }
}
```

**New fields are additive and safe**: `{ ...defaults, ...parsed }` means an old stored blob simply picks up the new default.

### Pattern for adding a settings group (`src/routes/Settings.svelte`)

Every group is a `<div class="panel"><h3>Title</h3>…</div>` with `bind:value` / `bind:checked` straight onto `settings.*` and `onchange={saveSettings}`. Examples:

- Scale group, **lines 120–126**:
  ```svelte
  <div class="row">
    {#each ['x', 'y', 'z'] as const as a}
      <div><div class="label">{a} µm/step</div>
      <input class="mono" type="number" step="0.001" min="0" style="width:90px"
             bind:value={settings.stageStepUm[a]} onchange={saveSettings} /></div>
    {/each}
    <label style="display:flex;gap:8px;align-items:center;margin-left:auto">
      <input type="checkbox" bind:checked={settings.showScaleBar} onchange={saveSettings} /> show scale bar
    </label>
  </div>
  ```
- Input group, **128–133**.
- Intelligence group, **161–175** (text inputs for HF model ids, numeric thresholds).
- **Capture defaults group, from line 196** — the closest analogue for LUT/enhance defaults:
  ```svelte
  <div class="panel">
    <h3>Capture defaults</h3>
    <p class="muted" style="font-size:12px;margin:0 0 8px">Defaults for the Photo panel's ... (also editable there; changes here persist the same way).</p>
    <div class="row">
      <div><div class="label">video codec</div>
        <select bind:value={settings.videoCodec} onchange={saveSettings}>
          <option value="vp9">VP9</option><option value="av1">AV1</option><option value="vp8">VP8</option>
        </select>
      </div>
      ...
    </div>
  </div>
  ```

Settings route also owns: device logs (lines 20–56), stage backlash/invert (137–158), still-quality toggle (177–194), RPC schema listing. Local state declared at 6–19.

---

## 6. Workers

### `src/lib/workers/workerUtil.ts` (12 lines, complete)

```ts
/** Shared worker plumbing. `defineWorker` installs the message handler and turns any exception into an
 *  `{ error }` message, so a bug in an algorithm surfaces in the caller's status line instead of
 *  killing the worker silently. `post` is `postMessage` with an optional transfer list. */
export function post(message: unknown, transfer: Transferable[] = []): void {
  ;(self as unknown as Worker).postMessage(message, transfer)
}

export function defineWorker<M>(handler: (m: M) => void | Promise<void>): void {
  self.onmessage = async (ev: MessageEvent<M>) => {
    try { await handler(ev.data) } catch (e) { post({ error: (e as Error).message }) }
  }
}
```

### Example worker — `src/lib/workers/rawWorker.ts` (51 lines, complete shape)

```ts
import { defineWorker, post } from './workerUtil'
import { parseRaw, type RawTrailer } from '../algo/raw'
import { develop, toRgba8, type DevelopOptions } from '../algo/rawdev'
import { encodePng16 } from '../algo/png16'
import { encodeDng } from '../algo/dng'
import type { FlatField } from '../algo/flatField'

export interface RawDevelopRequest {                       // 10–16
  buffer: ArrayBuffer; gains?: [number, number]; exposure?: number
  params?: Pick<DevelopOptions, 'lsc' | 'ccm' | 'gammaCurve'>
  flatField?: FlatField | null
  model?: string; want?: 'files' | 'rgb16'
}
export interface RawRgb16Result { rgb16: Uint16Array; width; height; bitDepth; bayer; meta: RawTrailer | null }   // 17
export interface RawDevelopResult {                        // 18–24
  png: Blob; dng: Blob; preview: { data: Uint8ClampedArray; width: number; height: number }
  width; height; bitDepth; bayer; blackLevel
  meta: RawTrailer | null
  applied: { lsc: boolean; ccm: boolean; gammaCurve: boolean; demosaic: 'malvar'; flatField: boolean }
}

defineWorker<RawDevelopRequest>(async (m) => {             // 26–51
  const raw = parseRaw(m.buffer)
  const p = m.params ?? {}
  const gains = (raw.meta?.colour_gains as [number, number] | undefined) ?? m.gains   // 30
  const ccm = (raw.meta?.ccm as number[] | undefined) ?? p.ccm                        // 31
  post({ progress: `developing ...` })                                                // 32
  const img = develop(raw, { gains, exposure: m.exposure, lsc: p.lsc, flatField: m.flatField, ccm, gammaCurve: p.gammaCurve, demosaic: 'malvar' })  // 33
  if (m.want === 'rgb16') { ...; post({ result }, [img.data.buffer]); return }        // 34–38
  post({ progress: 'encoding 16-bit PNG' })
  const png = await encodePng16(img.data, img.width, img.height)                      // 40
  post({ progress: 'writing DNG' })
  const dng = encodeDng(raw, { gains, ccm, model: m.model, flatField: m.flatField, exposureUs: ..., analogueGain: ... })  // 44
  const preview = toRgba8(img, 4)                                                     // 45
  const result: RawDevelopResult = { ... }
  post({ result }, [preview.data.buffer])                                             // 50
})
```

**Message protocol**: `{ progress: string }` during the run, `{ result: T }` at the end with transferables, `{ error: string }` from `defineWorker`'s catch.

### Instantiation — always the same form

```ts
new Worker(new URL('../workers/xWorker.ts', import.meta.url), { type: 'module' })
```

All eight call sites:

| File:line | Worker |
|---|---|
| `src/lib/services/stitchService.ts:5` | `stitchWorker.ts` |
| `src/lib/services/liveStack.svelte.ts:39` | `liveStackWorker.ts` |
| `src/lib/services/aiService.svelte.ts:16` | `aiWorker.ts` |
| `src/lib/services/photo/superres.ts:163` | `superresWorker.ts` |
| `src/lib/services/photo/superres.ts:280` | `superresWorker.ts` |
| `src/lib/services/photo/rawPhoto.ts:35` | `rawWorker.ts` |
| `src/lib/services/photo/focusStack.ts:163` | `stackWorker.ts` |
| `src/lib/services/photo/focusStack.ts:287` | `rawWorker.ts` |

### Caller-side promise wrapper to copy — `src/lib/services/photo/rawPhoto.ts:33–44`

```ts
function runRawWorker<T>(req: RawDevelopRequest, say: Say, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const w = new Worker(new URL('../../workers/rawWorker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (ev) => {
      if (ev.data.progress) say(`${label}: ${ev.data.progress}`)
      else if (ev.data.error) { reject(new Error(ev.data.error)); w.terminate() }
      else if (ev.data.result) { resolve(ev.data.result); w.terminate() }
    }
    w.onerror = (e) => { reject(new Error(e.message)); w.terminate() }
    w.postMessage(req, [req.buffer])
  })
}
```

`Say = (m: string) => void` is declared at `src/lib/services/photo/common.ts:11`.

---

## 7. RAW develop — `src/lib/algo/rawdev.ts` (233 lines)

### `DevelopOptions` (lines 23–37)

```ts
export interface DevelopOptions {
  gains?: [number, number]        // red, blue white-balance gains
  gamma?: boolean                 // apply a transfer curve (default true; false = linear)
  gammaCurve?: ArrayLike<number>  // tuning-file curve: flat [in0, out0, in1, out1, ...] on a 16-bit scale
  exposure?: number               // linear multiplier before the curve (default 1)
  lsc?: LensShadingTables | null
  flatField?: FlatField | null    // when present it replaces `lsc`
  ccm?: ArrayLike<number> | null  // 3×3 row-major, camera RGB -> output RGB
  demosaic?: DemosaicMethod
  highlights?: 'desaturate' | 'clip'   // default 'desaturate'
}
```

Supporting types:
```ts
export interface Rgb16 { data: Uint16Array; width: number; height: number }   // 18
export interface RgbF  { data: Float32Array; width: number; height: number }  // 19
export interface LensShadingTables { luminance; cr; cb; cols: number; rows: number }  // 21
```
Re-exports at line 16: `cellColour`, `demosaicMalvar`, `demosaicBilinear`.

### Pipeline stages, in order

| # | Stage | Function | Lines |
|---|---|---|---|
| 1 | black level + lens shading + white balance → float mosaic | `prepareMosaic(raw, opts): Float32Array` | 127–159 |
| 2 | demosaic | `demosaic(m, w, h, bayer, method)` from `demosaic.ts` | called at 195 |
| 3 | highlight desaturation | `desaturateHighlights(rgb, gains, exposure)` | 165–176, called 196 |
| 4 | colour matrix | `applyCcm(rgb, ccm)` | 182–189, called 197 |
| 5 | transfer curve → 16-bit | `encodeRgb16(lin, opts)` using `transferLut` + `encodeValue` | 202–207 |

```ts
export function developLinear(raw: RawImage, opts: DevelopOptions = {}): RgbF   // 192–199
export function encodeRgb16(lin: RgbF, opts: DevelopOptions = {}): Rgb16        // 202–207
export function develop(raw: RawImage, opts: DevelopOptions = {}): Rgb16        // 209–211
export function toRgba8(img: Rgb16, factor = 1): { data: Uint8ClampedArray; width; height }  // 215–233
```

`developLinear` body (192–199):
```ts
const m = prepareMosaic(raw, opts)
const rgb = demosaic(m, w, h, raw.bayer, opts.demosaic ?? 'malvar')
if ((opts.highlights ?? 'desaturate') === 'desaturate') desaturateHighlights(rgb, opts.gains ?? [1, 1], opts.exposure ?? 1)
if (opts.ccm) applyCcm(rgb, opts.ccm)
return { data: rgb, width: w, height: h }
```

`develop` is exactly `encodeRgb16(developLinear(raw, opts), opts)`.

### The existing tone curve — what a LUT must compose with

```ts
const LUT_N = 4096                                                    // 90
export function transferLut(opts: DevelopOptions): Float32Array       // 93–110
export function encodeValue(lut: Float32Array, v: number): number     // 113–118
function srgb(v: number): number                                      // 86–88
```

`transferLut` returns `LUT_N + 1` knots over input 0..1:
- `opts.gamma === false` → identity ramp (96).
- `opts.gammaCurve` with ≥4 entries → piecewise-linear interpolation of the tuning file's `[in, out]` pairs on a 16-bit scale (97–107).
- otherwise sRGB (108).

`encodeValue` does linear interpolation between knots and scales to 0..65535.

### Other exported helpers

```ts
export function interpolateByCt<T>(entries: T[], key: string, length: number, ct?: number): number[] | null  // 42–58
export function developParamsFromTuning(t: Tuning, ct?: number): Pick<DevelopOptions, 'lsc'|'ccm'|'gammaCurve'>  // 63–84
export function desaturateHighlights(rgb: Float32Array, gains: [number, number], exposure = 1): void  // 165–176
export function applyCcm(rgb: Float32Array, ccm: ArrayLike<number>): void   // 182–189
```

`applyCcm`'s docstring at 178–181 states explicitly that it was pulled out of `developLinear` so `algo/drizzle.ts`'s raw-plane super-resolution path can reuse the exact matrix step. **This is the precedent for factoring out an exported `applyLut(rgb, lut)` stage.**

`MAX_LUMINANCE_GAIN` is imported from `./lst` (line 14) and clamps ALSC tables at line 77.

### Where a LUT / enhance stage belongs

- **Technical / linear operations** (denoise, deconvolve, background subtraction, flat-field): between `developLinear` and `encodeRgb16`, operating on the interleaved `Float32Array` where 1.0 = white. That is, a new function called from `develop()` at line 210, or composed by callers that already use `developLinear` + `encodeRgb16` separately (`rawPhoto.ts:8` imports both).
- **Creative / display-referred 3D LUT**: after `encodeRgb16`, on `Uint16Array`, or folded into `transferLut` if it is 1D per channel.
- **CLAHE / tone**: after the transfer curve, since it is a display-referred operation.

Ordering rule the codebase already follows: **CCM before transfer curve, highlights before CCM**. A creative LUT goes last.

### Consumers

- `src/lib/workers/rawWorker.ts:5` imports `develop`, `toRgba8`, `DevelopOptions`; calls `develop` at 33 and `toRgba8(img, 4)` at 45.
- `src/lib/services/photo/rawPhoto.ts:8` imports `developParamsFromTuning`, `developLinear`, `encodeRgb16`, `toRgba8`, `DevelopOptions`.
  - `liveGains()` 19–22, `tuningParams()` 24–26, `currentFlatField()` 29–31, `runRawWorker` 33–44, `developRawBuffer(say, frames, label)` 48–54, `saveRawResult(result, gains, meta, name)` 56–66, `captureFlatField(say, frames, opts)` 74–83, `rawPhoto(say, meta)` 86–89.
  - `saveRawResult` at 58–65 writes `extra: { raw: {...applied}, capture: captureField(result.meta) }` and `extraBlobs: { dng, preview }`.
- `src/lib/services/photo/focusStack.ts:287` runs the same worker for the RAW fine stack.

### Types — `src/lib/algo/types.ts` (27 lines, complete)

```ts
export type Axis = 'x' | 'y' | 'z'
export type Vec3 = Record<Axis, number>
export interface FrameMeta {
  seq: number; size: number; stream: 'main' | 'lores'
  ts: number | null   // libcamera SensorTimestamp (ns, CLOCK_BOOTTIME)
  t: number           // device clock when metadata was recorded (ns, same clock)
  exposure?: number | null; gain?: number | null; digital_gain?: number | null
  colour_gains?: number[]; focus_fom?: number | null; lux?: number | null
}
export interface MoveResult { position: Vec3; t0: number; t1: number; start_hw: Vec3; end_hw: Vec3; cancelled: boolean }
```

**`Rgba` is NOT here.** It lives at `src/lib/algo/stack.ts:10`:
```ts
export interface Rgba { data: Uint8ClampedArray; width: number; height: number }
```
and is re-exported by `src/lib/services/photo/common.ts:10` (`export type { Rgba }`).

`src/lib/api/types.ts` (116 lines) re-exports the algo types at line 1 and adds device-facing types: `PositionEvent` (4), `StageStatus` (14), `CameraControls` (29: `AeEnable`, `AwbEnable`, `ExposureTime`, `AnalogueGain`, `ColourGains`, `Brightness`, `Contrast`, `Saturation`, `Sharpness`), `CameraStatus` (41), `LedState` (57), `NetworkInterface` (59), `NetworkStatus` (71), `PowerStatus` (89), `DeviceStatus` (101), `RpcMethodDoc` (112).

---

## 8. Live route panel structure — `src/routes/Live.svelte` + `CameraControls.svelte` + `PhotoPanel.svelte`

### 8a. `src/routes/Live.svelte` (293 lines)

#### Layout

```css
.live { display: grid; grid-template-columns: 1fr 360px; height: 100%; }          /* 275 */
.stream { position: relative; min-width: 0; }                                      /* 276 */
aside { display: flex; flex-direction: column; gap: 10px; padding: 10px;
        overflow: auto; border-left: 1px solid var(--border); }                    /* 277 */
@media (max-width: 720px) {                                                        /* 284–292 */
  .live { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  .stream { width: 100%; aspect-ratio: 4 / 3; max-height: 60vh; }
  aside { border-left: 0; padding-bottom: calc(10px + var(--tabbar-h, 0px)); }
  .hits { grid-template-columns: repeat(3, 1fr); }
}
```

#### `<section class="stream">` (lines 181–190)

```svelte
<StreamView {boxes} paths={trackPaths} {panOffset} onpan={onPan} onclickimage={onClickImage}
  onselectregion={onSelectRegion} onclickbox={followBox} picking={wb.picking}
  scaleInfo={settings.showScaleBar ? currentScale() : null} measuring={measure.active}
  measurePoints={measure.points} measureClosed={measure.mode === 'polygon'}
  onmeasureclick={onMeasureClick} onmeasuredblclick={onMeasureDblClick} />
```
Plus floating `.hint` overlays at 185–189 for the WB picker, follow status, `ai.status`, `lastClick`, `device.error`.

#### `<aside>` panel order (lines 191–270)

1. `<SamplePanel />` (192)
2. `<StagePad />` (193)
3. **inline Focus panel** (194–231) — contains the Autofocus row (196–207), `afLog` (208), and an `<h4 class="sub">Live view processing</h4>` subsection (209–223) with the live-stack `.seg` segmented control (211–215: Off / Smooth / Stack), Reset + Save buttons (216–219), a `.status-line busy` stats line (221–223), and a `<details class="help">` explainer (224–230).
4. `<PhotoPanel />` (232)
5. `<MeasurePanel />` (233)
6. `<TimelapsePanel />` (234)
7. `<CameraControls />` (235)
8. `<LightControl />` (236)
9. `<TrackingPanel />` (237)
10. **inline Intelligence panel** (238–260)
11. `<MacroPanel />` (261)
12. **inline help panel** (262–269)

**Recommended placement**: a `<LookPanel />` (LUT) immediately after the inline Focus panel at line 231, next to the existing live-view processing controls, and an `<EnhancePanel />` right after it. Both are plain components rendered in this flat list; there is no tab or accordion machinery to hook into.

#### Other Live state worth knowing

- Pan: `panner: PanController | null` (45), `panOffset` (46), `panScale` (47), `onPan(p)` 48–69, `refreshPanOffset()` 72–76.
- Detection: `detecting` (79), `detections` (80), `detectLoop()` 87–94, `toggleDetect()` 95–99, `boxes` derived 100–103, `trackPaths` derived 104–106.
- Search: `onSelectRegion(r)` 108–122, `openHit(h)` 123.
- Autofocus: `focusing` (126), `afMode` (127), `afRange` (128), `afLog` (129), `autofocus()` 131–144.
- `onMount` 146–162 wires `JogController`, keyboard, gamepad, and an `onKey` handler for `m`/`Escape`; teardown at 161 stops detection, follow, `liveStack`, `tracking`.
- `onClickImage(p)` 164–177 handles WB picking and click-to-centre.
- `<Viewer blob={viewing} onclose={...} />` at 272 for search-hit previews (no `item`, no `onSampleChange`).

### 8b. `src/components/CameraControls.svelte` (97 lines) — the controls-panel style reference

```ts
const c = $derived(device.controls)                                  // 9
const live = $derived(device.frame)                                  // 10
const exposure = $derived(c?.AeEnable && live?.exposure ? live.exposure : c?.ExposureTime ?? 0)   // 11
const gain = $derived(...)                                           // 12
const gains = $derived<[number, number]>(...)                        // 13
const tt = $derived(gainsToTempTint(gains[0], gains[1]))             // 14
let busy = $state(false)                                             // 15
let timer; let pending: Record<string, unknown> = {}                 // 16–17

function set(patch: Record<string, unknown>) {                       // 22–29  MERGED 120 ms debounce
  pending = { ...pending, ...patch }
  clearTimeout(timer)
  timer = setTimeout(async () => {
    const p = pending; pending = {}
    busy = true; try { await device.setControls(p) } finally { busy = false }
  }, 120)
}
function toggleAe(on: boolean)     // 32–34   freezes current live values when switching off
function toggleAwb(on: boolean)    // 35–37
function setTempTint(temp, tint)   // 38–41
const expToSlider = (us) => Math.log10(Math.max(50, us))   // 42
const sliderToExp = (v) => Math.round(10 ** v)             // 43
const fmtExp = (us) => ...                                 // 44
```

Markup idiom (47–60+): `<div class="panel"><h3>Camera</h3>`, `<h4 class="sub">Exposure</h4>`, `<div class="kv"><span>Label</span><span class="v">value<span class="auto">auto</span></span></div>`, `<input type="range" ... oninput={...} />`, `<label class="check"><input type="checkbox" ... /> text</label>`.

Also embeds `<FlickerCheck />` and `<Histogram />` (imported at 6–7).

**The merged-debounce comment at lines 19–21 is a real past bug**: clearing the timer used to drop the previous patch, so two changes within 120 ms lost the first. Any new panel that batches device writes must merge, not replace.

### 8c. `src/components/PhotoPanel.svelte` (264 lines) — how modes are picked

#### Mode state and table

```ts
let mode = $state<PhotoMode>('single')                               // 13
const modes: { id: PhotoMode; label: string; blurb: string; time: string }[] = [   // 42–52
  { id: 'single',        label: 'Single',              blurb: '…', time: '~2 s' },
  { id: 'raw',           label: 'RAW',                 blurb: '…', time: '~25 s' },
  { id: 'rawavg',        label: 'RAW average',         blurb: '…', time: '~25 s' },
  { id: 'focus',         label: 'Quick stack',         blurb: '…', time: '~4 s per slice' },
  { id: 'focusfine',     label: 'Fine stack',          blurb: '…', time: '~3 s per slice' },
  { id: 'focusfineraw',  label: 'Fine stack from RAW', blurb: '…', time: '~30 s per slice' },
  { id: 'exposure',      label: 'LED exposure stack',  blurb: '…', time: '~10 s' },
  { id: 'hdrraw',        label: 'HDR (RAW)',           blurb: '…', time: '~40 s' },
  { id: 'superres',      label: 'Super-resolution',    blurb: '…', time: '~3 s per frame + fusing' },
]
const current = $derived(modes.find((m) => m.id === mode)!)          // 53
const isRawFrameMode = $derived(...)                                  // 54
const netAdvice = $derived.by(() => {...})                            // 58–68
const isFine = $derived(mode === 'focusfine' || mode === 'focusfineraw')   // 69
const isSuperres = $derived(mode === 'superres')                      // 70
const isExposure = $derived(mode === 'exposure')                      // 71
const isHdrRaw = $derived(mode === 'hdrraw')                          // 72
const isRawavg = $derived(mode === 'rawavg')                          // 73
const stackSpan = $derived(Math.floor((slices - 1) / 2) * stepZ)      // 74
```

#### Mode selector markup

**Lines 156–163**:
```svelte
<div class="kv" style="margin-top:10px"><span>Mode</span><span class="v muted" style="color:var(--muted)">{current.time}</span></div>
<select bind:value={mode} disabled={busy} style="width:100%" aria-label="capture mode">
  {#each modes as m}<option value={m.id}>{m.label}</option>{/each}
</select>
<p class="blurb">{current.blurb}</p>
{#if netAdvice}<p class="blurb" style="color:var(--warn)">{netAdvice}</p>{/if}
```

Per-mode parameter blocks follow as an `{#if mode === 'focus'}{:else if isFine}{:else if isRawavg}{:else if isExposure}…` chain from **line 164**, each a `<div class="params">` of `<label>` + `<input>` pairs, with `<details class="adv"><summary>Advanced</summary>` for secondary knobs (lines 184–194).

**`aria-label="capture mode"` at line 157 is the only accessibility hook the e2e suite uses for this select.**

#### Capture action

```ts
async function photo() {                                             // 76–93
  busy = true; status = { kind: 'busy', text: 'starting…' }
  const item = await takePhoto({ mode, slices, stepZ, range, method, frames, bracket, levels, factors, superres, onProgress })
  status = { kind: 'ok', text: `saved "${item.name}" to the gallery` }
  macroService.recordAction('photo', {...}, `photo (${mode})`)
}
async function quickFrame()                                          // 94–101
async function download()                                            // 118–…
function saveVideoDefaults() / saveSuperresDefaults()                // ~123, 125
```

#### Recording UI

**Lines 136–155**: the record button (`.rec`, `class:on={recorder.recording}`) and the video settings `.params` block (codec select, bitrate number, Stabilise checkbox), all persisting via `saveVideoDefaults`.

`toggleRecord()` **102–117**:
```ts
function toggleRecord() {
  if (recorder.recording) { void recorder.stop().then((i) => { if (i) status = {...} }); return }
  const useStack = liveStack.active && !!liveStack.composite
  const opts = { codec: vidCodec, bitrateMbps: vidBitrate, stabilize: vidStabilise }
  if (useStack) {
    recorder.start(() => {
      const b = liveStack.composite
      return b ? { image: b, width: b.width, height: b.height } : null
    }, liveStack.mode === 'average' ? 'smoothed view' : 'live stack', { ...opts, stabilize: false })
  } else {
    recorder.startStream('live view', opts)
  }
  if (recorder.status) status = { kind: 'err', text: recorder.status }
}
```

**This is where a "record with LUT" option would be threaded** into `opts`.

#### Mode dispatch — `src/lib/services/photoService.ts`

```ts
export type PhotoMode = 'single' | 'raw' | 'rawavg' | 'focus' | 'focusfine' | 'focusfineraw' | 'exposure' | 'hdrraw' | 'superres'   // 17
export interface PhotoOptions                                        // 18
export async function takePhoto(o: PhotoOptions): Promise<GalleryItem>  // 32
```
CLAUDE.md rule: `photoService.ts` **only dispatches by mode**; capture code lives in `services/photo/*.ts`, one file per mode family.

`src/lib/services/photo/common.ts` helpers:
```ts
export type { Rgba }                                                 // 10
export type Say = (m: string) => void                                // 11
export interface PhotoMeta { position: {x;y;z}; controls?: object }  // 12
export const captureFull = () => fetchSnapshot({ full: true })       // 14
export const captureFullWithMeta = () => fetchSnapshotWithMeta({ full: true })  // 15
export function captureField(meta): NonNullable<GalleryItem['capture']>  // 18
export function ctx2d(w, h): OffscreenCanvasRenderingContext2D       // 24
export async function decode(blob: Blob): Promise<Rgba>              // 29
export async function encode(img: Rgba, quality = 0.95): Promise<Blob>  // 36
export async function encodeRgba8Png(img): Promise<Blob>             // 41
export const encodeRgba8 = (img, quality = 0.9) => encode(img as Rgba, quality)  // 46
export const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))      // 48
```

`src/lib/api/snapshot.ts`:
```ts
export interface StillFrameMeta extends Omit<FrameMeta, 'size'>      // 12
export async function fetchSnapshot(o: { full?: boolean } = {}): Promise<Blob>   // 32
export async function fetchSnapshotWithMeta(o): Promise<{ blob: Blob; meta: StillFrameMeta | null }>  // 39
export async function fetchSnapshotBitmap(o): Promise<ImageBitmap>   // 46
```

### 8d. App-level tab structure — `src/App.svelte`

- `<nav>` at line 42, `.tabs` wrapper at 49, links at 51: `<a href={'#/' + key} class:active={route === key}>{r.label}</a>`.
- Desktop: `.topbar` and `.tabs` are `display: contents` (lines 82, 75–77) so their children become flex items of `nav` directly, reordered with `order` (81, 83, 86).
- Mobile `@media (max-width: 720px)` from line ~94: `nav` becomes a column, `.tabs` becomes a **fixed bottom tab bar** for the 5 routes (108–116), and `main { padding-bottom: var(--tabbar-h); }` at 117.
- Five routes: `live`, `calibrate`, `scan`, `gallery`, `settings`.

---

## 9. Tests

### 9a. Unit tests — `src/lib/algo/__tests__/`

29 test files, one per algo module, named `<module>.test.ts`:

```
align.test.ts            autofocus_track.test.ts   deconvolve.test.ts      demosaic.test.ts
depthMap.test.ts         drift.test.ts             drizzle.test.ts         exposureFuse.test.ts
fftTrack.test.ts         flatField.test.ts         flicker.test.ts         hdr.test.ts
heightMap.test.ts        histogram.test.ts         liveStack.test.ts       macro.test.ts
measure.test.ts          naming.test.ts            png16.test.ts           pyramidFuse.test.ts
raw.test.ts              raw_exposure_lst.test.ts  rawdev.test.ts          register.test.ts
scan_stitch.test.ts      stabilize.test.ts         stack.test.ts           stitch.test.ts
tracking.test.ts
```
Plus a `helpers/` directory.

**New files should be `src/lib/algo/__tests__/lut.test.ts` and `src/lib/algo/__tests__/enhance.test.ts`.**

#### Style, from `rawdev.test.ts` (opening 40 lines)

```ts
import { describe, expect, it } from 'vitest'
import { develop, cellColour, toRgba8, developParamsFromTuning } from '../rawdev'
import { encodePng16 } from '../png16'
import { encodeDng, colorMatrixFromCcm, invert3, mulVec3, D65_XYZ } from '../dng'
import type { RawImage } from '../raw'

// local synthetic-data builder at the top of the file
function flat(r: number, g: number, b: number, w = 16, h = 12, vignette = 0): RawImage {
  const data = new Uint16Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = cellColour('BGGR', x, y)
    const v = c === 'R' ? r : c === 'G' ? g : b
    const f = 1 - vignette * (((x - w / 2) / (w / 2)) ** 2 + ((y - h / 2) / (h / 2)) ** 2) / 2
    data[y * w + x] = 64 + Math.round(v * f)
  }
  return { width: w, height: h, bitDepth: 10, blackLevel: 64, whiteLevel: 1023, bayer: 'BGGR', data, meta: null }
}

// a tiny pixel accessor
const px = (img: { data: Uint16Array; width: number }, x: number, y: number) =>
  [img.data[(y * img.width + x) * 3], img.data[(y * img.width + x) * 3 + 1], img.data[(y * img.width + x) * 3 + 2]]

describe('develop', () => {
  it('subtracts black, applies white balance and keeps 16-bit precision (linear, malvar)', () => {
    const img = develop(flat(200, 400, 100), { gains: [2, 4], gamma: false })
    for (const [x, y] of [[6, 6], [7, 6], [6, 7], [7, 7]] as const) {
      const [r, g, b] = px(img, x, y)
      expect(Math.abs(r - g)).toBeLessThan(80); expect(Math.abs(b - g)).toBeLessThan(80)
      expect(g).toBeCloseTo(Math.round(400 / 959 * 65535), -2)
    }
  })
  it('lens shading tables flatten a vignetted field', () => { /* ratio bounds, not golden images */ })
})
```

**Conventions**: vitest `describe` / `it` / `expect`; synthetic data built in-file; **property assertions** (`toBeCloseTo` with a negative precision, ratio bounds, monotonicity) rather than golden images; no DOM, no fetch, no stores. `lib/algo` must stay importable in plain node.

Run: `cd webapp && npx vitest --run`. Full check: `npm run check && npx vitest --run && npm run build`.

### 9b. Browser e2e — `e2e/app.mjs` (550 lines)

#### Harness (lines 1–32)

```js
import { chromium } from 'playwright'
const base = process.argv[2] || 'http://127.0.0.1:8099'
const moves = process.env.E2E_MOVES !== '0'
const shots = process.env.E2E_SHOTS || ''
const browser = await chromium.launch(process.env.CHROME_EXE
  ? { executablePath: process.env.CHROME_EXE, headless: true }
  : { channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const problems = []
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message.slice(0, 300)}`))
page.on('console', (m) => { if (m.type() === 'error') problems.push(`[console.error] ${m.text().slice(0, 300)}`) })

let failed = 0
async function step(name, fn) {                                       // 17–22
  const t = Date.now()
  try { await fn(); console.log(`ok   ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`) }
  catch (e) { failed++; console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`)
    if (shots) await page.screenshot({ path: `${shots}/fail-${name.replace(/\W+/g, '_')}.png`, timeout: 5000 }).catch(() => {}) }
}
const nav = (tab) => page.click(`nav a[href="#/${tab}"]`)             // 23
async function position() { /* parses x/y/z out of nav innerText */ } // 24–30
const logHas = (re, timeout) => page.waitForFunction(...)             // 31
const expect = (cond, msg) => { if (!cond) throw new Error(msg) }     // 32
await page.goto(`${base}/#/live`, { waitUntil: 'load' })              // 34
```

#### How a step is written

```js
await step('name of the step', async () => { ... })
if (moves) await step('anything that moves the stage', async () => { ... })
```

#### How the UI is selected — **text and structure, no `data-testid` anywhere**

There is **no `data-testid` in the entire codebase**. Selectors in use:

```js
page.click('button:has-text("Take photo")')
page.selectOption('.panel:has(h3:has-text("Photo")) select[aria-label="capture mode"]', 'raw')
page.click('button[title="D / →"]')
page.selectOption('select:near(:text("XY step"))', '500')
page.locator('.card').count()
page.locator('main').innerText()
page.locator('.panel:has(h3:has-text("Photo"))').innerText()
page.waitForFunction(() => /saved "RAW 10-bit/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 120000 })
page.waitForFunction((n) => document.querySelectorAll('.card').length > n, before, { timeout: 8000 })
page.evaluate(async (b) => (await (await fetch(b + '/rpc', { method: 'POST', headers: {...}, body: JSON.stringify({ method: 'system.status', params: {} }) })).json()), base)
```

**Rules for new steps**:
- Scope by panel: `.panel:has(h3:has-text("Look"))` / `.panel:has(h3:has-text("Enhance"))`.
- Give any new `<select>` an `aria-label`, as `PhotoPanel.svelte:157` does.
- Assert on the status-line text that the UI writes, via `waitForFunction` over `main`'s `textContent`.
- Gate anything that moves the stage behind `if (moves)`.

#### Existing step inventory (all 37 `step(` call sites)

Lines 34, 39, 47, 56, 68, 79, 92, 103, 114, 135, 144, 153, 165, 177, 203, 217, 235, 255, 273, 299, 320, 331, 342, 351, plus 12 more beyond line 351 covering scan regions, super-resolution JPEG and RAW planes, time-lapse, tracking, sample metadata, macros, settings and logs.

Named steps seen: connects and streams · link indicator · all tabs render · jog buttons · photo full resolution · RAW photo · RAW average · HDR RAW · focus stack returns to z · camera controls · calibration 1 flat/exposure/LSC · calibration 2 stage↔camera · RAW flat field · click-hold-drag pan · autofocus · scan 2×2 · fine focus stack · fine focus stack from RAW · live focus stack · video recording · settings persist · device logs · scale bar toggle · distance measurement.

#### Running it

```
# fake device serving the built webapp
cd webapp && npm run build
# start the fake with --webapp-dir webapp/dist --port 8099, then:
cd webapp && npm run test:e2e
# against a real Pi:
npm run test:e2e -- http://microscope.local
E2E_MOVES=0 npm run test:e2e        # skip stage moves
E2E_SHOTS=/tmp/shots npm run test:e2e
```

**Run it alone.** Two suites against one fake drive the same stage and fail erratically. CLAUDE.md: run it after any UI change, because unit tests do not catch Svelte effect loops or leaked MJPEG connections.

---

## 10. Existing WebGL/WebGPU and colour/tone code

### 10a. GPU usage — essentially none

**There is no WebGL or WebGPU rendering anywhere in the codebase.** The only references:

- `src/lib/workers/aiWorker.ts:19` — `let device: 'webgpu' | 'wasm' = (self as any).navigator?.gpu ? 'webgpu' : 'wasm'` (Transformers.js backend selection).
- `src/lib/workers/aiWorker.ts:25` — falls back to `'wasm'` and clears the model caches on failure.
- `src/routes/Settings.svelte:174` — user-facing note: "WebGPU is used when available."

Everything else is CPU typed arrays, 2D canvas contexts, and `OffscreenCanvas` inside workers. **A WebGL LUT path would be the first of its kind**, and it must live outside `lib/algo` (which has to stay pure and node-testable). The natural home is a service or a component-local renderer, with the pure LUT maths and parsing still in `lib/algo`.

### 10b. Colour / gamma / tone code a LUT stage must compose with

#### `src/lib/algo/rawdev.ts` — the canonical pipeline (see §7 for full detail)
- `transferLut(opts)` line 93 — 4096-knot 1D tone curve, tuning gamma or sRGB.
- `encodeValue(lut, v)` line 113.
- `applyCcm(rgb, ccm)` line 182.
- `desaturateHighlights(rgb, gains, exposure)` line 165.
- `srgb(v)` line 86.
- Order: shading → WB → demosaic → highlights → CCM → transfer curve. **A creative LUT goes after the transfer curve; a technical one goes in linear float before it.**

#### `src/lib/algo/hdr.ts` — tone mapping
```ts
export interface HdrFrame                                            // 12
export interface MergeOptions                                        // 19
export function hatWeight(z: number, satLevel: number): number       // 27
export function mergeHdr(frames: HdrFrame[], width, height, o: MergeOptions = {}): Float32Array   // 35
export function exposureRatiosFromMeans(frames: Float32Array[], reference = 0, o = {}): number[]  // 68
export interface ReinhardOptions                                     // 88
export function toneMapReinhard(radiance: Float32Array, width, height, o: ReinhardOptions = {}): Float32Array  // 95
export function toneMapMertens(radiance: Float32Array, width, height, stops = [-2,0,2], o: MertensOptions = {}): Float32Array  // 123
export function dynamicRangeStops(radiance: Float32Array): number    // 142
```
These already produce display-referred output. **A LUT applied to an HDR result must come after tone mapping.** Consumed by `services/photo/rawPhoto.ts:11`.

#### `src/lib/services/whiteBalance.svelte.ts` — white balance
```ts
export const wb = $state({ picking: false, status: '' })             // 11
export function gainsToTempTint(r: number, b: number): { temp: number; tint: number }   // 13
export function tempTintToGains(temp: number, tint: number): [number, number]           // 16
async function sampleLinear(frac, radiusFrac = 0.015): Promise<[number, number, number]>  // 24
export async function pickNeutral(frac: { x: number; y: number }): Promise<void>        // 40
export async function neutralWholeField(): Promise<void>                                // 60
```
White balance is a **device-side camera control** (`ColourGains`), applied by the ISP before the browser sees anything on the stream path, and applied in `prepareMosaic` on the RAW path. It is strictly upstream of any browser LUT.

#### `src/lib/algo/histogram.ts` — levels and auto-exposure
```ts
export interface Histogram                                           // 5
export function computeHistogram(data: Uint8ClampedArray | Uint8Array, stride = 1): Histogram  // 18
export interface ExposureState { exposureUs: number; gain: number }  // 35
export interface ExposureLimits { exposureUs: [number, number]; gain: [number, number] }  // 36
export function suggestExposureStep(...)                             // 42
```
Rendered by `src/components/Histogram.svelte` inside the Camera panel. **Directly reusable for CLAHE, auto-levels, and a before/after histogram in the Enhance panel.**

#### `src/lib/algo/deconvolve.ts` — sharpening, already written and tested
```ts
export interface PsfOptions                                          // 19
export function makePsf(N: number, opts: PsfOptions = {}): Float64Array  // 35
export function wiener(img: { data: Float32Array; width; height }, psf: Float64Array, psfSize: number, noise = 0.01): Float32Array  // 96
export function richardsonLucy(img: { data: Float32Array; width; height }, psf: Float64Array, psfSize: number, iterations = 10): Float32Array  // 148
```
`deconvolve.test.ts` exists. **The sharpen/deconvolve half of the enhance pipeline is already implemented**; it needs wiring, not writing.

#### `src/lib/algo/flatField.ts` — background/shading subtraction, already written
```ts
export interface FlatField                                           // 14
export interface FlatFieldJson                                       // 29
export function flatFieldToJson(f, when = new Date().toISOString())  // 31
export function flatFieldFromJson(j): FlatField                      // 35
export interface FlatFieldOptions                                    // 39
export function gridMean(plane, w, h, cols, rows): Float32Array      // 48
export function smoothGrid(g, cols, rows, passes = 1): Float32Array  // 63
export function flatFieldFromRaw(raw: RawImage, opts = {}): FlatField // 99
export function flatFieldSampler(map, cols, rows, w, h): (x, y) => number  // 111
export function flatFieldLuminance(f, cols, rows): Float32Array      // 122
export function applyFlatFieldRgb(data: Float32Array, w, h, f: FlatField): void  // 130
```
Already wired into `rawdev.prepareMosaic` at lines 138–141 and into DNG GainMap opcodes.

#### `src/lib/algo/stack.ts` — block maps and the `Rgba` type
```ts
export interface Rgba { data: Uint8ClampedArray; width: number; height: number }  // 10
export interface CellMaps { cellsX; cellsY; cell; sharpness: Float32Array; luminance: Float32Array }  // 12
export function cellMaps(img: Rgba, cell = 8): CellMaps              // 15
export function smooth(map, cellsX, cellsY, passes = 2): Float32Array // 37
export function blend(images: Rgba[], weights: Float32Array[], cellsX, cell): Rgba  // 67
export function grayDown(rgba, w, h, maxW = 410): { data: Float32Array; width; height }  // 96
export interface StackResult { image: Rgba; contributions: number[] }  // 107
export function focusStack(images: Rgba[], cell = 8): StackResult    // 110
export function exposureFuse(images: Rgba[], cell = 8): Rgba         // 131
export function totalSharpness(img: Rgba, cell = 8): number          // 147
```
`grayDown` and `cellMaps` are useful building blocks for a tiled CLAHE.

#### Other relevant algo modules
- `src/lib/algo/exposureFuse.ts` — Mertens-style fusion.
- `src/lib/algo/pyramidFuse.ts` — Laplacian pyramids, also `depthIndex()`.
- `src/lib/algo/align.ts`, `register.ts`, `fftTrack.ts`, `fft.ts` — registration primitives; CLAUDE.md says `register.ts` is the one registration primitive to use, do not reinvent downscale-then-correlate.
- `src/lib/algo/stabilize.ts` — used by the recorder.
- `src/lib/algo/png16.ts` — `encodePng16(data, w, h)`.
- `src/lib/algo/dng.ts` — `encodeDng`, `colorMatrixFromCcm`, `invert3`, `mulVec3`, `D65_XYZ`.
- `src/lib/algo/measure.ts` — `scaleForWidth`, `niceScaleBarLength`, `Pt`.

---

## 11. IndexedDB schema versioning — safe-change checklist

Covered in §3a; restated here as an actionable checklist because it is the question most likely to be got wrong.

**Current state** (`src/lib/store/gallery.ts:108–122`): database `openflexito`, `VERSION = 2`, three object stores.

| Store | keyPath | Indexes | Key format |
|---|---|---|---|
| `items` | `id` | `when` on `when` | the item's `id` |
| `blobs` | *(none, keyless)* | none | `` `${id}/${name}` `` via `blobKey` at line 136 |
| `embeddings` | `key` | `item` on `item` | `Embedding.key` |

### To add a new blob kind (e.g. `lut-preview`, `enhanced`)

1. **No `VERSION` bump.** The `blobs` store is keyless; any string name works.
2. Write it: `await putBlob(id, 'enhanced', blob)`.
3. Add the name to `item.blobs` so `deleteItem` (line 174) and `itemFiles` (line 247) see it.
4. If the MIME type is not already covered, extend the extension map at **line 250** so exports get the right suffix. Current map: `image/png`→png, `image/x-adobe-dng`→dng, `video/webm*`→webm, `video/*`→mp4, `application/octet-stream`→bin, `application/json`→json, else jpg.
5. `blobFileName(item, name, ext)` from `algo/naming.ts:51` gives the export filename automatically.
6. Old items simply do not list the key; every read site already does `getBlob(...)` and checks for `undefined`.

### To add a new item field (e.g. `lut?`, `enhance?`)

1. **No `VERSION` bump.** Items are whole-object `put`s via `putItem` (line 150).
2. Declare it **optional** on `GalleryItem` (lines 23–106) with a docstring following the house style: state that it is additive and say what old items fall back to. The model comment is at lines 41–46 for `stack.depth.umPerStep`.
3. If it should be settable through `saveSnapshot`, widen the `Pick<>` at **line 189** from `'stack' | 'raw' | 'superres' | 'capture'` to include the new key.
4. If through `saveVideo` or `saveTimelapse`, add it to those `meta` params (207–208, 224) and to the item literal (211–216, 231–235).
5. Every read site must treat it as optional. `Viewer.svelte:168` gates the details toggle on `item.capture || item.superres || item.stack || item.video` and would need the new key added.
6. Never hand a `$state` proxy in. `plain()` at line 148 stringifies, so functions, `undefined` values and proxies are silently dropped or throw.

### To add a whole new object store

1. Bump `VERSION` at **line 108** to 3.
2. Add one more guarded line inside `onupgradeneeded`, following the existing idiom exactly:
   ```ts
   if (!db.objectStoreNames.contains('luts')) db.createObjectStore('luts', { keyPath: 'id' })
   ```
3. **Never remove or reorder the existing guards** — a browser upgrading from v1 runs the same handler.
4. Add `tx()`-based accessors alongside `putEmbedding` / `allEmbeddings` (165–166).

**Recommendation**: a LUT library of user-uploaded `.cube` files is the one thing here that plausibly warrants a new store. If the LUTs are small and few, storing them as JSON in `localStorage` alongside Settings (the `lightPresets` precedent at `settings.svelte.ts:20`) avoids the version bump entirely. Large binary LUTs belong in a new `luts` store or as blobs under a synthetic item id.

---

## Layering rules implementers must honour

From `/Users/sdawka/Code/openflexito/CLAUDE.md`. These are enforced conventions, not suggestions.

1. **`lib/algo` imports nothing outside `lib/algo`.** Its types live in `algo/types.ts`, re-exported by `api/types.ts`. A new `algo/lut.ts` and `algo/enhance.ts` must be pure, DOM-free, fetch-free, store-free, and vitest-tested.
2. **Services orchestrate algo + api.** Components and routes never call `fetch` directly; they go through a service or `lib/api`.
3. **Workers** use `defineWorker`/`post` from `workers/workerUtil.ts`; errors reach the caller as `{ error }`.
4. **Naming**: a file is `*.svelte.ts` **iff** it holds runes (`$state`, `$derived`). A stateless LUT registry or parser stays plain `.ts`.
5. **Never write a `$state` you also read inside the same `$effect`** — infinite loop that kills the whole app.
6. **Clear `img.src` of MJPEG images on unmount** — a detached `<img>` keeps streaming and leaks a connection per visit.
7. **Never put `$state` proxies into IndexedDB** — structured clone fails.
8. **Mobile**: breakpoint `@media (max-width: 720px)` everywhere, coarse-pointer sizing in `@media (pointer: coarse)`, shared `.cols`/`.scroll-x` helpers and `--tabbar-h` in `src/app.css`; component-local responsive rules go in each component's own `<style>`.
9. **Camera multi-shot runs** must use `services/cameraLock.ts` (`lockCamera` / `CameraLock.release`) rather than inventing their own AE/AWB lock.
10. **Activity holds**: anything that runs for minutes without making RPCs must take `activity.hold(reason)` and release it in a `finally`. A leaked hold pins the device awake.
11. **Run the browser e2e suite after any UI change**, alone, one suite per fake device.

## Recommended new-file layout

```
src/lib/algo/lut.ts                        pure: .cube/.3dl parsing, 1D+3D LUT apply, identity, interpolation
src/lib/algo/enhance.ts                    pure: CLAHE, unsharp/deconvolve wrapper, denoise, background subtraction, pipeline composition
src/lib/algo/__tests__/lut.test.ts
src/lib/algo/__tests__/enhance.test.ts
src/lib/workers/enhanceWorker.ts           defineWorker, { progress } + { result }, transferables
src/lib/services/lut.svelte.ts             LUT selection state + library (runes, so .svelte.ts)
src/lib/services/enhanceService.ts         orchestration, worker wrapper following runRawWorker
src/components/LookPanel.svelte            Live route, after the Focus panel
src/components/EnhancePanel.svelte         Live route + docked inside Viewer
```

Settings additions go in `src/lib/store/settings.svelte.ts` (interface + defaults) plus a panel in `src/routes/Settings.svelte`. Gallery provenance goes in `GalleryItem` plus the `Pick<>` at `gallery.ts:189`. Live-view rendering goes in `StreamView.svelte` beside `compCanvas`. Recording goes at `recorder.svelte.ts:201` and `:112`. Gallery viewing goes through `Viewer.svelte`'s `viewBlob` at line 69. Time-lapse goes after `TimelapseViewer.svelte:99`.
