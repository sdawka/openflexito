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
  /** last chosen video mode (`services/video/videoModes.ts#VideoModeId`, kept as string like
   *  `videoCodec`), its per-mode parameters (merged over `DEFAULT_VIDEO_PARAMS` at load) and the
   *  burn-in overlays (`services/video/burnIn.ts#BurnInKind`) */
  videoMode: string
  videoModeParams: Record<string, Record<string, unknown>>
  videoBurnIn: string[]
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
  videoCodec: 'vp9', videoBitrateMbps: 12, videoStabilise: true,
  videoCodecPref: 'auto', videoContainer: 'mp4', videoQuality: 'high', videoKeyframeS: 2, videoDeflicker: false, deflickerLive: false,
  videoMode: 'plain', videoModeParams: {}, videoBurnIn: [],
  superresScale: 2, superresPixfrac: 0.5, superresSharpen: false,
  liveDenoise: false, liveDenoiseRecord: false, liveDenoiseAlpha: 0.7, enhancePreviewWidth: 1024,
  lookBakeIntoRecording: false, lookApplyInGallery: true,
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
