/** Macro recording and replay: hooks `RpcClient.onCall` (see `lib/api/rpc.ts`) to capture stage/light/
 *  camera calls made anywhere in the app while recording, plus high-level actions (photo modes,
 *  autofocus) that call `recordAction` explicitly from the UI handlers that invoke them. Saved macros
 *  live in `store/macroDb.ts`; the pure step/timing logic is in `lib/algo/macro.ts`. */

import { device } from '../store/device.svelte'
import { takePhoto, type PhotoMode } from './photoService'
import { runAutofocus } from './autofocusService'
import { listMacros, putMacro, deleteMacro, newMacroId } from '../store/macroDb'
import { normalizeSteps, stepDelays, expandForReplay, type Macro, type MacroStep } from '../algo/macro'

/** RPC methods worth capturing; keeps a macro to stage/light/camera moves and out of housekeeping calls. */
const RECORD_METHODS = new Set([
  'stage.move_rel', 'stage.move_to', 'stage.jog', 'stage.stop', 'stage.release', 'stage.zero',
  'light.set', 'camera.set_controls',
])

export interface ReplayOptions { speed: 'recorded' | 'fast'; repeat: number; loopWaitMs: number }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

class MacroService {
  recording = $state(false)
  replaying = $state(false)
  paused = $state(false)
  steps = $state<MacroStep[]>([])
  saved = $state<Macro[]>([])
  /** index into the (expanded) replay step list currently executing, or -1 when idle. */
  progress = $state(-1)
  replaySteps = $state<MacroStep[]>([])
  status = $state('')

  private startedAt = 0
  private stopFlag = false
  private pauseFlag = false

  async loadSaved(): Promise<void> {
    this.saved = await listMacros()
  }

  start(): void {
    if (this.recording || this.replaying) return
    this.steps = []
    this.startedAt = performance.now()
    this.recording = true
    device.client.onCall((method, params) => {
      if (!RECORD_METHODS.has(method)) return
      this.steps = [...this.steps, {
        kind: 'call', method, params: (params as Record<string, unknown>) ?? {},
        t: performance.now() - this.startedAt, label: method,
      }]
    })
  }

  /** Record a high-level action (a photo mode, an autofocus run) as a single named step. No-op unless
   *  recording is active, so callers can invoke it unconditionally after the action succeeds. */
  recordAction(action: string, actionParams: Record<string, unknown> = {}, label = action): void {
    if (!this.recording) return
    this.steps = [...this.steps, { kind: 'action', action, actionParams, t: performance.now() - this.startedAt, label }]
  }

  stop(): void {
    if (!this.recording) return
    this.recording = false
    device.client.onCall(null)
  }

  async save(name: string): Promise<Macro | null> {
    if (!this.steps.length) return null
    const macro: Macro = {
      id: newMacroId(), name: name.trim() || `Macro ${new Date().toLocaleString()}`,
      createdAt: new Date().toISOString(), steps: normalizeSteps(this.steps),
    }
    await putMacro(macro)
    this.steps = []
    await this.loadSaved()
    return macro
  }

  async remove(id: string): Promise<void> {
    await deleteMacro(id)
    await this.loadSaved()
  }

  export(macro: Macro): void {
    const blob = new Blob([JSON.stringify(macro, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = `${macro.name.replace(/[^\w.-]+/g, '_')}.json`; a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  }

  async import(file: File): Promise<Macro> {
    const parsed = JSON.parse(await file.text())
    const macro: Macro = {
      id: newMacroId(), name: parsed.name || file.name.replace(/\.json$/i, ''),
      createdAt: new Date().toISOString(), steps: normalizeSteps(Array.isArray(parsed.steps) ? parsed.steps : []),
    }
    await putMacro(macro)
    await this.loadSaved()
    return macro
  }

  async replay(macro: Macro, opts: ReplayOptions): Promise<void> {
    if (this.replaying || this.recording) return
    const steps = expandForReplay(macro.steps, opts.repeat, opts.loopWaitMs)
    const delays = stepDelays(steps, opts.speed)
    this.replaySteps = steps
    this.replaying = true; this.paused = false; this.stopFlag = false; this.pauseFlag = false
    this.status = `replaying "${macro.name}"…`
    try {
      for (let i = 0; i < steps.length; i++) {
        if (this.stopFlag) break
        if (delays[i]) await sleep(delays[i])
        while (this.pauseFlag && !this.stopFlag) { this.paused = true; await sleep(150) }
        this.paused = false
        if (this.stopFlag) break
        this.progress = i
        const s = steps[i]
        this.status = `step ${i + 1}/${steps.length}: ${s.label}`
        try {
          if (s.kind === 'wait') await sleep(s.waitMs ?? 0)
          else if (s.kind === 'call' && s.method) await device.client.call(s.method, s.params)
          else if (s.kind === 'action') await this.runAction(s)
        } catch (e) {
          this.status = `step ${i + 1} (${s.label}) failed: ${(e as Error).message}`
        }
      }
    } finally {
      this.replaying = false; this.paused = false; this.progress = -1
      if (!this.stopFlag) this.status = `replay of "${macro.name}" finished`
      this.stopFlag = false
    }
  }

  pause(): void { this.pauseFlag = true }
  resume(): void { this.pauseFlag = false }
  stopReplay(): void { this.stopFlag = true; this.pauseFlag = false }

  private async runAction(s: MacroStep): Promise<void> {
    if (s.action === 'photo') {
      await takePhoto({ mode: ((s.actionParams?.mode as PhotoMode) ?? 'single'), ...s.actionParams })
    } else if (s.action === 'autofocus') {
      await runAutofocus({
        mode: (s.actionParams?.mode as 'fast' | 'looping' | 'step') ?? 'fast',
        dz: (s.actionParams?.dz as number) ?? 1000,
        metric: 'jpeg',
      })
    }
  }
}

export const macroService = new MacroService()
