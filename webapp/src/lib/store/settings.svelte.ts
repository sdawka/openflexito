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
