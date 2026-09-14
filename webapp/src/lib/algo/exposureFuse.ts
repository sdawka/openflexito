/** Multi-scale exposure fusion (Mertens, Kautz, Van Reeth 2007): per-pixel weights from local
 *  contrast, colour saturation and well-exposedness, blended in a Laplacian pyramid so the weight
 *  transitions happen at every scale at once. Unlike a single-scale block blend (`stack.ts
 *  exposureFuse`) this leaves no halos or brightness bands along the borders between regions that
 *  came from different frames. Works on display-referred data (JPEG stills) as well as on linear
 *  radiance re-exposed at several stops (`hdr.ts toneMapMertens`).
 *
 *  Self-contained pyramid helpers (Burt-Adelson 5-tap analysis, bilinear synthesis; exact
 *  reconstruction because the same synthesis is used to build and to collapse). */

import type { Rgba } from './stack'

export interface RgbPlanes { r: Float32Array; g: Float32Array; b: Float32Array; width: number; height: number }
export interface Plane { data: Float32Array; width: number; height: number }

export interface MertensOptions {
  contrast?: number      // exponent on |Laplacian| of the grey image (default 1)
  saturation?: number    // exponent on the RGB standard deviation (default 1)
  exposedness?: number   // exponent on the Gaussian well-exposedness (default 1)
  sigma?: number         // well-exposedness width around 0.5 (default 0.2)
  levels?: number        // pyramid depth (default: down to ~8 px)
}

export function rgbaToPlanes(img: Rgba): RgbPlanes {
  const n = img.width * img.height
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n)
  for (let i = 0, p = 0; i < n; i++, p += 4) { r[i] = img.data[p] / 255; g[i] = img.data[p + 1] / 255; b[i] = img.data[p + 2] / 255 }
  return { r, g, b, width: img.width, height: img.height }
}
export function planesToRgba(p: RgbPlanes): Rgba {
  const n = p.width * p.height, data = new Uint8ClampedArray(n * 4)
  for (let i = 0, o = 0; i < n; i++, o += 4) { data[o] = Math.round(p.r[i] * 255); data[o + 1] = Math.round(p.g[i] * 255); data[o + 2] = Math.round(p.b[i] * 255); data[o + 3] = 255 }
  return { data, width: p.width, height: p.height }
}
/** Interleaved float RGB (0..1) -> planes and back. */
export function interleavedToPlanes(data: Float32Array, width: number, height: number): RgbPlanes {
  const n = width * height, r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n)
  for (let i = 0, p = 0; i < n; i++, p += 3) { r[i] = data[p]; g[i] = data[p + 1]; b[i] = data[p + 2] }
  return { r, g, b, width, height }
}
export function planesToInterleaved(p: RgbPlanes): Float32Array {
  const n = p.width * p.height, out = new Float32Array(n * 3)
  for (let i = 0, o = 0; i < n; i++, o += 3) { out[o] = p.r[i]; out[o + 1] = p.g[i]; out[o + 2] = p.b[i] }
  return out
}

const mirror = (i: number, n: number) => (i < 0 ? -i : i >= n ? 2 * n - 2 - i : i)

/** 5-tap [1 4 6 4 1]/16 blur then decimate by two (ceil sizes). */
export function pyrDown(p: Plane): Plane {
  const { data: src, width: w, height: h } = p
  const w2 = Math.max(1, Math.ceil(w / 2)), h2 = Math.max(1, Math.ceil(h / 2))
  const tmp = new Float32Array(w2 * h)   // horizontal pass, decimated in x
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x2 = 0; x2 < w2; x2++) {
      const x = 2 * x2
      tmp[y * w2 + x2] = (src[row + mirror(x - 2, w)] + 4 * src[row + mirror(x - 1, w)] + 6 * src[row + mirror(x, w)] + 4 * src[row + mirror(x + 1, w)] + src[row + mirror(x + 2, w)]) / 16
    }
  }
  const out = new Float32Array(w2 * h2)
  for (let y2 = 0; y2 < h2; y2++) {
    const y = 2 * y2
    const ym2 = mirror(y - 2, h) * w2, ym1 = mirror(y - 1, h) * w2, y0 = mirror(y, h) * w2, yp1 = mirror(y + 1, h) * w2, yp2 = mirror(y + 2, h) * w2
    for (let x2 = 0; x2 < w2; x2++) out[y2 * w2 + x2] = (tmp[ym2 + x2] + 4 * tmp[ym1 + x2] + 6 * tmp[y0 + x2] + 4 * tmp[yp1 + x2] + tmp[yp2 + x2]) / 16
  }
  return { data: out, width: w2, height: h2 }
}

/** Bilinear upsample to an explicit target size (the level above's size). */
export function pyrUp(p: Plane, width: number, height: number): Plane {
  const { data: src, width: w, height: h } = p
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const fy = Math.min(h - 1, Math.max(0, (y + 0.5) / 2 - 0.5)), y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0
    for (let x = 0; x < width; x++) {
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0
      out[y * width + x] = (src[y0 * w + x0] * (1 - tx) + src[y0 * w + x1] * tx) * (1 - ty) + (src[y1 * w + x0] * (1 - tx) + src[y1 * w + x1] * tx) * ty
    }
  }
  return { data: out, width, height }
}

