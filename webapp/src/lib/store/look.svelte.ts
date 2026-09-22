/** Active "look" (colour LUT + tone/colour adjustments) applied to the live view, optionally baked into
 *  recordings/time-lapse playback and optionally shown in the gallery - see `docs/image-pipeline/design.md`
 *  ("Decisions -> LUTs") and `services/lookProcessor.ts` for how this feeds the frame chain.
 *
 *  `lutId` selects the base LUT: `'none'`, a built-in colour map as `cm:<algo/colormaps.ts key>`, or a
 *  user-imported LUT's id (resolved against `myLuts`, loaded from `store/lutDb.ts`). Adjustments (CDL grade,
 *  filmic preset, levels, saturation, vibrance, hue, curves, mixer) are baked with `algo/curves.ts#bakeAdjustments` and composed on top of the
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

import { isLut3D, identity1D, sample1D, bakeLook, type Look, type Lut, type Lut1D, type Lut3D, sampleTetra, parseLut, parseImageJLut, haldToLut3D, toCube } from '../algo/lut'
import { bakeAdjustments, composeLut1D, levelsToLut1D, filmicCurve, filmicLut1D, FILMIC_DEFAULT_EXPOSURE, type ChannelMixer, type FilmicPreset } from '../algo/curves'
import { identityCdl, isIdentityCdl, isSeparableCdl, cdlToLut1D, toCdlXml, parseCdlXml, type Cdl } from '../algo/cdl'
import { curveChannelsToFns, curveChannelsToLut1D, identityCurveChannels, isIdentityCurveChannels, type CurveChannels } from '../algo/curvePoints'
import { sampleLutToStops, stopsToLut1D, type Stop } from '../algo/gradientStops'
import { COLORMAPS } from '../algo/colormaps'
import { blobFileName } from '../algo/naming'
import { listLuts, putLut, deleteLut, getLut, newLutId, type StoredLut, type LutSource } from './lutDb'

const IDENTITY_MIXER: ChannelMixer = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
function mixerEquals(a: ChannelMixer, b: ChannelMixer): boolean {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (a[i][j] !== b[i][j]) return false
  return true
}
function invertLut1D(size = 256): Lut1D {
  const l = identity1D(size)
  for (let i = 0; i < size; i++) { l.r[i] = 1 - l.r[i]; l.g[i] = 1 - l.g[i]; l.b[i] = 1 - l.b[i] }
  return l
}
/** Apply `Look.strength`'s in-to-transformed mix per channel, pointwise: `out(x) = x + (l(x) - x) * strength`. */
function mixLut1DWithStrength(l: Lut1D, strength: number, size = 256): Lut1D {
  const r = new Float32Array(size), g = new Float32Array(size), b = new Float32Array(size)
  const tmp = new Float32Array(3)
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1)
    sample1D(l, x, x, x, tmp, 0)
    r[i] = x + (tmp[0] - x) * strength
    g[i] = x + (tmp[1] - x) * strength
    b[i] = x + (tmp[2] - x) * strength
  }
  return { size, r, g, b, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }
}

const KEY = 'openflexito.look'
const BAKE_SIZE = 33

export interface Levels { black: number; white: number; gamma: number }
/** Filmic tone preset + linear exposure scale (`algo/curves.ts#filmicCurve`); `neutral` = off. */
export interface Filmic { preset: FilmicPreset; exposure: number }

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
  curves: CurveChannels | null
  channelMixer: ChannelMixer | null
  gradientStops: Stop[] | null
  cdl: Cdl
  filmic: Filmic
}

