export type { Axis, Vec3, FrameMeta, MoveResult } from '../algo/types'
import type { Axis, Vec3, FrameMeta } from '../algo/types'

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
  /** device.md §5: stills/raws/brackets get NoiseReductionMode off + Sharpness 0 when true (default true). */
  still_clean?: boolean
  still_jpeg_quality?: number
  max_raw_frames?: number
  max_bracket_frames?: number
  frame_duration_limits_us?: { stream?: [number, number]; still?: [number, number] }
}

export type LedState = 'booting' | 'offline' | 'hotspot' | 'online' | 'streaming' | 'error' | 'off'

export interface NetworkInterface {
  interface: string
  type: 'ethernet' | 'wifi' | 'hotspot'
  connection: string
  ip: string | null
  link_local: boolean
  speed_mbit: number | null
}

/** Additive network fields, per the net-device handoff (jobs/e88486dd/tmp/handoff/net-device.md):
 *  `ip` prefers the Ethernet address when both Ethernet and WiFi are up; the fake device reports
 *  `link: "ethernet"`, `interface: "eth0"`, `speed_mbit: 1000`. */
export interface NetworkStatus {
  state: string
  ip: string | null
  connections: string[]
  /** Which path carries traffic; Ethernet with an IPv4 address beats WiFi. */
  link?: 'ethernet' | 'wifi' | 'hotspot' | 'none' | null
  interface?: string | null
  /** True when `ip` is 169.254.x.x: a cable straight into a laptop with no DHCP server, still
   *  reachable via `microscope.local` (avahi). */
  link_local?: boolean | null
  /** Ethernet link speed in Mbit/s from `/sys/class/net/<if>/speed`; null on WiFi/unknown. */
  speed_mbit?: number | null
  /** Per-interface detail for eth0/wlan0. */
  interfaces?: NetworkInterface[]
}

/** Standby state (device/openflexito/power.py `PowerController`): `since` is ns CLOCK_BOOTTIME of
 *  the last change. Older devices omit this key entirely — treat that as powered on. */
export interface PowerStatus {
  on: boolean
  since: number
  /** Auto-standby timeout in minutes (`power.set_idle`); 0 disables it. Defaults to 10 on the device. */
  idle_minutes?: number
  /** Seconds until auto standby, or -1 when disabled or already off. Refreshed by `power.get/set/
   *  toggle/activity` replies and by `system.status`; not necessarily live-ticking between those. */
  idle_in?: number
  /** Why the last on/off change happened: "request" (manual toggle/tap) or "idle" (auto-standby timer). */
  reason?: string
}

export interface DeviceStatus {
  version: string
  led: LedState
  network: NetworkStatus
  errors: Record<string, string>
  camera: CameraStatus | null
  stage: StageStatus | null
  stream_clients: number
  power?: PowerStatus
}

export interface RpcMethodDoc {
  name: string
  doc: string
  params: { name: string; type: string; required: boolean; default?: unknown }[]
}
