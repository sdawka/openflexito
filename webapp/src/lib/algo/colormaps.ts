/** Built-in colour maps, generated in code rather than shipped as binaries (CLAUDE.md: no bundled
 *  LUT binaries). Two families:
 *   - `scientific`: Matplotlib's viridis/magma/inferno/plasma/cividis, embedded as a 33-stop
 *     subsample (every 8th of the published 256-entry table, plus the endpoint) of the CC0 control
 *     tables at github.com/matplotlib/matplotlib `lib/matplotlib/_cm_listed.py` (cividis itself is
 *     Apache-2.0, van der Walt & Smith / Nuñez, Anderton & Renslow — also public on that same file),
 *     linearly interpolated between stops. 33 stops reproduces the source curves to within ~1/255 —
 *     well under the resolution these are used at (256-entry Lut1D) — while keeping this file small.
 *   - `imagej`: reproduced from the exact control-point tables in ImageJ's own `LutLoader.java`
 *     (github.com/imagej/ImageJ/blob/master/ij/plugin/LutLoader.java, public domain), fetched
 *     directly rather than trusting a paraphrase. Two corrections against the initial research pass:
 *     `LutLoader.interpolate()` is **linear**, not Catmull-Rom, between control points; and `3-3-2 RGB`
 *     is not interpolated at all — it's a bit-mask ("posterize") map (`r=i&0xe0`, `g=(i<<3)&0xe0`,
 *     `b=(i<<6)&0xc0`). `hilo`, `cool`, `sepia`, `16 colors` and `phase` aren't in ImageJ's core
 *     loader (some are Fiji plugins with no single canonical control-point source); they're built
 *     here from the plain descriptions in common use. `royal` has no verifiable control points and is
 *     omitted rather than guessed. */

import { identity1D, lut1DFromStops, type Lut1D } from './lut'

export type ColormapGroup = 'scientific' | 'imagej' | 'basic' | 'okabe'

export interface ColormapEntry {
  name: string
  group: ColormapGroup
  licence: string
  build(): Lut1D
}

const MPL_LICENCE = 'CC0 (public domain), matplotlib project'
const CIVIDIS_LICENCE = 'Apache-2.0, PNNL cividis (matplotlib bundled copy)'
const IJ_LICENCE = 'Public domain, ImageJ (Wayne Rasband / NIH)'
/** Okabe & Ito (2008) "Color Universal Design" palette: eight hues chosen to stay distinguishable
 *  under the common forms of colour-vision deficiency (jfly.uni-koeln.de/color/). The palette is a set
 *  of published sRGB values, not a copyrightable work; the single-hue ramps below (black → hue) are
 *  generated here as linear interpolations, the same construction ImageJ's Red/Green/Blue use. */
const OKABE_LICENCE = 'Okabe & Ito 2008 Color Universal Design palette values (freely usable), ramps generated here'
export const OKABE_ITO: Record<'orange' | 'skyblue' | 'green' | 'yellow' | 'blue' | 'vermillion' | 'purple', [number, number, number]> = {
  orange: [230 / 255, 159 / 255, 0],
  skyblue: [86 / 255, 180 / 255, 233 / 255],
  green: [0, 158 / 255, 115 / 255],
  yellow: [240 / 255, 228 / 255, 66 / 255],
  blue: [0, 114 / 255, 178 / 255],
  vermillion: [213 / 255, 94 / 255, 0],
  purple: [204 / 255, 121 / 255, 167 / 255],
}
function okabeRamp(hue: [number, number, number]): Lut1D {
  return build((i) => [hue[0] * i / 255, hue[1] * i / 255, hue[2] * i / 255])
}

function stops33(rows: Array<[number, number, number, number]>): Array<[number, [number, number, number]]> {
  return rows.map(([pos, r, g, b]) => [pos, [r, g, b]])
}

