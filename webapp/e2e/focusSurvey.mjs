// Hardware focus diagnostics against a running device (fake or the real Pi), Node only (uses `sharp`):
//   node e2e/focusSurvey.mjs http://192.168.0.16 survey 2500      3×3 texture survey ±2500 steps around here
//   node e2e/focusSurvey.mjs http://192.168.0.16 zsweep 900 60    z sweep ±900 in 60-step stops, back to start
// Each z stop logs the frame metadata's JPEG `size` and libcamera `focus_fom` plus Laplacian variance of the
// 820-px stream frame and of a full-res still downscaled to 1640 px. Measured on the Pi 3B+/IMX219 on
// 2026-10-05 (peak/floor): size none (hardware MJPEG rate control), fom 1.29 on a ~4000 baseline,
// lap820 12, lapFull(1640) 1.14 — the stream-frame Laplacian is the fine focus metric on this hardware.
// Moves the stage; wakes the device and restores idle standby (10 min) at the end.
import sharp from 'sharp'
const base = process.argv[2] || 'http://192.168.0.16'
const TIMEOUT = 15000
class Rpc {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map() }
  async open() {
    this.ws = new WebSocket(this.url)
    this.ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data) } catch { return }; const p = m.id != null && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) } }
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('ws failed')) })
  }
  call(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(method + ' timeout')), 60000); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v) }, rej }); this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })) }) }
}
async function snap(full = false) {
  const r = await fetch(`${base}/snapshot.jpg${full ? '?full=1' : ''}`, { signal: AbortSignal.timeout(TIMEOUT * 2) })
  const buf = Buffer.from(await r.arrayBuffer())
  const meta = JSON.parse(r.headers.get('x-frame') || '{}')
  return { buf, meta }
}
async function lapVar(buf, width) {
  const img = sharp(buf).greyscale()
  const { data, info } = await (width ? img.resize({ width }) : img).raw().toBuffer({ resolveWithObject: true })
  const w = info.width, h = info.height
  let s = 0, s2 = 0, n = 0, mean = 0
  for (let i = 0; i < data.length; i++) mean += data[i]
  mean /= data.length
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x
    const l = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w]
    s += l; s2 += l * l; n++
  }
  const m = s / n
  return { lap: s2 / n - m * m, mean }
}
const rpc = new Rpc(base.replace(/^http/, 'ws') + '/ws'); await rpc.open()
await rpc.call('power.set', { on: true }); await rpc.call('power.set_idle', { minutes: 0 })
const st = await rpc.call('stage.status'); const p0 = st.position ?? st
console.log('start', JSON.stringify(p0))
const mode = process.argv[3] || 'survey'
const settle = (ms) => new Promise((r) => setTimeout(r, ms))
if (mode === 'survey') {
  const step = +(process.argv[4] || 2500)
  const results = []
  for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1]) {
    await rpc.call('stage.move_to', { x: p0.x + dx * step, y: p0.y + dy * step, compensate: false })
    await settle(700); await snap()
    const { buf, meta } = await snap()
    const { lap, mean } = await lapVar(buf)
    results.push({ dx, dy, lap: +lap.toFixed(1), mean: +mean.toFixed(0), size: meta.size, fom: meta.focus_fom })
    console.log(JSON.stringify(results.at(-1)))
  }
  await rpc.call('stage.move_to', { x: p0.x, y: p0.y, compensate: false })
} else if (mode === 'zsweep') {
  const range = +(process.argv[4] || 300), inc = +(process.argv[5] || 20)
  let moved = 0
  const move = async (dz) => { await rpc.call('stage.move_rel', { z: dz, compensate: false }); moved += dz }
  await move(-range - 40); await move(40)   // approach from below for backlash
  console.log('   z     size     fom   lap820   lapFull')
  for (let z = -range; z <= range; z += inc) {
    await settle(400); await snap()
    const { buf, meta } = await snap()
    const a = await lapVar(buf)
    const full = await snap(true)
    const b = await lapVar(full.buf, 1640)
    console.log(String(z).padStart(5), String(meta.size).padStart(8), String(meta.focus_fom).padStart(7), a.lap.toFixed(1).padStart(8), b.lap.toFixed(1).padStart(9))
    if (z < range) await move(inc)
  }
  await move(-moved)
}
await rpc.call('power.set_idle', { minutes: 10 })
process.exit(0)
