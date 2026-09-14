import { describe, it, expect } from 'vitest'
import { slug, timestampStem, fileStem, blobFileName } from '../naming'

const when = new Date(2026, 8, 10, 19, 25, 30).toISOString()   // local 2026-09-10 19:25:30

describe('naming', () => {
  it('slugs labels with unicode multiplication signs and spaces', () => {
    expect(slug('Focus stack 9×50')).toBe('focus-stack-9x50')
    expect(slug('  Pond water / A3 ')).toBe('pond-water-a3')
    expect(slug('Super-resolution 9 frames ×2')).toBe('super-resolution-9-frames-x2')
    expect(slug('a'.repeat(60)).length).toBeLessThanOrEqual(40)
  })
  it('formats the capture time as a sortable stem', () => {
    expect(timestampStem(when)).toBe('20260910-192530')
    expect(timestampStem('garbage')).toBe('undated')
  })
  it('builds time_sample_label_position stems and drops embedded locale dates', () => {
    expect(fileStem({ when, name: 'Focus stack 9×50', sample: { name: 'Pond water A3' }, position: { x: 120.4, y: -40, z: 1234 } }))
      .toBe('20260910-192530_pond-water-a3_focus-stack-9x50_x120_y-40_z1234')
    expect(fileStem({ when, name: 'Snapshot 10/09/2026, 19:25:30', kind: 'snapshot' })).toBe('20260910-192530_snapshot')
    expect(fileStem({ when, name: '', kind: 'video' })).toBe('20260910-192530_video')
  })
  it('names blobs with a suffix except the main image', () => {
    const it_ = { when, name: 'RAW 10-bit', position: { x: 0, y: 0, z: 5 } }
    expect(blobFileName(it_, 'image', 'png')).toBe('20260910-192530_raw-10-bit_x0_y0_z5.png')
    expect(blobFileName(it_, 'slice/3', 'jpg')).toBe('20260910-192530_raw-10-bit_x0_y0_z5_slice-3.jpg')
    expect(blobFileName(it_, 'dng', 'dng')).toBe('20260910-192530_raw-10-bit_x0_y0_z5_dng.dng')
  })
})
