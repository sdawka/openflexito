/** Develop a 10-bit Bayer capture into 16-bit RGB in the browser: black level, white balance,
 *  bilinear demosaic, optional sRGB gamma. Nothing is thrown away: the 10-bit values are scaled to
 *  the 16-bit range and the result is meant for a lossless 16-bit PNG. (Lens shading and the colour
 *  matrix are not applied: this is the sensor's data as measured.) */

import type { RawImage } from './raw'

export interface Rgb16 { data: Uint16Array; width: number; height: number }

export interface DevelopOptions {
  gains?: [number, number]   // red, blue white-balance gains (from the live camera metadata)
  gamma?: boolean            // apply the sRGB transfer curve (default true; false = linear)
  exposure?: number          // linear multiplier before gamma (default 1)
}

function srgb(v: number): number {  // v in 0..1
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

/** Colour of the mosaic cell at (x, y) for a 2×2 Bayer order string such as 'BGGR'. */
export function cellColour(bayer: string, x: number, y: number): 'R' | 'G' | 'B' {
  const o = bayer.toUpperCase().padEnd(4, 'G')
  return o[((y & 1) << 1) | (x & 1)] as 'R' | 'G' | 'B'
}

export function develop(raw: RawImage, opts: DevelopOptions = {}): Rgb16 {
  const { width: w, height: h, data, blackLevel: bl } = raw
  const white = (1 << raw.bitDepth) - 1 - bl
  const [gr, gb] = opts.gains ?? [1, 1]
  const gamma = opts.gamma !== false, exposure = opts.exposure ?? 1
  const out = new Uint16Array(w * h * 3)
  // black-subtracted, white-balanced mosaic as float (0..1-ish)
  const m = new Float32Array(w * h)
  const order = raw.bayer.toUpperCase().padEnd(4, 'G')
  const gain = [order[0], order[1], order[2], order[3]].map((c) => (c === 'R' ? gr : c === 'B' ? gb : 1))
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x
    m[i] = Math.max(0, data[i] - bl) / white * gain[((y & 1) << 1) | (x & 1)] * exposure
  }
  // lookup for the transfer curve on 12-bit quantised input (fine for a 10-bit source)
  const lut = new Float32Array(4097)
  for (let i = 0; i <= 4096; i++) lut[i] = gamma ? srgb(i / 4096) : i / 4096
  const enc = (v: number) => { const c = v <= 0 ? 0 : v >= 1 ? 4096 : Math.round(v * 4096); return Math.round(lut[c] * 65535) }
  const at = (x: number, y: number) => m[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = cellColour(raw.bayer, x, y)
    let r: number, g: number, b: number
    const here = at(x, y)
    const cross = (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) / 4
    const diag = (at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) / 4
    const horiz = (at(x - 1, y) + at(x + 1, y)) / 2, vert = (at(x, y - 1) + at(x, y + 1)) / 2
    if (c === 'G') {
      g = here
      // neighbours left/right share a row: their colour is the other non-green of this row
      const rowColour = cellColour(raw.bayer, x + 1, y)
      if (rowColour === 'R') { r = horiz; b = vert } else { b = horiz; r = vert }
    } else if (c === 'R') { r = here; g = cross; b = diag }
    else { b = here; g = cross; r = diag }
    const o = (y * w + x) * 3
    out[o] = enc(r); out[o + 1] = enc(g); out[o + 2] = enc(b)
  }
  return { data: out, width: w, height: h }
}

/** 8-bit RGBA view of a 16-bit image, optionally downscaled by an integer factor (for previews). */
export function toRgba8(img: Rgb16, factor = 1): { data: Uint8ClampedArray; width: number; height: number } {
  const w = Math.floor(img.width / factor), h = Math.floor(img.height / factor)
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((y * factor) * img.width + x * factor) * 3, d = (y * w + x) * 4
    out[d] = img.data[s] >> 8; out[d + 1] = img.data[s + 1] >> 8; out[d + 2] = img.data[s + 2] >> 8; out[d + 3] = 255
  }
  return { data: out, width: w, height: h }
}
