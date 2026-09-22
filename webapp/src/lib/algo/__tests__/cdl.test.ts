import { describe, expect, it } from 'vitest'
import { applyCdl, cdlToLut1D, cdlToLut3D, identityCdl, isIdentityCdl, isSeparableCdl, parseCdlXml, toCdlXml, type Cdl } from '../cdl'
import { identity3D, sampleTetra } from '../lut'
import { bakeAdjustments } from '../curves'

describe('applyCdl', () => {
  it('identity leaves colours alone', () => {
    const c = identityCdl()
    expect(isIdentityCdl(c)).toBe(true)
    for (const [r, g, b] of [[0, 0, 0], [1, 1, 1], [0.2, 0.5, 0.8], [0.9, 0.1, 0.4]]) {
      const out = applyCdl(c, r, g, b)
      expect(out[0]).toBeCloseTo(r, 6); expect(out[1]).toBeCloseTo(g, 6); expect(out[2]).toBeCloseTo(b, 6)
    }
  })

  it('applies slope, offset and power per channel, clamping between stages', () => {
    const c: Cdl = { slope: [2, 1, 0.5], offset: [0, 0.1, 0], power: [1, 1, 2], saturation: 1 }
    const out = applyCdl(c, 0.3, 0.5, 0.8)
    expect(out[0]).toBeCloseTo(0.6, 6)
    expect(out[1]).toBeCloseTo(0.6, 6)
    expect(out[2]).toBeCloseTo(Math.pow(0.4, 2), 6)
    // slope 2 on 0.7 → 1.4 → clamped to 1 before power
    const hi = applyCdl({ ...c, power: [2, 1, 1] }, 0.7, 0, 0)
    expect(hi[0]).toBe(1)
  })

  it('saturation 0 gives Rec.709 luma grey; saturation 2 doubles chroma', () => {
    const grey = applyCdl({ ...identityCdl(), saturation: 0 }, 0.2, 0.6, 0.9)
    const luma = 0.2126 * 0.2 + 0.7152 * 0.6 + 0.0722 * 0.9
    expect(grey[0]).toBeCloseTo(luma, 6); expect(grey[1]).toBeCloseTo(luma, 6); expect(grey[2]).toBeCloseTo(luma, 6)
    const more = applyCdl({ ...identityCdl(), saturation: 2 }, 0.4, 0.5, 0.6)
    const l2 = 0.2126 * 0.4 + 0.7152 * 0.5 + 0.0722 * 0.6
    expect(more[0]).toBeCloseTo(l2 + 2 * (0.4 - l2), 6)
    expect(isSeparableCdl({ ...identityCdl(), saturation: 2 })).toBe(false)
  })

  it('slope 0 on a channel isolates the others', () => {
    const out = applyCdl({ ...identityCdl(), slope: [0, 1, 0] }, 0.7, 0.4, 0.9)
    expect(out[0]).toBe(0); expect(out[1]).toBeCloseTo(0.4, 6); expect(out[2]).toBe(0)
  })
})

describe('cdlToLut1D / cdlToLut3D', () => {
  it('1D bake matches applyCdl for a separable node', () => {
    const c: Cdl = { slope: [1.2, 0.9, 1], offset: [-0.05, 0, 0.02], power: [1.1, 0.8, 1], saturation: 1 }
    const l = cdlToLut1D(c, 256)
    for (let i = 0; i < 256; i += 17) {
      const x = i / 255
      const ref = applyCdl(c, x, x, x)
      expect(l.r[i]).toBeCloseTo(ref[0], 6); expect(l.g[i]).toBeCloseTo(ref[1], 6); expect(l.b[i]).toBeCloseTo(ref[2], 6)
    }
  })

  it('identity 3D bake equals identity3D; a saturated bake samples back to applyCdl at the nodes', () => {
    const id = cdlToLut3D(identityCdl(), 9)
    expect(Array.from(id.data)).toEqual(Array.from(identity3D(9).data))
    const c: Cdl = { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], saturation: 0.5 }
    const cube = cdlToLut3D(c, 17)
    const out = new Float32Array(3)
    sampleTetra(cube, 0.25, 0.5, 0.75, out)
    const ref = applyCdl(c, 0.25, 0.5, 0.75)
    expect(out[0]).toBeCloseTo(ref[0], 5); expect(out[1]).toBeCloseTo(ref[1], 5); expect(out[2]).toBeCloseTo(ref[2], 5)
  })

  it('bakeAdjustments honours cdl (before curves) and treats an identity CDL as no-op', () => {
    const same = bakeAdjustments({ cdl: identityCdl() }, 9)
    expect(Array.from(same.data)).toEqual(Array.from(identity3D(9).data))
    const c: Cdl = { slope: [0.5, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], saturation: 1 }
    const cube = bakeAdjustments({ cdl: c, curves: { r: (x) => x * x } }, 17)
    const out = new Float32Array(3)
    sampleTetra(cube, 1, 0.5, 0.5, out)
    expect(out[0]).toBeCloseTo(0.25, 4) // (1*0.5)^2, not (1^2)*0.5
  })
})

describe('.cdl XML', () => {
  it('round-trips through toCdlXml/parseCdlXml', () => {
    const c: Cdl = { slope: [1.25, 0.9, 1.05], offset: [-0.02, 0.01, 0], power: [1.1, 1, 0.95], saturation: 0.8 }
    const xml = toCdlXml(c, 'test grade')
    expect(xml).toContain('<ColorCorrection')
    expect(xml).toContain('<SOPNode>')
    expect(xml).toContain('<SatNode>')
    expect(xml).toContain('id="test grade"')
    const back = parseCdlXml(xml)
    expect(back).toEqual(c)
  })

  it('parses a SOP-only file (saturation defaults to 1) and namespaced tags', () => {
    const xml = `<?xml version="1.0"?><ColorDecisionList xmlns="urn:ASC:CDL:v1.01"><ColorDecision><ColorCorrection id="x">
      <SOPNode><Description>d</Description><Slope>2 2 2</Slope><Offset>0.1 0.1 0.1</Offset><Power>1 1 1</Power></SOPNode>
    </ColorCorrection></ColorDecision></ColorDecisionList>`
    expect(parseCdlXml(xml)).toEqual({ slope: [2, 2, 2], offset: [0.1, 0.1, 0.1], power: [1, 1, 1], saturation: 1 })
    const ns = `<cdl:ColorCorrection xmlns:cdl="urn:ASC:CDL:v1.2"><cdl:SatNode><cdl:Saturation>1.5</cdl:Saturation></cdl:SatNode></cdl:ColorCorrection>`
    expect(parseCdlXml(ns).saturation).toBe(1.5)
  })

  it('rejects malformed input', () => {
    expect(() => parseCdlXml('<nothing/>')).toThrow()
    expect(() => parseCdlXml('<ColorCorrection><SOPNode><Slope>1 x 1</Slope></SOPNode></ColorCorrection>')).toThrow()
  })
})