// 33-stop subsamples (index 0,8,16,...,248,255 of the 256-entry published tables) of Matplotlib's
// _magma_data / _inferno_data / _plasma_data / _viridis_data / _cividis_data in _cm_listed.py.
const MAGMA_STOPS = stops33([
  [0.0000, 0.0015, 0.0005, 0.0139], [0.0314, 0.0137, 0.0118, 0.0687], [0.0627, 0.0396, 0.0311, 0.1335],
  [0.0941, 0.0743, 0.0520, 0.2027], [0.1255, 0.1131, 0.0655, 0.2768], [0.1569, 0.1590, 0.0684, 0.3527],
  [0.1882, 0.2117, 0.0620, 0.4186], [0.2196, 0.2654, 0.0602, 0.4618], [0.2510, 0.3167, 0.0717, 0.4854],
  [0.2824, 0.3660, 0.0903, 0.4980], [0.3137, 0.4147, 0.1104, 0.5047], [0.3451, 0.4635, 0.1299, 0.5077],
  [0.3765, 0.5128, 0.1482, 0.5076], [0.4078, 0.5629, 0.1654, 0.5047], [0.4392, 0.6136, 0.1818, 0.4985],
  [0.4706, 0.6649, 0.1981, 0.4888], [0.5020, 0.7164, 0.2150, 0.4753], [0.5333, 0.7674, 0.2337, 0.4578],
  [0.5647, 0.8169, 0.2559, 0.4365], [0.5961, 0.8633, 0.2837, 0.4124], [0.6275, 0.9043, 0.3196, 0.3881],
  [0.6588, 0.9372, 0.3649, 0.3686], [0.6902, 0.9609, 0.4183, 0.3596], [0.7216, 0.9767, 0.4762, 0.3645],
  [0.7529, 0.9867, 0.5356, 0.3822], [0.7843, 0.9928, 0.5949, 0.4103], [0.8157, 0.9961, 0.6537, 0.4462],
  [0.8471, 0.9973, 0.7118, 0.4882], [0.8784, 0.9969, 0.7696, 0.5349], [0.9098, 0.9951, 0.8271, 0.5857],
  [0.9412, 0.9924, 0.8843, 0.6401], [0.9725, 0.9894, 0.9415, 0.6975], [1.0000, 0.9871, 0.9914, 0.7495],
])
const INFERNO_STOPS = stops33([
  [0.0000, 0.0015, 0.0005, 0.0139], [0.0314, 0.0140, 0.0112, 0.0719], [0.0627, 0.0423, 0.0281, 0.1411],
  [0.0941, 0.0820, 0.0433, 0.2153], [0.1255, 0.1293, 0.0473, 0.2908], [0.1569, 0.1834, 0.0403, 0.3550],
  [0.1882, 0.2383, 0.0366, 0.3964], [0.2196, 0.2908, 0.0456, 0.4186], [0.2510, 0.3415, 0.0623, 0.4294],
  [0.2824, 0.3915, 0.0809, 0.4331], [0.3137, 0.4412, 0.0993, 0.4316], [0.3451, 0.4910, 0.1172, 0.4256],
  [0.3765, 0.5409, 0.1347, 0.4151], [0.4078, 0.5907, 0.1526, 0.4003], [0.4392, 0.6401, 0.1714, 0.3811],
  [0.4706, 0.6887, 0.1922, 0.3576], [0.5020, 0.7357, 0.2159, 0.3302], [0.5333, 0.7805, 0.2433, 0.2995],
  [0.5647, 0.8224, 0.2752, 0.2661], [0.5961, 0.8605, 0.3119, 0.2306], [0.6275, 0.8943, 0.3534, 0.1936],
  [0.6588, 0.9232, 0.3994, 0.1552], [0.6902, 0.9470, 0.4492, 0.1153], [0.7216, 0.9654, 0.5022, 0.0739],
  [0.7529, 0.9784, 0.5579, 0.0349], [0.7843, 0.9860, 0.6158, 0.0256], [0.8157, 0.9879, 0.6753, 0.0653],
  [0.8471, 0.9841, 0.7361, 0.1295], [0.8784, 0.9746, 0.7977, 0.2063], [0.9098, 0.9606, 0.8591, 0.2980],
  [0.9412, 0.9476, 0.9174, 0.4107], [0.9725, 0.9545, 0.9659, 0.5404], [1.0000, 0.9884, 0.9984, 0.6449],
])
const PLASMA_STOPS = stops33([
  [0.0000, 0.0504, 0.0298, 0.5280], [0.0314, 0.1324, 0.0223, 0.5633], [0.0627, 0.1934, 0.0184, 0.5903],
  [0.0941, 0.2480, 0.0144, 0.6129], [0.1255, 0.2999, 0.0096, 0.6316], [0.1569, 0.3502, 0.0044, 0.6463],
  [0.1882, 0.3994, 0.0009, 0.6561], [0.2196, 0.4477, 0.0021, 0.6602], [0.2510, 0.4949, 0.0120, 0.6579],
  [0.2824, 0.5406, 0.0350, 0.6486], [0.3137, 0.5844, 0.0686, 0.6328], [0.3451, 0.6260, 0.1033, 0.6113],
  [0.3765, 0.6651, 0.1386, 0.5856], [0.4078, 0.7018, 0.1740, 0.5573], [0.4392, 0.7360, 0.2094, 0.5279],
  [0.4706, 0.7681, 0.2448, 0.4985], [0.5020, 0.7982, 0.2802, 0.4695], [0.5333, 0.8266, 0.3157, 0.4413],
  [0.5647, 0.8533, 0.3516, 0.4137], [0.5961, 0.8784, 0.3879, 0.3866], [0.6275, 0.9018, 0.4251, 0.3597],
  [0.6588, 0.9233, 0.4633, 0.3328], [0.6902, 0.9426, 0.5026, 0.3058], [0.7216, 0.9594, 0.5434, 0.2787],
  [0.7529, 0.9734, 0.5858, 0.2515], [0.7843, 0.9842, 0.6297, 0.2246], [0.8157, 0.9914, 0.6754, 0.1985],
  [0.8471, 0.9945, 0.7227, 0.1744], [0.8784, 0.9930, 0.7717, 0.1548], [0.9098, 0.9865, 0.8224, 0.1436],
  [0.9412, 0.9744, 0.8746, 0.1441], [0.9725, 0.9568, 0.9282, 0.1524], [1.0000, 0.9400, 0.9752, 0.1313],
])
const VIRIDIS_STOPS = stops33([
  [0.0000, 0.2670, 0.0049, 0.3294], [0.0314, 0.2770, 0.0503, 0.3757], [0.0627, 0.2823, 0.0950, 0.4173],
  [0.0941, 0.2829, 0.1359, 0.4534], [0.1255, 0.2788, 0.1755, 0.4834], [0.1569, 0.2706, 0.2141, 0.5071],
  [0.1882, 0.2590, 0.2515, 0.5247], [0.2196, 0.2450, 0.2877, 0.5373], [0.2510, 0.2297, 0.3224, 0.5457],
  [0.2824, 0.2143, 0.3556, 0.5512], [0.3137, 0.1994, 0.3876, 0.5546], [0.3451, 0.1856, 0.4186, 0.5568],
  [0.3765, 0.1727, 0.4488, 0.5579], [0.4078, 0.1607, 0.4785, 0.5581], [0.4392, 0.1490, 0.5081, 0.5573],
  [0.4706, 0.1378, 0.5375, 0.5549], [0.5020, 0.1276, 0.5669, 0.5506], [0.5333, 0.1206, 0.5964, 0.5436],
  [0.5647, 0.1206, 0.6258, 0.5335], [0.5961, 0.1323, 0.6550, 0.5197], [0.6275, 0.1579, 0.6838, 0.5017],
  [0.6588, 0.1966, 0.7118, 0.4792], [0.6902, 0.2461, 0.7389, 0.4520], [0.7216, 0.3041, 0.7647, 0.4199],
  [0.7529, 0.3692, 0.7889, 0.3829], [0.7843, 0.4401, 0.8111, 0.3410], [0.8157, 0.5160, 0.8312, 0.2943],
  [0.8471, 0.5958, 0.8487, 0.2433], [0.8784, 0.6785, 0.8637, 0.1895], [0.9098, 0.7624, 0.8764, 0.1371],
  [0.9412, 0.8456, 0.8873, 0.0997], [0.9725, 0.9261, 0.8973, 0.1041], [1.0000, 0.9932, 0.9062, 0.1439],
])
const CIVIDIS_STOPS = stops33([
  [0.0000, 0.0000, 0.1351, 0.3048], [0.0314, 0.0000, 0.1579, 0.3575], [0.0627, 0.0000, 0.1788, 0.4148],
  [0.0941, 0.0179, 0.1985, 0.4412], [0.1255, 0.1034, 0.2204, 0.4358], [0.1569, 0.1543, 0.2425, 0.4301],
  [0.1882, 0.1951, 0.2644, 0.4259], [0.2196, 0.2309, 0.2861, 0.4235], [0.2510, 0.2637, 0.3078, 0.4228],
  [0.2824, 0.2947, 0.3295, 0.4237], [0.3137, 0.3242, 0.3513, 0.4263], [0.3451, 0.3529, 0.3732, 0.4302],
  [0.3765, 0.3808, 0.3952, 0.4357], [0.4078, 0.4082, 0.4174, 0.4426], [0.4392, 0.4352, 0.4398, 0.4511],
  [0.4706, 0.4616, 0.4624, 0.4620], [0.5020, 0.4887, 0.4853, 0.4710], [0.5333, 0.5179, 0.5085, 0.4727],
  [0.5647, 0.5478, 0.5319, 0.4717], [0.5961, 0.5782, 0.5557, 0.4687], [0.6275, 0.6091, 0.5798, 0.4636],
  [0.6588, 0.6404, 0.6044, 0.4568], [0.6902, 0.6720, 0.6293, 0.4480], [0.7216, 0.7040, 0.6547, 0.4371],
  [0.7529, 0.7365, 0.6806, 0.4240], [0.7843, 0.7694, 0.7070, 0.4085], [0.8157, 0.8027, 0.7340, 0.3902],
  [0.8471, 0.8364, 0.7615, 0.3687], [0.8784, 0.8707, 0.7896, 0.3433], [0.9098, 0.9056, 0.8183, 0.3129],
  [0.9412, 0.9411, 0.8475, 0.2758], [0.9725, 0.9778, 0.8773, 0.2280], [1.0000, 0.9957, 0.9093, 0.2178],
])

