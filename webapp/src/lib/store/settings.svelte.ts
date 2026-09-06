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
}

const defaults: Settings = {
  deviceUrl: '', stepXY: 500, stepZ: 100, gamepad: true, invertYKeys: false, showLores: false,
  detectModel: 'Xenova/yolos-tiny', clipModel: 'Xenova/clip-vit-base-patch32', detectThreshold: 0.5, detectIntervalMs: 800,
  followDeadbandPx: 12, followIntervalMs: 400,
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
