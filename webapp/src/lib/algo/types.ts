/** Types the algorithms depend on. Owned here so `lib/algo` stays free of imports from the API,
 *  store or service layers; `lib/api/types.ts` re-exports them. */
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

export interface MoveResult {
  position: Vec3
  t0: number
  t1: number
  start_hw: Vec3
  end_hw: Vec3
  cancelled: boolean
}