// ImageJ LutLoader.java control points (32 stops each, indices 0..255 non-uniform), linearly
// interpolated exactly as LutLoader.interpolate() does.
function stopsFromByteTriples(r: number[], g: number[], b: number[]): Array<[number, [number, number, number]]> {
  return r.map((_, i) => [i / (r.length - 1), [r[i] / 255, g[i] / 255, b[i] / 255]] as [number, [number, number, number]])
}
const FIRE = stopsFromByteTriples(
  [0, 0, 1, 25, 49, 73, 98, 122, 146, 162, 173, 184, 195, 207, 217, 229, 240, 252, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 14, 35, 57, 79, 101, 117, 133, 147, 161, 175, 190, 205, 219, 234, 248, 255, 255, 255, 255],
  [0, 61, 96, 130, 165, 192, 220, 227, 210, 181, 151, 122, 93, 64, 35, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 35, 98, 160, 223, 255],
)
const ICE = stopsFromByteTriples(
  [0, 0, 0, 0, 0, 0, 19, 29, 50, 48, 79, 112, 134, 158, 186, 201, 217, 229, 242, 250, 250, 250, 250, 251, 250, 250, 250, 250, 251, 251, 243, 230],
  [156, 165, 176, 184, 190, 196, 193, 184, 171, 162, 146, 125, 107, 93, 81, 87, 92, 97, 95, 93, 93, 90, 85, 69, 64, 54, 47, 35, 19, 0, 4, 0],
  [140, 147, 158, 166, 170, 176, 209, 220, 234, 225, 236, 246, 250, 251, 250, 250, 245, 230, 230, 222, 202, 180, 163, 142, 123, 114, 106, 94, 84, 64, 26, 27],
)

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s)
  switch (i % 6) {
    case 0: return [v, t, p]
    case 1: return [q, v, p]
    case 2: return [p, v, t]
    case 3: return [p, q, v]
    case 4: return [t, p, v]
    default: return [v, p, q]
  }
}

