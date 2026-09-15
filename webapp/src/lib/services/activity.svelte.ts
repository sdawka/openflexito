/** Declares this browser tab's liveness to the device's auto-standby idle timer (brief: "auto standby
 *  after N minutes idle"). The device bumps its own idle timer on mutating RPCs and still/raw/bracket
 *  fetches; that alone under-counts a tab that is only watching the live view or running work that
 *  produces no RPC traffic for minutes at a time (recording, live focus stack, tracking, the gaps
 *  between time-lapse frames) — this service is what tells the device "someone/something is still
 *  here" via the `power.activity(active, reason)` heartbeat RPC.
 *
 *  A tab is active while it is visible (`document.visibilityState`), or while it holds at least one
 *  `hold()` (see the recorder/liveStack/tracking/timelapse services), regardless of visibility —
 *  that's what keeps a phone with a locked screen recording. A hidden tab with no hold declares
 *  inactive immediately on `visibilitychange`, rather than waiting for the 60s heartbeat to lapse
 *  (the device only treats a declaration as stale after 2.5x that, i.e. 150s, so a slow decline would
 *  keep a device with nobody watching awake for an extra couple of minutes each time a tab is hidden).
 *
 *  The standby screen (App.svelte) must not itself count as "watching" once the device is already
 *  off — declaring active while it's asleep would be meaningless at best; `isStandby` (default: the
 *  device's own reported power state) suppresses that.
 *
 *  All browser/device dependencies are injectable (`ActivityDeps`) so this is unit-testable without a
 *  real DOM or device: the default `new ActivityService()` (the `activity` export below) is the only
 *  thing that touches `document`/`device`, and only once `start()` actually runs. */

import { device } from '../store/device.svelte'

const HEARTBEAT_MS = 60_000

export interface ActivityReply { on: boolean; since: number; idle_in: number }

export interface ActivityDeps {
  call?: (method: string, params?: Record<string, unknown>) => Promise<ActivityReply>
  /** True while the standby screen is up for an already-sleeping device — see the file doc above. */
  isStandby?: () => boolean
  /** Subscribe to the RPC connection (re)opening; the device forgets a closed socket's declaration. */
  subscribeOpen?: (fn: () => void) => () => void
  getVisibility?: () => boolean
  subscribeVisibility?: (fn: () => void) => () => void
}

export class ActivityService {
  private holds = new Set<symbol>()
  private visible = $state(true)
  /** Seconds until auto standby, from the most recent power.activity reply; -1 until we have one. */
  idleIn = $state(-1)

  private started = false
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private unsubscribeOpen: (() => void) | null = null
  private unsubscribeVisibility: (() => void) | null = null

  private call: (method: string, params?: Record<string, unknown>) => Promise<ActivityReply>
  private isStandby: () => boolean
  private subscribeOpen: (fn: () => void) => () => void
  private getVisibility: () => boolean
  private subscribeVisibility: (fn: () => void) => () => void

  constructor(deps: ActivityDeps = {}) {
    this.call = deps.call ?? ((m, p) => device.client.call<ActivityReply>(m, p))
    this.isStandby = deps.isStandby ?? (() => device.status?.power != null && device.status.power.on === false)
    this.subscribeOpen = deps.subscribeOpen ?? ((fn) => device.client.on('$open', fn))
    this.getVisibility = deps.getVisibility ?? (() => document.visibilityState === 'visible')
    this.subscribeVisibility = deps.subscribeVisibility ?? ((fn) => {
      document.addEventListener('visibilitychange', fn)
      return () => document.removeEventListener('visibilitychange', fn)
    })
  }

  /** What this tab currently wants to declare — visible or held, and not while the standby screen
   *  is showing an already-sleeping device. */
  get active(): boolean {
    return !this.isStandby() && (this.holds.size > 0 || this.visible)
  }

  /** Declare long-running work in flight; call the returned release when it finishes. Reference-
   *  counted (two concurrent holds don't cancel each other when the first releases) and idempotent
   *  (calling the same release twice, e.g. once explicitly and once in a `finally`, is a no-op). */
  hold(reason: string): () => void {
    const token = Symbol(reason)
    this.holds.add(token)
    void this.declare(`hold:${reason}`)
    let released = false
    return () => {
      if (released) return
      released = true
      this.holds.delete(token)
      void this.declare(`release:${reason}`)
    }
  }

  /** Wire visibilitychange + the heartbeat. Call once (App.svelte, onMount); safe to call again. */
  start(): void {
    if (this.started) return
    this.started = true
    this.visible = this.getVisibility()
    this.unsubscribeVisibility = this.subscribeVisibility(() => {
      this.visible = this.getVisibility()
      void this.declare('visibility')
    })
    this.unsubscribeOpen = this.subscribeOpen(() => void this.declare('reconnect'))
    this.heartbeatTimer = setInterval(() => void this.declare('heartbeat'), HEARTBEAT_MS)
    void this.declare('start')
  }

  /** Undo start(); mainly for tests (production never tears this down for the life of the tab). */
  stop(): void {
    if (!this.started) return
    this.started = false
    this.unsubscribeVisibility?.()
    this.unsubscribeVisibility = null
    this.unsubscribeOpen?.()
    this.unsubscribeOpen = null
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private async declare(reason: string): Promise<void> {
    try {
      const r = await this.call('power.activity', { active: this.active, reason })
      this.idleIn = r.idle_in
      device.applyPower(r)   // freshest idle_in for anything reading device.idleIn (e.g. PowerButton)
    } catch {
      // Offline, or the device is already asleep: the next heartbeat, hold(), or visibility change
      // retries. Nothing to surface here — device.error is for user-initiated actions, not this.
    }
  }
}

export const activity = new ActivityService()
