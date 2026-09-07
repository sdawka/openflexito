/** White balance the way raw editors do it (Lightroom, darktable, Capture One): click a spot that
 *  should be neutral and the gains are solved so it comes out grey, or nudge along two perceptual
 *  axes, temperature (blue ↔ amber) and tint (green ↔ magenta), instead of raw red/blue gain sliders.
 *
 *  gains (r, b) <-> (temperature, tint):  r = 2^(tint - temp/2),  b = 2^(tint + temp/2)
 *  so temp > 0 boosts blue (cooler), tint > 0 raises both r and b against green (magenta). */

import { device } from '../store/device.svelte'

export const wb = $state({ picking: false, status: '' })

export function gainsToTempTint(r: number, b: number): { temp: number; tint: number } {
  return { temp: Math.log2(b / r), tint: (Math.log2(r) + Math.log2(b)) / 2 }
}
export function tempTintToGains(temp: number, tint: number): [number, number] {
  const clamp = (v: number) => Math.min(8, Math.max(0.25, v))
  return [clamp(2 ** (tint - temp / 2)), clamp(2 ** (tint + temp / 2))]
}

const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }

/** Mean linear RGB of the live frame around a point (fractions of the image), radius as a fraction of the width. */
async function sampleLinear(frac: { x: number; y: number }, radiusFrac = 0.015): Promise<[number, number, number]> {
  const res = await fetch(device.url('/snapshot.jpg') + '?t=' + Date.now(), { cache: 'no-store' })
  const bmp = await createImageBitmap(await res.blob())
  const r = Math.max(2, Math.round(bmp.width * radiusFrac))
  const cx = Math.round(frac.x * bmp.width), cy = Math.round(frac.y * bmp.height)
  const x0 = Math.max(0, cx - r), y0 = Math.max(0, cy - r), w = Math.min(bmp.width - x0, 2 * r), h = Math.min(bmp.height - y0, 2 * r)
  const c = new OffscreenCanvas(w, h), ctx = c.getContext('2d')!
  ctx.drawImage(bmp, x0, y0, w, h, 0, 0, w, h); bmp.close()
  const d = ctx.getImageData(0, 0, w, h).data
  let R = 0, G = 0, B = 0
  for (let i = 0; i < d.length; i += 4) { R += lin(d[i]); G += lin(d[i + 1]); B += lin(d[i + 2]) }
  const n = d.length / 4
  return [R / n, G / n, B / n]
}

/** Make the clicked spot neutral: scale the red and blue gains by G/R and G/B of the spot, twice
 *  (the colour matrix couples the channels, so one pass lands close and the second refines). */
export async function pickNeutral(frac: { x: number; y: number }): Promise<void> {
  wb.picking = false
  wb.status = 'white balance: sampling…'
  try {
    for (let pass = 0; pass < 2; pass++) {
      const [R, G, B] = await sampleLinear(frac)
      if (R < 0.01 || G < 0.01 || B < 0.01) throw new Error('the spot is too dark to balance on; pick a brighter neutral area')
      if (R > 0.97 && G > 0.97 && B > 0.97) throw new Error('the spot is clipped; pick a mid-grey area or lower the exposure')
      const c = device.controls, f = device.frame
      const cur: [number, number] = f?.colour_gains?.length === 2 ? [f.colour_gains[0], f.colour_gains[1]] : c ? [c.ColourGains[0], c.ColourGains[1]] : [1, 1]
      const next: [number, number] = [Math.min(8, Math.max(0.25, cur[0] * (G / R))), Math.min(8, Math.max(0.25, cur[1] * (G / B)))]
      await device.setControls({ AwbEnable: false, ColourGains: [+next[0].toFixed(3), +next[1].toFixed(3)] })
      wb.status = `white balance: red ${next[0].toFixed(2)} blue ${next[1].toFixed(2)}${pass ? '' : ' (refining…)'}`
      await new Promise((r) => setTimeout(r, 500))
    }
  } catch (e) { wb.status = (e as Error).message }
  setTimeout(() => (wb.status = ''), 4000)
}

/** Grey-world over the whole frame: right when the field of view is empty and evenly lit. */
export async function neutralWholeField(): Promise<void> {
  return pickNeutral({ x: 0.5, y: 0.5 }).then(async () => {
    // pickNeutral samples a small spot; for the whole field sample a large radius instead
    const [R, G, B] = await sampleLinear({ x: 0.5, y: 0.5 }, 0.45)
    const c = device.controls
    if (!c) return
    await device.setControls({ AwbEnable: false, ColourGains: [+Math.min(8, Math.max(0.25, c.ColourGains[0] * (G / R))).toFixed(3), +Math.min(8, Math.max(0.25, c.ColourGains[1] * (G / B))).toFixed(3)] })
  })
}
