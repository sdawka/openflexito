/** Sweep focus stack: one continuous z sweep recorded from the sensor (`/record.h264`, 1640×1232
 *  H.264 at up to 30 fps), each frame's z interpolated from its SensorTimestamp between the move's
 *  t0/t1, the in-focus band picked from a per-frame sharpness curve, and up to `slices` frames
 *  spread over that band aligned and fused by the same pyramid worker as the fine stack
 *  (`focusStack.ts#pyramidWorker`/`saveFusedStack`). Maths in `algo/sweepStack.ts`.
 *
 *  The stage is slowed for the sweep (`stage.set_step_time`, restored afterwards) so consecutive
 *  frames are ≈`stepsPerFrame` z steps apart: at the board's full speed a 30 fps camera sees one
 *  frame every ~26 steps, coarser than the depth of field at high magnification. The sweep goes
 *  upwards after a backlash-compensated move to its bottom, and the stage ends on the sharpest
 *  frame's z with z backlash compensation, like the fine stack ends on its focus plane. */

import { RecordStream, avcCodecString, type RecordInfo, type RecordPacket } from '../../api/recordStream'
import { chooseSweepSlices, sweepStepTimeUs, zAtTime, type SweepSample } from '../../algo/sweepStack'
import { laplacianVariance, toGray } from '../../algo/sharpness'
import { device } from '../../store/device.svelte'
import type { GalleryItem } from '../../store/gallery'
import type { MoveResult } from '../../algo/types'
import { withCameraLock } from '../cameraLock'
import { moveZVerified, pyramidWorker, saveFusedStack, type FocusStackOptions } from './focusStack'
import { settle, type Say, type PhotoMeta } from './common'

export interface SweepStackOptions extends FocusStackOptions {
  /** z steps between consecutive frames (the sweep speed); default 8 */
  stepsPerFrame?: number
}

const SHARPNESS_WIDTH = 410

/** Whether the device can record from the sensor and this browser can decode it. */
export async function sweepStackAvailable(): Promise<boolean> {
  if (!device.status?.camera?.record?.available || typeof VideoDecoder === 'undefined') return false
  const size = device.status.camera.record.size ?? [1640, 1232]
  try { return !!(await VideoDecoder.isConfigSupported({ codec: 'avc1.640029', codedWidth: size[0], codedHeight: size[1] })).supported } catch { return false }
}

/** Decode `packets` (from the first keyframe) and hand every frame to `onFrame` with its device
 *  timestamp in ns; frames are closed afterwards. */
async function decodeAll(packets: readonly RecordPacket[], info: RecordInfo, onFrame: (vf: VideoFrame, tNs: number) => void): Promise<void> {
  const first = packets.findIndex((p) => p.key)
  if (first < 0) throw new Error('sweep stack: the recording has no keyframe')
  let failure: Error | null = null
  const decoder = new VideoDecoder({
    output: (vf) => {
      try { if (!failure) onFrame(vf, vf.timestamp * 1000) } catch (e) { failure = e as Error } finally { vf.close() }
    },
    error: (e) => { failure = e },
  })
  decoder.configure({ codec: avcCodecString(packets[first].data) ?? 'avc1.640029', codedWidth: info.width, codedHeight: info.height })
  for (let i = first; i < packets.length; i++) {
    const p = packets[i]
    if (p.ts == null) continue
    // µs timestamps round-trip exactly through the decoder; the sensor clock is in ns
    decoder.decode(new EncodedVideoChunk({ type: p.key ? 'key' : 'delta', timestamp: Math.round(p.ts / 1000), data: p.data }))
    if (decoder.decodeQueueSize > 16) await new Promise((r) => setTimeout(r, 5))
  }
  await decoder.flush()
  decoder.close()
  if (failure) throw failure
}

/** Frame rate from the device timestamps of the packets so far, or null if there are too few. */
function measuredFps(packets: readonly RecordPacket[]): number | null {
  const ts = packets.map((p) => p.ts).filter((t): t is number => t != null)
  if (ts.length < 4) return null
  const span = (ts[ts.length - 1] - ts[0]) / 1e9
  return span > 0 ? (ts.length - 1) / span : null
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const until = performance.now() + timeoutMs
  while (!cond()) {
    if (performance.now() > until) throw new Error(`sweep stack: ${what}`)
    await settle(30)
  }
}