const defaults: PersistedLook = {
  enabled: false, lutId: 'none', strength: 1, input: 'srgb', pseudo: false, invert: false,
  levels: { black: 0, white: 1, gamma: 1 }, saturation: 0, vibrance: 0, hue: 0,
  curves: null, channelMixer: null, gradientStops: null,
  cdl: identityCdl(), filmic: { preset: 'neutral', exposure: FILMIC_DEFAULT_EXPOSURE },
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
  /** Draggable tone curves (master + per-channel), or `null` while untouched (equivalent to identity). */
  curves = $state<CurveChannels | null>(defaults.curves)
  /** 3x3 channel mixer, or `null` while untouched (equivalent to the identity matrix). */
  channelMixer = $state<ChannelMixer | null>(defaults.channelMixer)
  /** When non-null, this gradient (built by `GradientEditor`) is the LUT source instead of `lutId` -
   *  see `resolveSelected`. */
  gradientStops = $state<Stop[] | null>(defaults.gradientStops)
  /** ASC CDL grade node (`algo/cdl.ts`), applied after the channel mixer and before the curves. */
  cdl = $state<Cdl>(identityCdl())
  /** Filmic preset (applied after the CDL, before the curves). */
  filmic = $state<Filmic>({ ...defaults.filmic })
  myLuts = $state<StoredLut[]>([])

  constructor() { this.load() }

  private resolveSelected(): Lut | null {
    if (this.gradientStops && this.gradientStops.length >= 2) return stopsToLut1D(this.gradientStops)
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
    const hasCurves = !!this.curves && !isIdentityCurveChannels(this.curves)
    const hasMixer = !!this.channelMixer && !mixerEquals(this.channelMixer, IDENTITY_MIXER)
    const hasCdl = !isIdentityCdl(this.cdl)
    const hasFilmic = this.filmic.preset !== 'neutral'
    const hasAdjustments = this.saturation !== 0 || this.vibrance !== 0 || this.hue !== 0
      || lv.black !== 0 || lv.white !== 1 || lv.gamma !== 1 || hasCurves || hasMixer || hasCdl || hasFilmic
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
      const adjCube = bakeAdjustments({
        levels: lv, saturation: this.saturation, vibrance: this.vibrance, hue: this.hue,
        curves: hasCurves ? curveChannelsToFns(this.curves!) : undefined,
        channelMixer: hasMixer ? this.channelMixer! : undefined,
        cdl: hasCdl ? $state.snapshot(this.cdl) as Cdl : undefined,
        filmic: hasFilmic ? filmicCurve(this.filmic.preset, this.filmic.exposure) : undefined,
      }, BAKE_SIZE)
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
      this.curves = p.curves; this.channelMixer = p.channelMixer; this.gradientStops = p.gradientStops
      this.cdl = { ...identityCdl(), ...p.cdl }
      this.filmic = { ...defaults.filmic, ...p.filmic }
    } catch { /* private mode, or no localStorage (tests) */ }
  }

  save(): void {
    try {
      const p: PersistedLook = {
        enabled: this.enabled, lutId: this.lutId, strength: this.strength, input: this.input,
        pseudo: this.pseudo, invert: this.invert, levels: this.levels,
        saturation: this.saturation, vibrance: this.vibrance, hue: this.hue,
        curves: this.curves, channelMixer: this.channelMixer, gradientStops: this.gradientStops,
        cdl: this.cdl, filmic: this.filmic,
      }
      localStorage.setItem(KEY, JSON.stringify(p))
    } catch { /* private mode etc. */ }
  }

  /** Reset the Adjustments disclosure only (levels/saturation/vibrance/hue/curves/mixer); the selected
   *  LUT (and any active gradient edit) is left alone. */
  reset(): void {
    this.levels = { ...defaults.levels }; this.saturation = defaults.saturation; this.vibrance = defaults.vibrance; this.hue = defaults.hue
    this.curves = null; this.channelMixer = null
    this.cdl = identityCdl(); this.filmic = { ...defaults.filmic }
    this.save()
  }

  /** Reset only the CDL node (slope/offset/power/saturation) to identity. */
  resetCdl(): void { this.cdl = identityCdl(); this.save() }

  /** Download the CDL node as an ASC `.cdl` XML file (identity CDL still exports - it's a valid file). */
  exportCdl(): void {
    const text = toCdlXml($state.snapshot(this.cdl) as Cdl, 'openflexito-look')
    download(new Blob([text], { type: 'application/xml' }), blobFileName({ when: new Date().toISOString(), name: 'Grade' }, 'image', 'cdl'))
  }

  /** Load a `.cdl` / `.ccc` / `.cc` file into the CDL node (replaces the current one). */
  async importCdl(file: File): Promise<void> {
    this.cdl = parseCdlXml(await file.text())
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

  async renameLut(id: string, name: string): Promise<void> {
    const existing = this.myLuts.find((l) => l.id === id) ?? (await getLut(id))
    if (!existing) return
    await putLut({ ...existing, name })
    await this.refreshLuts()
  }

  /** Display name of whatever is currently selected as the LUT source (a gradient edit in progress, a
   *  built-in colour map, a user LUT, or `'None'`) - used to default the "Save as LUT…" name field. */
  currentSourceName(): string {
    if (this.gradientStops) return 'Gradient'
    if (this.lutId === 'none') return 'None'
    if (this.lutId.startsWith('cm:')) return COLORMAPS[this.lutId.slice(3)]?.name ?? this.lutId.slice(3)
    return this.myLuts.find((l) => l.id === this.lutId)?.name ?? 'LUT'
  }

  /** Seed `gradientStops` from the currently selected 1D LUT (or the identity ramp, if the source is a
   *  3D cube or none) and switch the LUT source to that gradient, so `GradientEditor` can edit it. */
  startGradientEdit(): void {
    const selected = this.resolveSelected()
    const base = selected && !isLut3D(selected) ? (selected as Lut1D) : identity1D(256)
    this.gradientStops = sampleLutToStops(base, 12)
    this.save()
  }

  /** Discard an in-progress gradient edit and return to whatever `lutId` names. */
  discardGradientEdit(): void {
    this.gradientStops = null
    this.save()
  }

  /** Bake the *entire* current look (selected LUT/gradient + invert + pseudo + curves + mixer +
   *  levels/saturation/vibrance/hue, all mixed by `strength`) into a single user LUT, select it, and
   *  reset every adjustment/curve/mixer/gradient back to neutral - so the live result looks identical
   *  before and after the save. Stored as a compact 1D 256-entry LUT when the whole pipeline is
   *  channel-separable (no 3D cube source, no pseudo-colour, no hue/saturation/vibrance, no channel
   *  mixer, CDL saturation exactly 1 - curves, levels, the CDL's slope/offset/power and the filmic curve
   *  are pointwise per channel, so they stay 1D-safe); otherwise a 33^3 cube. */
  async saveAsLut(name: string): Promise<StoredLut> {
    const cur = this.current
    if (!cur) throw new Error('nothing to save: enable the Look and set a LUT or adjustment first')
    const selected = this.resolveSelected()
    const hasCubeSource = !!selected && isLut3D(selected)
    const hasCurves = !!this.curves && !isIdentityCurveChannels(this.curves)
    const hasMixer = !!this.channelMixer && !mixerEquals(this.channelMixer, IDENTITY_MIXER)
    const hasCdl = !isIdentityCdl(this.cdl)
    const hasFilmic = this.filmic.preset !== 'neutral'
    const separable = !hasCubeSource && !this.pseudo && this.hue === 0 && this.saturation === 0 && this.vibrance === 0 && !hasMixer
      && (!hasCdl || isSeparableCdl(this.cdl))

    let lut: Lut
    if (separable) {
      let l1: Lut1D = (selected as Lut1D | null) ?? identity1D(256)
      // same order as `bakeAdjustments`: (mixer,) CDL, filmic, curves, levels
      if (hasCdl) l1 = composeLut1D(l1, cdlToLut1D($state.snapshot(this.cdl) as Cdl))
      if (hasFilmic) l1 = composeLut1D(l1, filmicLut1D(this.filmic.preset, this.filmic.exposure))
      if (hasCurves) l1 = composeLut1D(l1, curveChannelsToLut1D(this.curves!))
      const lv = this.levels
      if (lv.black !== 0 || lv.white !== 1 || lv.gamma !== 1) l1 = composeLut1D(l1, levelsToLut1D(lv.black, lv.white, lv.gamma))
      if (this.invert) l1 = composeLut1D(l1, invertLut1D())
      lut = mixLut1DWithStrength(l1, this.strength)
    } else {
      lut = bakeLook(cur, BAKE_SIZE)
    }

    const stored = storedFromLut(lut, { id: newLutId(), name, source: 'adjust', when: new Date().toISOString() })
    await putLut(stored)
    await this.refreshLuts()
    this.lutId = stored.id
    this.gradientStops = null
    this.curves = null
    this.channelMixer = null
    this.cdl = identityCdl()
    this.filmic = { ...defaults.filmic }
    this.levels = { ...defaults.levels }
    this.saturation = defaults.saturation
    this.vibrance = defaults.vibrance
    this.hue = defaults.hue
    this.invert = false
    this.pseudo = false
    this.strength = 1
    this.save()
    return stored
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
