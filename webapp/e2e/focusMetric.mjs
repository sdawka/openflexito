#!/usr/bin/env node
// Focus-metric probe: does the per-frame JPEG size / libcamera FocusFoM actually peak at focus?
//
// Usage:  node webapp/e2e/focusMetric.mjs [http://host[:port]] [--range 300] [--step 20] [--frames 5]
//   default device http://127.0.0.1:8099 (the fake); on the Pi: http://192.168.0.16 (use the IPv4 address).
// Steps z over -range..+range with stage.move_rel {compensate:false}, reads --frames frames of metadata
// (`X-Frame` of /snapshot.jpg, distinct frames only, skipping the first ones after a move) at each z,
// prints a table of the median `size` and `focus_fom`, and per metric the peak/floor ratio, the peak z
// and the number of turning points (a clean focus curve has one). z is restored at the end, the device is
// woken (power.set {on:true}) and auto-standby is disabled during the run, then set back to 10 minutes.
// Exit status 1 when focus_fom is null/missing at any z, 2 on a connection or RPC failure.
// Plain Node (>= 22: global fetch and WebSocket), no dependencies.

const args = process.argv.slice(2)
const opt = (name, dflt) => { const i = args.indexOf(name); return i < 0 ? dflt : Number(args.splice(i, 2)[1]) }
const RANGE = opt('--range', 300), STEP = opt('--step', 20), FRAMES = opt('--frames', 5)
const base = (args[0] ?? 'http://127.0.0.1:8099').replace(/\/$/, '')
const TIMEOUT = 15000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class Rpc {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map() }
  async open() {
    this.ws = new WebSocket(this.url)
    this.ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data) } catch { return }
      const p = m.id != null && this.pending.get(m.id)
      if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(`${m.error.message ?? JSON.stringify(m.error)}`)) : p.res(m.result) }
    }
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`websocket ${this.url} did not open in ${TIMEOUT} ms`)), TIMEOUT)
      this.ws.onopen = () => { clearTimeout(t); res() }
      this.ws.onerror = () => { clearTimeout(t); rej(new Error(`websocket ${this.url} failed`)) }
    })
  }
  call(method, params = {}, timeout = TIMEOUT * 2) {
    const id = ++this.id
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`${method} timed out`)) }, timeout)
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v) }, rej: (e) => { clearTimeout(t); rej(e) } })
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function frame() {
  const r = await fetch(`${base}/snapshot.jpg`, { signal: AbortSignal.timeout(TIMEOUT) })
  if (!r.ok) throw new Error(`/snapshot.jpg ${r.status}`)
  await r.arrayBuffer()
  const h = r.headers.get('x-frame')
  if (!h) throw new Error('/snapshot.jpg has no X-Frame header')
  return JSON.parse(h)
}

async function grab(n) {
  const first = await frame()
  const skipTo = first.seq + 2 // libcamera applies a move to the frames 1-2 requests later
  const out = []
  let last = first.seq, deadline = Date.now() + 60000
  while (out.length < n && Date.now() < deadline) {
    const f = await frame()
    if (f.seq === last) { await sleep(25); continue }
    last = f.seq
    if (f.seq >= skipTo) out.push(f)
  }
  if (out.length < n) throw new Error(`only ${out.length}/${n} fresh frames`)
  return out
}

const median = (a) => { const v = a.filter((x) => x != null && Number.isFinite(x)).sort((p, q) => p - q); return v.length ? v[v.length >> 1] : null }

function stats(zs, ys) {
  const ok = ys.every((y) => y != null)
  if (!ok) return null
  let hi = 0, lo = 0
  ys.forEach((y, i) => { if (y > ys[hi]) hi = i; if (y < ys[lo]) lo = i })
  let turns = 0, dir = 0
  for (let i = 1; i < ys.length; i++) {
    const d = Math.sign(ys[i] - ys[i - 1])
    if (d !== 0) { if (dir !== 0 && d !== dir) turns++; dir = d }
  }
  return { peakZ: zs[hi], ratio: ys[lo] > 0 ? ys[hi] / ys[lo] : Infinity, contrast: (ys[hi] - ys[lo]) / ys[hi], turns }
}

const rpc = new Rpc(base.replace(/^http/, 'ws') + '/ws')
let z0 = null, moved = 0, code = 0
try {
  await rpc.open()
  await rpc.call('power.set', { on: true })
  await rpc.call('power.set_idle', { minutes: 0 })
  await sleep(500)
  z0 = (await rpc.call('stage.position')).z
  const rows = []
  const move = async (dz) => { await rpc.call('stage.move_rel', { z: dz, compensate: false }); moved += dz }
  await move(-RANGE)
  for (let z = -RANGE; z <= RANGE; z += STEP) {
    if (z > -RANGE) await move(STEP)
    await sleep(150)
    const fs = await grab(FRAMES)
    rows.push({ z, size: median(fs.map((f) => f.size)), fom: median(fs.map((f) => f.focus_fom)),
                nullFom: fs.some((f) => f.focus_fom == null), matched: fs.every((f) => f.matched !== false) })
  }
  console.log(`device ${base}  start z ${z0}  ${rows.length} stops, ${FRAMES} frames each (offsets from start z)`)
  console.log('     z      size       fom')
  for (const r of rows) console.log(`${String(r.z).padStart(6)} ${String(r.size ?? 'null').padStart(9)} ${String(r.fom ?? 'null').padStart(9)}${r.matched ? '' : '  (unmatched meta)'}`)
  const zs = rows.map((r) => r.z)
  for (const [name, key] of [['size', 'size'], ['focus_fom', 'fom']]) {
    const s = stats(zs, rows.map((r) => r[key]))
    console.log(s ? `${name.padEnd(10)} peak at z ${String(s.peakZ).padStart(5)}  peak/floor ${s.ratio.toFixed(3)}  contrast ${(100 * s.contrast).toFixed(1)}%  turning points ${s.turns}`
                  : `${name.padEnd(10)} MISSING at some z`)
  }
  if (rows.some((r) => r.nullFom || r.fom == null)) { console.error('FAIL: focus_fom is null in the frame metadata'); code = 1 }
} catch (e) {
  console.error('ERROR:', e.message)
  code = 2
} finally {
  try {
    if (moved) await rpc.call('stage.move_rel', { z: -moved, compensate: false })
    await rpc.call('power.set_idle', { minutes: 10 })
  } catch (e) { console.error('cleanup failed:', e.message); code ||= 2 }
  rpc.close()
}
process.exit(code)
