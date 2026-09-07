/** Pure logic for macro recording/replay: step shape, normalisation, replay timing and parameter
 *  overrides. No device or storage access here (see `services/macro.svelte.ts` for that); kept pure
 *  and vitest-tested per the project convention. */

export type MacroStepKind = 'call' | 'action' | 'wait'

export interface MacroStep {
  kind: MacroStepKind
  /** ms since the recording started (0-based after `normalizeSteps`). */
  t: number
  /** kind 'call': an RPC method name, e.g. 'stage.move_rel'. */
  method?: string
  params?: Record<string, unknown>
  /** kind 'action': a named high-level action, e.g. 'photo' or 'autofocus'. */
  action?: string
  actionParams?: Record<string, unknown>
  /** kind 'wait': a pause with no side effect (used between repeats). */
  waitMs?: number
  label: string
}

export interface Macro {
  id: string
  name: string
  createdAt: string
  steps: MacroStep[]
}

/** Sort by recorded time and rebase so the first step is at t=0. */
export function normalizeSteps(steps: MacroStep[]): MacroStep[] {
  if (!steps.length) return []
  const sorted = [...steps].sort((a, b) => a.t - b.t)
  const t0 = sorted[0].t
  return sorted.map((s) => ({ ...s, t: Math.max(0, s.t - t0) }))
}

/** Per-step delay to wait before executing it during replay: the recorded gap since the previous
 *  step ('recorded' speed), or none at all ('fast'). Steps must already be normalised/expanded. */
export function stepDelays(steps: MacroStep[], speed: 'recorded' | 'fast'): number[] {
  if (speed === 'fast') return steps.map(() => 0)
  return steps.map((s, i) => Math.max(0, s.t - (i === 0 ? 0 : steps[i - 1].t)))
}

/** Repeat the step list `repeat` times (>=1); when repeating, insert a synthetic wait step of
 *  `loopWaitMs` between repetitions (skipped when 0). Timestamps are left as recorded — replay speed
 *  is applied afterwards by `stepDelays`, which only looks at consecutive deltas. */
export function expandForReplay(steps: MacroStep[], repeat = 1, loopWaitMs = 0): MacroStep[] {
  const n = Math.max(1, Math.round(repeat))
  const out: MacroStep[] = []
  for (let i = 0; i < n; i++) {
    if (i > 0 && loopWaitMs > 0) out.push({ kind: 'wait', t: 0, waitMs: loopWaitMs, label: `wait ${loopWaitMs} ms` })
    out.push(...steps)
  }
  return out
}

/** Merge edited parameters (keyed by index into the array passed in) onto a fresh copy of the steps,
 *  used to tweak a macro (e.g. a jog distance) before replay without mutating the saved recording. */
export function applyOverrides(steps: MacroStep[], overrides: Record<number, Record<string, unknown>>): MacroStep[] {
  return steps.map((s, i) => {
    const o = overrides[i]
    if (!o) return s
    if (s.kind === 'call') return { ...s, params: { ...s.params, ...o } }
    if (s.kind === 'action') return { ...s, actionParams: { ...s.actionParams, ...o } }
    return s
  })
}

/** Total wall-clock duration of a replay at the given speed, for display before running it. */
export function totalDurationMs(steps: MacroStep[], speed: 'recorded' | 'fast'): number {
  const delays = stepDelays(steps, speed)
  return delays.reduce((sum, d, i) => sum + d + (steps[i].kind === 'wait' ? steps[i].waitMs ?? 0 : 0), 0)
}
