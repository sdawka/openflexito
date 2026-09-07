export type Axis = 'x' | 'y' | 'z'
export type Vec3 = Record<Axis, number>

export interface FrameMeta {
  seq: number
  size: number
  stream: 'main' | 'lores'
  ts: number | null          // libcamera SensorTimestamp (ns, CLOCK_BOOTTIME)
  t: number                  // device clock when metadata was recorded (ns, same clock)
  exposure?: number | null
  gain?: number | null
  digital_gain?: number | null
  colour_gains?: number[]
  focus_fom?: number | null
  lux?: number | null
}

export interface PositionEvent {
  t: number                  // ns, same clock as FrameMeta.ts
  position: Vec3
  hw: Vec3
  moving: boolean
  target_hw?: Vec3
  duration?: number
  cancelled?: boolean
}

export interface StageStatus {
  position: Vec3
  hw_position: Vec3
  moving: boolean
  backlash: Vec3
  inverted: Record<Axis, boolean>
  engaged: Vec3
  step_time_us: number
  energised?: boolean
  release_after?: number
  firmware: string
  board: string
  port: string
}

export interface CameraControls {
  AeEnable: boolean
  AwbEnable: boolean
  ExposureTime: number
  AnalogueGain: number
  ColourGains: [number, number]
  Brightness: number
  Contrast: number
  Saturation: number
  Sharpness: number
}

export interface CameraStatus {
  sensor: { model?: string; pixel_array_size?: number[]; modes?: unknown[] }
  stream_size: [number, number]
  controls: CameraControls
  clients: number
  tuning_customised: boolean
  fake: boolean
  last_frame: Partial<FrameMeta>
}

export type LedState = 'booting' | 'offline' | 'hotspot' | 'online' | 'streaming' | 'error' | 'off'

export interface DeviceStatus {
  version: string
  led: LedState
  network: { state: string; ip: string | null; connections: string[] }
  errors: Record<string, string>
  camera: CameraStatus | null
  stage: StageStatus | null
  stream_clients: number
}

export interface MoveResult {
  position: Vec3
  t0: number
  t1: number
  start_hw: Vec3
  end_hw: Vec3
  cancelled: boolean
}

export interface RpcMethodDoc {
  name: string
  doc: string
  params: { name: string; type: string; required: boolean; default?: unknown }[]
}