export function defaultLevels(w: number, h: number): number {
  let n = 1, s = Math.min(w, h)
  while (s > 16) { s = Math.ceil(s / 2); n++ }
  return n
}

export function gaussianPyramid(p: Plane, levels: number): Plane[] {
  const out = [p]
  for (let l = 1; l < levels; l++) out.push(pyrDown(out[l - 1]))
  return out
}

/** Laplacian pyramid: levels 0..n-2 are band-pass residuals, the last is the coarse Gaussian. */
export function laplacianPyramid(p: Plane, levels: number): Plane[] {
  const g = gaussianPyramid(p, levels)
  const out: Plane[] = []
  for (let l = 0; l < levels - 1; l++) {
    const up = pyrUp(g[l + 1], g[l].width, g[l].height)
    const d = new Float32Array(g[l].data.length)
    for (let i = 0; i < d.length; i++) d[i] = g[l].data[i] - up.data[i]
    out.push({ data: d, width: g[l].width, height: g[l].height })
  }
  out.push(g[levels - 1])
  return out
}

export function collapseLaplacian(pyr: Plane[]): Plane {
  let cur = pyr[pyr.length - 1]
  for (let l = pyr.length - 2; l >= 0; l--) {
    const up = pyrUp(cur, pyr[l].width, pyr[l].height)
    const d = new Float32Array(up.data.length)
    for (let i = 0; i < d.length; i++) d[i] = up.data[i] + pyr[l].data[i]
    cur = { data: d, width: pyr[l].width, height: pyr[l].height }
  }
  return cur
}

/** Mertens quality measures per pixel -> unnormalised weight map. */
export function mertensWeight(img: RgbPlanes, o: MertensOptions = {}): Float32Array {
  const { r, g, b, width: w, height: h } = img
  const wc = o.contrast ?? 1, ws = o.saturation ?? 1, we = o.exposedness ?? 1, sigma = o.sigma ?? 0.2
  const n = w * h
  const grey = new Float32Array(n)
  for (let i = 0; i < n; i++) grey[i] = 0.2126 * r[i] + 0.7152 * g[i] + 0.0722 * b[i]
  const out = new Float32Array(n)
  const twoSigma2 = 2 * sigma * sigma
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x
    // contrast: |3×3 Laplacian| of the grey image
    const lap = Math.abs(4 * grey[i] - grey[y * w + mirror(x - 1, w)] - grey[y * w + mirror(x + 1, w)] - grey[mirror(y - 1, h) * w + x] - grey[mirror(y + 1, h) * w + x])
    // saturation: std dev of the three channels
    const mu = (r[i] + g[i] + b[i]) / 3
    const sat = Math.sqrt(((r[i] - mu) ** 2 + (g[i] - mu) ** 2 + (b[i] - mu) ** 2) / 3)
    // well-exposedness: product of per-channel Gaussians around mid grey
    const ex = Math.exp(-((r[i] - 0.5) ** 2) / twoSigma2) * Math.exp(-((g[i] - 0.5) ** 2) / twoSigma2) * Math.exp(-((b[i] - 0.5) ** 2) / twoSigma2)
    out[i] = Math.pow(lap + 1e-6, wc) * Math.pow(sat + 1e-6, ws) * Math.pow(ex + 1e-6, we) + 1e-12
  }
  return out
}

/** Fuse float RGB planes (0..1). Output clamped to 0..1. */
export function mertensFusePlanes(images: RgbPlanes[], o: MertensOptions = {}): RgbPlanes {
  if (!images.length) throw new Error('mertensFusePlanes: no images')
  if (images.length === 1) return images[0]
  const { width: w, height: h } = images[0]
  for (const im of images) if (im.width !== w || im.height !== h) throw new Error('mertensFusePlanes: images differ in size')
  const levels = o.levels ?? defaultLevels(w, h)
  // normalised weights
  const weights = images.map((im) => mertensWeight(im, o))
  const n = w * h
  for (let i = 0; i < n; i++) {
    let s = 0
    for (const wt of weights) s += wt[i]
    for (const wt of weights) wt[i] /= s
  }
  const weightPyrs = weights.map((wt) => gaussianPyramid({ data: wt, width: w, height: h }, levels))
  const fuseChannel = (key: 'r' | 'g' | 'b'): Float32Array => {
    let acc: Plane[] | null = null
    images.forEach((im, k) => {
      const lap = laplacianPyramid({ data: im[key], width: w, height: h }, levels)
      if (!acc) acc = lap.map((p) => ({ data: new Float32Array(p.data.length), width: p.width, height: p.height }))
      for (let l = 0; l < levels; l++) {
        const a = acc[l].data, L = lap[l].data, W = weightPyrs[k][l].data
        for (let i = 0; i < a.length; i++) a[i] += L[i] * W[i]
      }
    })
    const out = collapseLaplacian(acc!).data
    for (let i = 0; i < out.length; i++) out[i] = out[i] < 0 ? 0 : out[i] > 1 ? 1 : out[i]
    return out
  }
  return { r: fuseChannel('r'), g: fuseChannel('g'), b: fuseChannel('b'), width: w, height: h }
}

/** Fuse 8-bit RGBA frames (JPEG stills at several LED levels / exposures). */
export function mertensFuse(images: Rgba[], o: MertensOptions = {}): Rgba {
  if (images.length === 1) return images[0]
  return planesToRgba(mertensFusePlanes(images.map(rgbaToPlanes), o))
}