export async function takeSweepStack(o: SweepStackOptions, say: Say, meta: PhotoMeta): Promise<GalleryItem> {
  if (!(await sweepStackAvailable())) throw new Error('sweep stack needs sensor recording on the device and an H.264 decoder in this browser')
  const maxSlices = Math.max(3, Math.round(o.slices ?? 9)), range = Math.max(40, Math.round(o.range ?? 1000))
  const stepsPerFrame = Math.max(1, o.stepsPerFrame ?? 8)
  const minUs = device.status?.stage?.step_time_us ?? 1000
  const packets: RecordPacket[] = []
  let info: RecordInfo | null = null, move: MoveResult | null = null, z0 = 0, stepUs = minUs, fps = 0
  let streamError: Error | null = null
  await withCameraLock(async () => {
    const stream = new RecordStream()
    let done: Promise<void> | null = null
    try {
      say(`sweep stack: moving to the bottom of the sweep (−${Math.round(range / 2)})`)
      await moveZVerified(-Math.round(range / 2), 'z', say, 'sweep stack')
      z0 = device.position.z
      say('sweep stack: starting the sensor recording')
      const started = await stream.start(device.url('/record.h264?keyframe=1'), (p) => packets.push(p), (e) => { streamError = e })
      info = started.info; done = started.done
      // the camera has switched modes once frames flow; a few more let exposure settle on the new mode
      await waitFor(() => packets.some((p) => p.key) && packets.length >= 8, 8000, 'no frames from the sensor recording')
      // size the sweep speed from the frame rate the camera actually delivers, not the one asked for
      fps = measuredFps(packets) ?? info.fps
      stepUs = sweepStepTimeUs(fps, stepsPerFrame, minUs)
      say(`sweep stack: sweeping ${range} steps at ${stepUs} µs/step (${fps.toFixed(1)} fps)`)
      await device.client.call('stage.set_step_time', { us: stepUs })
      try {
        move = await device.moveRel({ z: range }, false)
      } finally {
        await device.client.call('stage.set_step_time', { us: minUs }).catch((e) => say(`sweep stack: could not restore the stage speed: ${(e as Error).message}`))
      }
      // frames exposed at the end of the move are still on their way
      const last = move.t1
      await waitFor(() => packets.some((p) => p.ts != null && p.ts > last), 3000, 'the recording stopped before the end of the sweep').catch(() => {})
    } finally {
      stream.stop()
      await done
    }
  }, { onError: (m) => say(`sweep stack: ${m}`) })
  if (streamError) throw streamError
  if (!info || !move) throw new Error('sweep stack: the sweep did not run')
  const rec: RecordInfo = info, mv = { t0: (move as MoveResult).t0, t1: (move as MoveResult).t1, z0, z1: (move as MoveResult).position.z }
  if ((move as MoveResult).cancelled) throw new Error('sweep stack: the sweep was cancelled')

  // pass 1: sharpness of every frame exposed during the sweep, at a small size
  say(`sweep stack: measuring sharpness in ${packets.length} frames…`)
  const small = new OffscreenCanvas(SHARPNESS_WIDTH, Math.round((SHARPNESS_WIDTH * rec.height) / rec.width))
  const sctx = small.getContext('2d', { willReadFrequently: true })!
  const samples: (SweepSample & { t: number })[] = []
  await decodeAll(packets, rec, (vf, t) => {
    const z = zAtTime(t, mv)
    if (z == null) return
    sctx.drawImage(vf, 0, 0, small.width, small.height)
    samples.push({ z, s: laplacianVariance(toGray(sctx.getImageData(0, 0, small.width, small.height))), t })
  })
  if (samples.length < 3) throw new Error(`sweep stack: only ${samples.length} frames fell inside the sweep (timestamps off?)`)
  const sel = chooseSweepSlices(samples, maxSlices)
  const chosen = sel.indices.map((i) => samples[i])
  const peakZ = Math.round(samples[sel.peak].z)
  const zs = chosen.map((c) => Math.round(c.z))
  const step = zs.length > 1 ? Math.round((zs[zs.length - 1] - zs[0]) / (zs.length - 1)) : 0
  say(`sweep stack: ${samples.length} frames over z ${Math.round(mv.z0)}…${Math.round(mv.z1)}, sharpest at z=${peakZ}; fusing ${chosen.length} from ${zs[0]}…${zs[zs.length - 1]}`)
  // end on the sharpest plane while the browser fuses
  const back = device.moveTo({ z: peakZ }, 'z').catch((e) => say(`sweep stack: could not move to z=${peakZ}: ${(e as Error).message}`))

  // pass 2: the chosen frames at full size into the pyramid
  const wanted = new Map(chosen.map((c, i) => [Math.round(c.t / 1000), i]))
  const full = new OffscreenCanvas(rec.width, rec.height)
  const fctx = full.getContext('2d', { willReadFrequently: true })!
  const fuse = pyramidWorker()
  fuse.onProgress = (m) => say(`sweep stack: ${m}`)
  fuse.post({ type: 'init', width: rec.width, height: rec.height, depth: 8, count: chosen.length, reference: 'middle', method: o.method })
  const slices: Promise<Blob>[] = []
  let next = 0
  await decodeAll(packets, rec, (vf, t) => {
    const i = wanted.get(Math.round(t / 1000))
    if (i === undefined || i !== next) return
    next++
    fctx.drawImage(vf, 0, 0)
    const img = fctx.getImageData(0, 0, rec.width, rec.height)
    slices.push(createImageBitmap(img).then((b) => {
      const c = new OffscreenCanvas(b.width, b.height)
      c.getContext('2d')!.drawImage(b, 0, 0); b.close()
      return c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
    }))
    fuse.post({ type: 'add', index: i, data: img.data }, [img.data.buffer])
  })
  if (next !== chosen.length) { fuse.worker.terminate(); throw new Error(`sweep stack: decoded ${next} of ${chosen.length} chosen frames`) }
  say('sweep stack: fusing…')
  fuse.post({ type: 'finish' })
  const r = await fuse.finished
  fuse.worker.terminate()
  await back
  const blobs = await Promise.all(slices)
  return saveFusedStack(r, {
    label: 'sweep stack', say, meta, name: `Sweep focus stack ${chosen.length} of ${samples.length}`,
    frames: blobs.map((blob, i) => ({ blob, z: zs[i] })), centreZ: peakZ, step, span: zs[zs.length - 1] - zs[0], source: 'sweep',
    capture: null,
    extraStack: { sweep: { frames: samples.length, fps: Math.round(fps * 10) / 10, stepTimeUs: stepUs, stepsPerFrame, range, width: rec.width, height: rec.height, sensorSize: rec.sensor_size } },
  })
}
