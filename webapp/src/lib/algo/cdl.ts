/** ASC CDL (American Society of Cinematographers Color Decision List) grade node: per channel
 *  `out = clamp01(in * slope + offset) ^ power`, then a luma-preserving saturation
 *  (`docs/video-research/colour.md` proposal 3 / addendum). This is the standard four-control
 *  colourist parametrisation (Slope/Offset/Power/Saturation) and is exchanged as a small XML
 *  document (`ColorCorrection` with `SOPNode` + `SatNode`), which `toCdlXml`/`parseCdlXml` write and
 *  read so a grade dialled in here can be handed to Resolve/Nuke and back.
 *
 *  The SOP part is channel-separable (a 1D LUT per channel); saturation mixes channels, so a CDL with
 *  `saturation !== 1` needs a 3D bake (`cdlToLut3D`) or a two-step apply. `applyCdl` works on 0..1
 *  floats and clamps at the end, matching the ASC spec (clamp after SOP, clamp after Sat). Luma weights
 *  are the spec's Rec.709 coefficients (0.2126, 0.7152, 0.0722). Pure: no DOM, no imports outside
 *  `lib/algo`. */

import { type Lut1D, type Lut3D } from './lut'

export type Rgb3 = [number, number, number]

export interface Cdl {
  slope: Rgb3
  offset: Rgb3
  power: Rgb3
  saturation: number
}

export const CDL_IDENTITY: Cdl = { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], saturation: 1 }

export function identityCdl(): Cdl {
  return { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], saturation: 1 }
}

export function isIdentityCdl(c: Cdl): boolean {
  for (let i = 0; i < 3; i++) if (c.slope[i] !== 1 || c.offset[i] !== 0 || c.power[i] !== 1) return false
  return c.saturation === 1
}

/** True when the node only needs per-channel 1D maths (saturation is exactly 1). */
export function isSeparableCdl(c: Cdl): boolean { return c.saturation === 1 }

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x }

function sopChannel(v: number, slope: number, offset: number, power: number): number {
  const x = clamp01(v * slope + offset)
  // power ≤ 0 is meaningless in the spec; guard so a UI typo cannot produce NaN
  return power === 1 ? x : Math.pow(x, power > 1e-6 ? power : 1e-6)
}

/** Apply the CDL to one 0..1 RGB triple, writing into `out` at offset `o` (defaults to a new array). */
export function applyCdl(c: Cdl, r: number, g: number, b: number, out: Float32Array | number[] = [0, 0, 0], o = 0): Float32Array | number[] {
  let R = sopChannel(r, c.slope[0], c.offset[0], c.power[0])
  let G = sopChannel(g, c.slope[1], c.offset[1], c.power[1])
  let B = sopChannel(b, c.slope[2], c.offset[2], c.power[2])
  const s = c.saturation
  if (s !== 1) {
    const luma = 0.2126 * R + 0.7152 * G + 0.0722 * B
    R = clamp01(luma + s * (R - luma))
    G = clamp01(luma + s * (G - luma))
    B = clamp01(luma + s * (B - luma))
  }
  out[o] = R; out[o + 1] = G; out[o + 2] = B
  return out
}

/** The SOP (slope/offset/power) part as a per-channel 1D LUT. Ignores saturation — pair it with
 *  `applyCdl`'s saturation step, or use `cdlToLut3D` when saturation ≠ 1. */
export function cdlToLut1D(c: Cdl, size = 256): Lut1D {
  const r = new Float32Array(size), g = new Float32Array(size), b = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1)
    r[i] = sopChannel(x, c.slope[0], c.offset[0], c.power[0])
    g[i] = sopChannel(x, c.slope[1], c.offset[1], c.power[1])
    b[i] = sopChannel(x, c.slope[2], c.offset[2], c.power[2])
  }
  return { size, r, g, b, domainMin: [0, 0, 0], domainMax: [1, 1, 1], title: 'cdl-sop' }
}

/** Bake the whole node (SOP + saturation) into a 3D LUT (red fastest, as `algo/lut.ts#Lut3D`). */
export function cdlToLut3D(c: Cdl, size = 33): Lut3D {
  const data = new Float32Array(size * size * size * 3)
  let o = 0
  for (let bi = 0; bi < size; bi++) for (let gi = 0; gi < size; gi++) for (let ri = 0; ri < size; ri++) {
    applyCdl(c, ri / (size - 1), gi / (size - 1), bi / (size - 1), data, o)
    o += 3
  }
  return { size, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1], title: 'cdl' }
}

// ---------------------------------------------------------------------------------------------
// .cdl XML (ASC CDL v1.2 ColorCorrection document)
// ---------------------------------------------------------------------------------------------

function fmt(v: number): string {
  // enough digits to round-trip a UI value exactly; trim trailing zeros for readability
  const s = v.toFixed(6)
  return s.replace(/\.?0+$/, '') || '0'
}
function triple(v: Rgb3): string { return `${fmt(v[0])} ${fmt(v[1])} ${fmt(v[2])}` }

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Serialise as an ASC CDL `.cdl` file (one `ColorCorrection` element, XML namespace per the spec). */
export function toCdlXml(c: Cdl, id = 'openflexito'): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<ColorCorrection xmlns="urn:ASC:CDL:v1.2" id="${escapeXml(id)}">`,
    '  <SOPNode>',
    `    <Slope>${triple(c.slope)}</Slope>`,
    `    <Offset>${triple(c.offset)}</Offset>`,
    `    <Power>${triple(c.power)}</Power>`,
    '  </SOPNode>',
    '  <SatNode>',
    `    <Saturation>${fmt(c.saturation)}</Saturation>`,
    '  </SatNode>',
    '</ColorCorrection>',
    '',
  ].join('\n')
}

function tagText(xml: string, tag: string): string | null {
  // tolerant of namespace prefixes (`<cdl:Slope>`) and attributes
  const m = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([^<]*)</(?:[\\w-]+:)?${tag}>`, 'i').exec(xml)
  return m ? m[1].trim() : null
}

function parseTriple(text: string | null, fallback: Rgb3): Rgb3 {
  if (text == null) return fallback
  const parts = text.split(/[\s,]+/).filter(Boolean).map(Number)
  if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) throw new Error(`bad CDL triple: "${text}"`)
  return [parts[0], parts[1], parts[2]]
}

/** Parse the first `ColorCorrection` in a `.cdl` / `.ccc` / `.cc` document. Missing nodes take their
 *  identity value (a SOP-only file is valid per the spec). Throws on malformed numbers or when no
 *  SOPNode/SatNode is present at all. */
export function parseCdlXml(xml: string): Cdl {
  const cc = /<(?:[\w-]+:)?ColorCorrection[\s>][\s\S]*?<\/(?:[\w-]+:)?ColorCorrection>/i.exec(xml)
  const body = cc ? cc[0] : xml
  const hasSop = /<(?:[\w-]+:)?SOPNode/i.test(body), hasSat = /<(?:[\w-]+:)?SatNode/i.test(body)
  if (!hasSop && !hasSat) throw new Error('no SOPNode or SatNode found in CDL document')
  const slope = parseTriple(tagText(body, 'Slope'), [1, 1, 1])
  const offset = parseTriple(tagText(body, 'Offset'), [0, 0, 0])
  const power = parseTriple(tagText(body, 'Power'), [1, 1, 1])
  const satText = tagText(body, 'Saturation')
  const saturation = satText == null ? 1 : Number(satText)
  if (!Number.isFinite(saturation)) throw new Error(`bad CDL saturation: "${satText}"`)
  return { slope, offset, power, saturation }
}
