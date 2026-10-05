/** Settings persisted in localStorage; the subset in `DEVICE_SETTING_KEYS` is also stored on the microscope. */

import { pickKeys, acceptRemote } from './deviceSettings'

const KEY = 'openflexito.settings'

export interface Settings {
  deviceUrl: string        // '' = same origin (Pi serves the app, or Vite proxy in dev)
  stepXY: number           // steps per jog tick in x/y
  stepZ: number            // steps per jog tick in z
  gamepad: boolean
  invertYKeys: boolean
  /** z jogs (keyboard, HUD, gamepad) ask the device to take up the z backlash on a reversal
   *  (`stage.jog` `take_up: true`), so focus responds at once instead of after the dead band */
  zJogTakeUp: boolean
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
  /** Numerical aperture of the objective in use (0.65 for a typical 40× plan achromat). Sets the
   *  theoretical depth of field that spaces focus-stack slices (`algo/stackPlan.ts`). */
  objectiveNA: number
  /** Autofocus metrics (`services/autofocusService.ts`). `focusSweepMetric`: what the fast sweep scores
   *  frames by: 'fom' = libcamera FocusFoM from the frame metadata (computed by the ISP before the
   *  encoder, so rate control cannot flatten it; falls back to 'jpeg' size when the device sends none).
   *  `focusMetric`: the at-rest measure for the step/fine/local-refine sweeps ('laplacian' default:
   *  measured on the Pi, peak/floor 12 on the 820 px stream frame; 'nv', 'brenner'), scored over a 4x4
   *  tile grid on a stream-frame grab `focusGrabWidth` px wide, default 'native' (the stream's own width,
   *  never upsampled; full-res stills are JPEG-noise dominated, peak/floor 1.14, so never used). */
  focusSweepMetric: 'fom' | 'jpeg'
  focusMetric: 'nv' | 'laplacian' | 'brenner'
  focusGrabWidth: number | 'native'
  showScaleBar: boolean
  /** Shading correction (`services/shadingProcessor.ts`): divide by the illumination map in linear light */
  shadingLive: boolean
  shadingStills: boolean
  /** Video recording defaults (`PhotoPanel.svelte`); `codec` mirrors `services/recorder.svelte.ts`'s
   *  `VideoCodec` ('vp9' | 'av1' | 'vp8' | 'auto') but is kept as `string` here to avoid a runtime
   *  import into this plain settings module. */
  videoCodec: string
  videoBitrateMbps: number
  videoStabilise: boolean
  /** additive WP5 video fields: `videoCodec` above keeps its legacy vp9/av1/vp8 values for old
   *  settings blobs, `videoCodecPref` ('h264' | 'vp9' | 'av1' | 'auto') is what the WebCodecs/
   *  mediabunny recorder actually reads (`services/videoEncoder.ts#VideoCodecPref`). */
  videoCodecPref: string
  videoContainer: 'mp4' | 'webm'
  videoQuality: 'high' | 'medium' | 'low'
  videoKeyframeS: number
  /** bake `services/deflickerProcessor.ts` into recordings by default */
  videoDeflicker: boolean
  videoRetime: 'vfr' | 'cfr'
  videoRetimeFps: number
  /** burn-in overlays (`services/burnIn.ts#BurnInKind`) */
  videoBurnIn: string[]
  /** 'sensor': the camera's hardware H.264 from the binned full-field mode (`recorder.startSensor`);
   *  'view': the 820×616 live view as shown (`recorder.startStream`) */
  videoSource: 'sensor' | 'view'
  /** frame rate asked of the camera for sensor recordings (clamped by the device) */
  videoRecordFps: number
  /** run the deflicker processor on the live view too (off by default: most users never see a
   *  flicker worth the per-frame cost) */
  deflickerLive: boolean
  /** Super-resolution defaults (`services/photo/superres.ts#SuperresOptions`). */
  superresScale: 2 | 3
  superresPixfrac: number
  superresSharpen: boolean
  /** WP4 live denoise (`services/denoiseProcessor.ts`, frame chain order 100): off by default (a
   *  per-frame temporal blend costs real time even at ~1 ms). `liveDenoiseRecord` additionally bakes
   *  it into `record`-target frames (the recorder); `liveDenoiseAlpha` is the `TemporalDenoiser`
   *  blend weight toward history (see `algo/temporalDenoise.ts`'s module doc for the confidence gate). */
  liveDenoise: boolean
  liveDenoiseRecord: boolean
  liveDenoiseAlpha: number
  /** Gallery Enhance panel: preview downsample width (`workers/enhanceWorker.ts`) before "Apply" runs
   *  the full-resolution pipeline. */
  enhancePreviewWidth: number
  /** WP2 look/LUT (`services/lookProcessor.ts`, frame chain order 900 - last, colour). The rest of the
   *  active look (selected LUT, strength, adjustments) lives in `store/look.svelte.ts`'s own persisted
   *  state; these two flags live here because they're read by the frame-chain `enabled()` gate and by
   *  `Viewer.svelte`'s gallery display, both of which already depend on `settings`. */
  lookBakeIntoRecording: boolean
  lookApplyInGallery: boolean
  /** Viewfinder overlays (`services/peakingProcessor.ts`, frame chain order 950, `view` target only):
   *  focus peaking paints strong edges in `peakingColour` (CSS hex), zebra stripes clipped/crushed pixels. */
  peaking: boolean
  zebra: boolean
  peakingColour: string
}

