/** Active "look" (colour LUT + tone/colour adjustments) applied to the live view, optionally baked into
 *  recordings/time-lapse playback and optionally shown in the gallery - see `docs/image-pipeline/design.md`
 *  ("Decisions -> LUTs") and `services/lookProcessor.ts` for how this feeds the frame chain.
 *
 *  `lutId` selects the base LUT: `'none'`, a built-in colour map as `cm:<algo/colormaps.ts key>`, or a
 *  user-imported LUT's id (resolved against `myLuts`, loaded from `store/lutDb.ts`). Adjustments (levels,
 *  saturation, vibrance, hue) are baked with `algo/curves.ts#bakeAdjustments` and composed on top of the
 *  selected LUT into one baked `Lut3D` - `current` is that composition as an `algo/lut.ts#Look`, memoised
 *  so the GPU renderer (`gfx/lutGl.ts`) only re-uploads when it actually changes (compared by reference,
 *  not a separate version counter).
 *
 *  Only `enabled`, `lutId` and the adjustment fields are persisted (localStorage, `openflexito.look`) -
 *  never LUT pixel data, which stays in IndexedDB via `lutDb.ts`. `lookProcessor.ts` reads `enabled`
 *  (not `current`) to decide whether the frame chain has anything to do, so a slider drag that only
 *  changes `current`'s *contents* doesn't retrigger effects that merely check "is a look active" (e.g.
 *  StreamView's stream-processing loop) - only flipping `enabled`, or switching in/out of `settings.
 *  lookBakeIntoRecording` for the recorder target, does that. */

import { isLut3D, bakeLook, type Look, type Lut, type Lut1D, type Lut3D, sampleTetra, parseLut, parseImageJLut, haldToLut3D, toCube } from '../algo/lut'
import { bakeAdjustments } from '../algo/curves'
import { COLORMAPS } from '../algo/colormaps'
import { blobFileName } from '../algo/naming'
import { listLuts, putLut, deleteLut, getLut, newLutId, type StoredLut, type LutSource } from './lutDb'

const KEY = 'openflexito.look'
const BAKE_SIZE = 33

export interface Levels { black: number; white: number; gamma: number }

interface PersistedLook {
  enabled: boolean
  lutId: string
  strength: number
  input: 'srgb' | 'linear'
  pseudo: boolean
  invert: boolean
  levels: Levels
  saturation: number
  vibrance: number
  hue: number
}

const defaults: PersistedLook = {
  enabled: false, lutId: 'none', strength: 1, input: 'srgb', pseudo: false, invert: false,
  levels: { black: 0, white: 1, gamma: 1 }, saturation: 0, vibrance: 0, hue: 0,
}

/** Reconstruct an `algo/lut.ts` `Lut` from a `StoredLut` (see `lutDb.ts`'s doc for the `kind: '1d'`
 *  concatenated-blocks layout). */
export function lutFromStored(s: StoredLut): Lut {
  if (s.kind === '3d') return { size: s.size, data: s.data, domainMin: [0, 0, 0], domainMax: [1, 1, 1], title: s.name }
  const n = s.size
  return { size: n, r: s.data.subarray(0, n), g: s.data.subarray(n, 2 * n), b: s.data.subarray(2 * n, 3 * n), domainMin: [0, 0, 0], domainMax: [1, 1, 1], title: s.name }
}

export function storedFromLut(lut: Lut, meta: { id: string; name: string; source: LutSource; when: string }): StoredLut {
  if (isLut3D(lut)) return { ...meta, kind: '3d', size: lut.size, data: lut.data }
  const n = lut.size
  const data = new Float32Array(n * 3)
  data.set(lut.r, 0); data.set(lut.g, n); data.set(lut.b, 2 * n)
  return { ...meta, kind: '1d', size: n, data }
}

/** Compose two baked 3D LUTs into one: `out(x) = second(first(x))`, sampled tetrahedrally (mirrors
 *  `algo/curves.ts#composeLut1D`'s 1D composition, but for cubes - no 3D equivalent exists in `algo/lut.ts`
 *  yet, so it lives here rather than requiring an edit to a file WP1 owns). */
export function composeCubes(first: Lut3D, second: Lut3D, size = Math.max(first.size, second.size)): Lut3D {
  const data = new Float32Array(size * size * size * 3)
  const tmp1 = new Float32Array(3), tmp2 = new Float32Array(3)
  let o = 0
  for (let bi = 0; bi < size; bi++) for (let gi = 0; gi < size; gi++) for (let ri = 0; ri < size; ri++) {
    const r = ri / (size - 1), g = gi / (size - 1), b = bi / (size - 1)
    sampleTetra(first, r, g, b, tmp1, 0)
    sampleTetra(second, tmp1[0], tmp1[1], tmp1[2], tmp2, 0)
    data[o++] = tmp2[0]; data[o++] = tmp2[1]; data[o++] = tmp2[2]
  }
  return { size, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1], title: 'composed-look' }
}

function download(blob: Blob, name: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob); a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

export class LookStore {
  enabled = $state(defaults.enabled)
  lutId = $state(defaults.lutId)
  strength = $state(defaults.strength)
  input = $state<'srgb' | 'linear'>(defaults.input)
  pseudo = $state(defaults.pseudo)
  invert = $state(defaults.invert)
  levels = $state<Levels>({ ...defaults.levels })
  saturation = $state(defaults.saturation)
  vibrance = $state(defaults.vibrance)
  hue = $state(defaults.hue)
  myLuts = $state<StoredLut[]>([])

