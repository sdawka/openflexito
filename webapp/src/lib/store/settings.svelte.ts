/** Per-browser settings persisted in localStorage. */

const KEY = 'openflexito.settings'

export interface Settings {
  deviceUrl: string        // '' = same origin (Pi serves the app, or Vite proxy in dev)
  stepXY: number           // steps per jog tick in x/y
  stepZ: number            // steps per jog tick in z
  gamepad: boolean
  invertYKeys: boolean
  showLores: boolean
  detectModel: string
  clipModel: string
  detectThreshold: number
  detectIntervalMs: number
  followDeadbandPx: number
  followIntervalMs: number
  /** Illumination presets: name -> LED levels (cc = main condenser LED, pwm = the board's PWM outputs, e.g. a
   *  darkfield ring on PWM 0 and an oblique side LED on PWM 1). Editable from the Illumination panel. */
  lightPresets: Record<string, { cc: number; pwm: number[] }>
  /** Stage step size in µm/step per axis, used to derive the scale bar and measurement tool's µm/px
   *  from the CSM calibration (`lib/algo/measure.ts#umPerPixelFromStageCalibration`). Editable in
   *  Settings; the default is the OpenFlexure v7 low-cost actuator's measured resolution (28BYJ-48
   *  motor, 8192 half-steps/output revolution via the printed gears, M3 leadscrew): xy 88 ± 6 nm/step,
   *  z 50 ± 2 nm/step (Stewart, Bowman et al., "The OpenFlexure Block Stage", arXiv:1911.09986, sec. 3).
   *  Different builds (screw pitch, gearing, worn parts) will vary — override per instrument here, or
   *  use "calibrate from a known length" against a stage micrometer instead. */
  stageStepUm: { x: number; y: number; z: number }
  showScaleBar: boolean
}

const defaults: Settings = {
  deviceUrl: '', stepXY: 500, stepZ: 100, gamepad: true, invertYKeys: false, showLores: false,
  detectModel: 'Xenova/yolos-tiny', clipModel: 'Xenova/clip-vit-base-patch32', detectThreshold: 0.5, detectIntervalMs: 800,
  followDeadbandPx: 12, followIntervalMs: 400,
  lightPresets: {
    Brightfield: { cc: 0.32, pwm: [0, 0] },
    Darkfield: { cc: 0, pwm: [1, 0] },
    Oblique: { cc: 0, pwm: [0, 1] },
    Rheinberg: { cc: 0.1, pwm: [1, 0] },
  },
  stageStepUm: { x: 0.088, y: 0.088, z: 0.050 },
  showScaleBar: true,
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults }
  } catch {
    return { ...defaults }
  }
}

export const settings = $state<Settings>(load())

export function saveSettings(): void {
  try { localStorage.setItem(KEY, JSON.stringify(settings)) } catch { /* private mode etc. */ }
}
