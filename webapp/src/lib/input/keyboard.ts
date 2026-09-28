import type { Vec3 } from '../api/types'
import type { JogController } from './jog'

const MAP: Record<string, Partial<Vec3>> = {
  ArrowLeft: { x: -1 }, ArrowRight: { x: 1 }, ArrowUp: { y: 1 }, ArrowDown: { y: -1 },
  a: { x: -1 }, d: { x: 1 }, w: { y: 1 }, s: { y: -1 },
  PageUp: { z: 1 }, PageDown: { z: -1 }, q: { z: 1 }, e: { z: -1 }, r: { z: 1 }, f: { z: -1 },
}
/** With Shift held the vertical XY keys drive Z instead (focus without leaving the arrows). */
const SHIFT_Z: Record<string, number> = { ArrowUp: 1, ArrowDown: -1, w: 1, s: -1 }

/** Jog direction of the held keys; `invertY` flips Y only, never a Shift+arrow Z. */
export function keyVector(held: Iterable<string>, shift: boolean, invertY: boolean): Vec3 {
  const v: Vec3 = { x: 0, y: 0, z: 0 }
  for (const k of held) {
    if (shift && k in SHIFT_Z) { v.z += SHIFT_Z[k]; continue }
    const d = MAP[k]
    if (!d) continue
    v.x += d.x ?? 0; v.y += (d.y ?? 0) * (invertY ? -1 : 1); v.z += d.z ?? 0
  }
  return v
}

/** Attaches WASD/arrow/PgUp/PgDn (Shift+↑/↓ = Z) handling; returns a cleanup function. */
export function attachKeyboard(jog: JogController, opts: { invertY: () => boolean; enabled: () => boolean }): () => void {
  const held = new Set<string>()
  // Shift pressed or released mid-jog switches the arrows between Y and Z on the next tick
  let shift = false
  const source = (): Vec3 => keyVector(held, shift, opts.invertY())
  const isEditable = (t: EventTarget | null) =>
    t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)

  const down = (e: KeyboardEvent) => {
    shift = e.shiftKey
    if (!opts.enabled() || isEditable(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
    if (!(k in MAP)) return
    e.preventDefault()
    if (held.has(k)) return
    held.add(k)
    jog.setSource('keyboard', source)
  }
  const up = (e: KeyboardEvent) => {
    shift = e.shiftKey
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
    if (held.delete(k)) jog.setSource('keyboard', held.size ? source : null)
  }
  const blur = () => { held.clear(); shift = false; jog.setSource('keyboard', null) }
  window.addEventListener('keydown', down)
  window.addEventListener('keyup', up)
  window.addEventListener('blur', blur)
  return () => {
    window.removeEventListener('keydown', down)
    window.removeEventListener('keyup', up)
    window.removeEventListener('blur', blur)
  }
}