function build(fn: (i: number) => [number, number, number], size = 256): Lut1D {
  const r = new Float32Array(size), g = new Float32Array(size), b = new Float32Array(size)
  for (let i = 0; i < size; i++) { const [rv, gv, bv] = fn(i); r[i] = rv; g[i] = gv; b[i] = bv }
  return { size, r, g, b, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }
}

function grays(): Lut1D { return build((i) => { const v = i / 255; return [v, v, v] }) }

function glasbeyLite(): Lut1D {
  // deterministic, visually distinct colours via golden-ratio hue stepping with alternating sat/value
  const golden = 0.6180339887498949
  return build((i) => {
    const h = (i * golden) % 1
    const s = 0.55 + 0.45 * ((i * 7) % 5) / 4
    const v = 0.65 + 0.35 * ((i * 11) % 3) / 2
    return hsvToRgb(h, s, v)
  })
}

export const COLORMAPS: Record<string, ColormapEntry> = {
  grays: { name: 'Grays', group: 'imagej', licence: IJ_LICENCE, build: () => grays() },
  viridis: { name: 'Viridis', group: 'scientific', licence: MPL_LICENCE, build: () => lut1DFromStops(VIRIDIS_STOPS, 256, 'linear') },
  magma: { name: 'Magma', group: 'scientific', licence: MPL_LICENCE, build: () => lut1DFromStops(MAGMA_STOPS, 256, 'linear') },
  inferno: { name: 'Inferno', group: 'scientific', licence: MPL_LICENCE, build: () => lut1DFromStops(INFERNO_STOPS, 256, 'linear') },
  plasma: { name: 'Plasma', group: 'scientific', licence: MPL_LICENCE, build: () => lut1DFromStops(PLASMA_STOPS, 256, 'linear') },
  cividis: { name: 'Cividis', group: 'scientific', licence: CIVIDIS_LICENCE, build: () => lut1DFromStops(CIVIDIS_STOPS, 256, 'linear') },

  fire: { name: 'Fire', group: 'imagej', licence: IJ_LICENCE, build: () => lut1DFromStops(FIRE, 256, 'linear') },
  ice: { name: 'Ice', group: 'imagej', licence: IJ_LICENCE, build: () => lut1DFromStops(ICE, 256, 'linear') },
  spectrum: {
    name: 'Spectrum', group: 'imagej', licence: IJ_LICENCE,
    build: () => build((i) => hsvToRgb(i / 255, 1, 1)),
  },
  hilo: {
    name: 'HiLo', group: 'imagej', licence: 'Common ImageJ/Fiji convention (clip-warning LUT), reimplemented here',
    build: () => build((i) => (i === 0 ? [0, 0, 1] : i === 255 ? [1, 0, 0] : [i / 255, i / 255, i / 255])),
  },
  red: { name: 'Red', group: 'imagej', licence: IJ_LICENCE, build: () => build((i) => [i / 255, 0, 0]) },
  green: { name: 'Green', group: 'imagej', licence: IJ_LICENCE, build: () => build((i) => [0, i / 255, 0]) },
  blue: { name: 'Blue', group: 'imagej', licence: IJ_LICENCE, build: () => build((i) => [0, 0, i / 255]) },
  cyan: { name: 'Cyan', group: 'imagej', licence: IJ_LICENCE, build: () => build((i) => [0, i / 255, i / 255]) },
  magenta: { name: 'Magenta', group: 'imagej', licence: IJ_LICENCE, build: () => build((i) => [i / 255, 0, i / 255]) },
  yellow: { name: 'Yellow', group: 'imagej', licence: IJ_LICENCE, build: () => build((i) => [i / 255, i / 255, 0]) },

  'okabe-orange': { name: 'Okabe-Ito orange', group: 'okabe', licence: OKABE_LICENCE, build: () => okabeRamp(OKABE_ITO.orange) },
  'okabe-skyblue': { name: 'Okabe-Ito sky blue', group: 'okabe', licence: OKABE_LICENCE, build: () => okabeRamp(OKABE_ITO.skyblue) },
  'okabe-green': { name: 'Okabe-Ito green', group: 'okabe', licence: OKABE_LICENCE, build: () => okabeRamp(OKABE_ITO.green) },
  'okabe-purple': { name: 'Okabe-Ito purple', group: 'okabe', licence: OKABE_LICENCE, build: () => okabeRamp(OKABE_ITO.purple) },

  '16 colors': {
    name: '16 colors', group: 'imagej', licence: 'Posterised HSV sweep, reimplemented here (not from LutLoader.java)',
    build: () => build((i) => { const step = Math.floor(i / 16); return hsvToRgb(step / 16, 1, 1) }),
  },
  '3-3-2 RGB': {
    name: '3-3-2 RGB', group: 'imagej', licence: IJ_LICENCE,
    // NOT interpolated in ImageJ's source — a direct bit-mask posterisation
    build: () => build((i) => [(i & 0xe0) / 255, ((i << 3) & 0xe0) / 255, ((i << 6) & 0xc0) / 255]),
  },
  phase: {
    name: 'Phase', group: 'imagej', licence: 'Two-cycle HSV hue sweep (common "phase wheel" convention), reimplemented here',
    build: () => build((i) => hsvToRgb((2 * i / 255) % 1, 1, 1)),
  },
  cool: {
    name: 'Cool', group: 'basic', licence: 'MATLAB "cool" colormap formula (cyan to magenta), reimplemented here',
    build: () => build((i) => [i / 255, 1 - i / 255, 1]),
  },
  sepia: {
    name: 'Sepia', group: 'basic', licence: 'Standard sepia-tone ramp, reimplemented here',
    build: () => build((i) => { const v = i / 255; return [Math.min(1, v * 1.07), v * 0.86, v * 0.58] }),
  },
  'glasbey-lite': {
    name: 'Glasbey (lite)', group: 'basic', licence: 'Generated deterministically here (golden-ratio hue stepping), not derived from Glasbey/Fiji tables',
    build: () => glasbeyLite(),
  },
}

/** RGBA preview strip for a named colormap, `width` pixels wide, 1 pixel tall. */
export function colormapPreview(name: string, width: number): Uint8ClampedArray {
  const entry = COLORMAPS[name]
  const lut = entry ? entry.build() : identity1D(256)
  const out = new Uint8ClampedArray(width * 4)
  for (let x = 0; x < width; x++) {
    const t = width === 1 ? 0 : x / (width - 1)
    const idx = Math.round(t * (lut.size - 1))
    out[x * 4] = Math.round(lut.r[idx] * 255)
    out[x * 4 + 1] = Math.round(lut.g[idx] * 255)
    out[x * 4 + 2] = Math.round(lut.b[idx] * 255)
    out[x * 4 + 3] = 255
  }
  return out
}

export function listColormaps(): Array<{ key: string; name: string; group: ColormapGroup; licence: string }> {
  return Object.entries(COLORMAPS).map(([key, e]) => ({ key, name: e.name, group: e.group, licence: e.licence }))
}
