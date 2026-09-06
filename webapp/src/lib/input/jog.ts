/** Turns a desired jog direction (from keys or a gamepad) into a stream of stage.jog calls.
 *  One request is in flight at a time; the device's jog is newest-wins, so holding a key gives
 *  continuous motion without a backlog. */

import type { Vec3 } from '../api/types'

export type JogSource = () => Vec3   // returns -1..1 per axis (0 = no motion)

export class JogController {
  private sources = new Map<string, JogSource>()
  private running = false
  private stopped = false

  constructor(
    private jog: (d: Partial<Vec3>) => Promise<unknown>,
    private stop: () => Promise<unknown>,
    private stepFor: () => { xy: number; z: number },
  ) {}

  setSource(name: string, src: JogSource | null): void {
    if (src) this.sources.set(name, src)
    else this.sources.delete(name)
    this.kick()
  }

  private combined(): Vec3 {
    const v: Vec3 = { x: 0, y: 0, z: 0 }
    for (const s of this.sources.values()) {
      const d = s()
      v.x += d.x; v.y += d.y; v.z += d.z
    }
    for (const a of ['x', 'y', 'z'] as const) v[a] = Math.max(-1, Math.min(1, v[a]))
    return v
  }

  /** Call whenever an input changes; starts the loop if idle. */
  kick(): void {
    if (this.running) return
    void this.loop()
  }

  private async loop(): Promise<void> {
    this.running = true
    let wasMoving = false
    try {
      while (!this.stopped) {
        const v = this.combined()
        const { xy, z } = this.stepFor()
        const d = { x: Math.round(v.x * xy), y: Math.round(v.y * xy), z: Math.round(v.z * z) }
        if (!d.x && !d.y && !d.z) {
          if (wasMoving) await this.stop().catch(() => {})
          break
        }
        wasMoving = true
        await this.jog(d).catch(() => new Promise((r) => setTimeout(r, 200)))
      }
    } finally {
      this.running = false
    }
  }

  dispose(): void {
    this.stopped = true
  }
}