const defaults: Settings = {
  deviceUrl: '', stepXY: 500, stepZ: 100, gamepad: true, invertYKeys: false, zJogTakeUp: true, showLores: false,
  detectModel: 'Xenova/yolos-tiny', clipModel: 'Xenova/clip-vit-base-patch32', detectThreshold: 0.5, detectIntervalMs: 800,
  followDeadbandPx: 12, followIntervalMs: 400,
  lightPresets: {
    Brightfield: { cc: 0.32, pwm: [0, 0] },
    Darkfield: { cc: 0, pwm: [1, 0] },
    Oblique: { cc: 0, pwm: [0, 1] },
    Rheinberg: { cc: 0.1, pwm: [1, 0] },
  },
  stageStepUm: { x: 0.088, y: 0.088, z: 0.050 },
  objectiveNA: 0.65,
  focusSweepMetric: 'fom', focusMetric: 'laplacian', focusGrabWidth: 'native',
  showScaleBar: true,
  shadingLive: false, shadingStills: false,
  videoCodec: 'vp9', videoBitrateMbps: 12, videoStabilise: false,
  videoCodecPref: 'auto', videoContainer: 'mp4', videoQuality: 'high', videoKeyframeS: 2, videoDeflicker: false, deflickerLive: false,
  videoRetime: 'vfr', videoRetimeFps: 18,
  videoBurnIn: [], videoSource: 'sensor', videoRecordFps: 30,
  superresScale: 2, superresPixfrac: 0.5, superresSharpen: false,
  liveDenoise: false, liveDenoiseRecord: false, liveDenoiseAlpha: 0.7, enhancePreviewWidth: 1024,
  lookBakeIntoRecording: false, lookApplyInGallery: true,
  peaking: false, zebra: false, peakingColour: '#00ff00',
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

/** Settings that describe the MICROSCOPE (its optics, stage mechanics, illumination hardware), not this
 *  browser. They are stored on the device under calibration key `settings` and shared by every client
 *  (`services/calibrationSync.svelte.ts`); localStorage is only a cache. Rule: a field belongs here iff its
 *  correct value follows from the instrument; UI preferences, jog steps, gamepad, models, video/photo
 *  defaults, look/LUT and `deviceUrl` stay per browser. */
export const DEVICE_SETTING_KEYS = [
  'stageStepUm', 'objectiveNA', 'lightPresets', 'focusSweepMetric', 'focusMetric', 'focusGrabWidth',
] as const satisfies readonly (keyof Settings)[]
export type DeviceSettingKey = (typeof DEVICE_SETTING_KEYS)[number]

/** Set by `services/calibrationSync.svelte.ts`; called after a save when a device-shared field changed. */
export const settingsSync: { push: (subset: Pick<Settings, DeviceSettingKey>) => void } = { push: () => {} }

const snapshotShared = (): string => JSON.stringify(pickKeys($state.snapshot(settings) as Settings, DEVICE_SETTING_KEYS))
let lastShared = ''

function write(): void {
  try { localStorage.setItem(KEY, JSON.stringify(settings)) } catch { /* private mode etc. */ }
}

export function saveSettings(): void {
  write()
  const now = snapshotShared()
  if (now === lastShared) return
  lastShared = now
  settingsSync.push(JSON.parse(now))
}

/** The device-shared subset as it stands now. */
export function deviceSettingsSubset(): Pick<Settings, DeviceSettingKey> {
  return pickKeys($state.snapshot(settings) as Settings, DEVICE_SETTING_KEYS)
}

/** Apply a `settings` blob that came from the device (device wins). Does not push back. */
export function applyDeviceSettings(remote: unknown): void {
  Object.assign(settings, acceptRemote(remote, DEVICE_SETTING_KEYS, defaults))
  lastShared = snapshotShared()
  write()
}

lastShared = snapshotShared()