  constructor() { this.load() }

  private resolveSelected(): Lut | null {
    if (this.lutId === 'none') return null
    if (this.lutId.startsWith('cm:')) {
      const entry = COLORMAPS[this.lutId.slice(3)]
      return entry ? entry.build() : null
    }
    const stored = this.myLuts.find((l) => l.id === this.lutId)
    return stored ? lutFromStored(stored) : null
  }

  /** The baked look to hand to `applyLookRgba`/`LutRenderer`, or `null` when there is nothing to apply
   *  (disabled, or enabled with no LUT selected and every adjustment at its neutral value). Memoised: a
   *  `$derived`, so its `.cube` keeps referential identity across renders that don't actually change it. */
  current: Look | null = $derived.by(() => {
    if (!this.enabled) return null
    const selected = this.resolveSelected()
    const lv = this.levels
    const hasAdjustments = this.saturation !== 0 || this.vibrance !== 0 || this.hue !== 0 || lv.black !== 0 || lv.white !== 1 || lv.gamma !== 1
    if (!selected && !hasAdjustments) return null
    let cube: Lut3D | undefined
    if (selected) {
      const isCube = isLut3D(selected)
      cube = bakeLook({
        curve: isCube ? undefined : (selected as Lut1D),
        cube: isCube ? (selected as Lut3D) : undefined,
        strength: 1, input: 'srgb', pseudo: this.pseudo, invert: this.invert,
      }, BAKE_SIZE)
    }
    if (hasAdjustments) {
      const adjCube = bakeAdjustments({ levels: lv, saturation: this.saturation, vibrance: this.vibrance, hue: this.hue }, BAKE_SIZE)
      cube = cube ? composeCubes(cube, adjCube, BAKE_SIZE) : adjCube
    }
    if (!cube) return null
    return { cube, strength: this.strength, input: this.input, pseudo: false, invert: false }
  })

  private load(): void {
    try {
      const raw = localStorage.getItem(KEY)
      if (!raw) return
      const p = { ...defaults, ...JSON.parse(raw) } as PersistedLook
      this.enabled = p.enabled; this.lutId = p.lutId; this.strength = p.strength; this.input = p.input
      this.pseudo = p.pseudo; this.invert = p.invert; this.levels = p.levels
      this.saturation = p.saturation; this.vibrance = p.vibrance; this.hue = p.hue
    } catch { /* private mode, or no localStorage (tests) */ }
  }

  save(): void {
    try {
      const p: PersistedLook = {
        enabled: this.enabled, lutId: this.lutId, strength: this.strength, input: this.input,
        pseudo: this.pseudo, invert: this.invert, levels: this.levels,
        saturation: this.saturation, vibrance: this.vibrance, hue: this.hue,
      }
      localStorage.setItem(KEY, JSON.stringify(p))
    } catch { /* private mode etc. */ }
  }

  /** Reset the Adjustments disclosure only (levels/saturation/vibrance/hue); the selected LUT is left alone. */
  reset(): void {
    this.levels = { ...defaults.levels }; this.saturation = defaults.saturation; this.vibrance = defaults.vibrance; this.hue = defaults.hue
    this.save()
  }

  async refreshLuts(): Promise<void> {
    try { this.myLuts = await listLuts() } catch { this.myLuts = [] }
  }

  /** Parse and store an uploaded LUT file, select it, and persist the selection. Formats: `.cube`,
   *  `.3dl`, `.lut` (ImageJ binary or text), `.csv`/`.txt` ramps via `algo/lut.ts#parseLut`; `.png` is
   *  treated as a Hald CLUT image (`haldToLut3D`). */
  async importFile(file: File): Promise<StoredLut> {
    const name = file.name
    const ext = name.toLowerCase().split('.').pop() ?? ''
    let lut: Lut
    let source: LutSource
    if (ext === 'png') {
      const bmp = await createImageBitmap(file)
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height
      const ctx = c.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(bmp, 0, 0)
      bmp.close()
      const id = ctx.getImageData(0, 0, c.width, c.height)
      lut = haldToLut3D(id.data, c.width, c.height)
      source = 'hald'
    } else if (ext === 'lut') {
      lut = parseImageJLut(await file.arrayBuffer())
      source = 'imagej'
    } else {
      lut = parseLut(await file.text(), name)
      source = ext === 'cube' ? 'cube' : ext === '3dl' ? '3dl' : 'csv'
    }
    const stored = storedFromLut(lut, { id: newLutId(), name: name.replace(/\.[^.]+$/, ''), source, when: new Date().toISOString() })
    await putLut(stored)
    await this.refreshLuts()
    this.lutId = stored.id
    this.save()
    return stored
  }

  async deleteUserLut(id: string): Promise<void> {
    await deleteLut(id)
    if (this.lutId === id) this.lutId = 'none'
    await this.refreshLuts()
    this.save()
  }

  /** Download the current baked look as an Adobe `.cube` (empty look = no-op). */
  exportCube(): void {
    const l = this.current
    if (!l?.cube) return
    const text = toCube(l.cube, 'openflexito-look')
    const blob = new Blob([text], { type: 'text/plain' })
    download(blob, blobFileName({ when: new Date().toISOString(), name: 'Look' }, 'image', 'cube'))
  }
}

export const look = new LookStore()

// re-exported so callers that only need the stored-LUT loader don't have to import lutDb.ts directly
export async function loadStoredLut(id: string): Promise<StoredLut | undefined> { return getLut(id) }
