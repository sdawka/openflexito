import type { Vec3 } from '../api/types'
import type { JogController } from './jog'

const MAP: Record<string, Partial<Vec3>> = {
  ArrowLeft: { x: -1 }, ArrowRight: { x: 1 }, ArrowUp: { y: 1 }, ArrowDown: { y: -1 },
  a: { x: -1 }, d: { x: 1 }, w: { y: 1 }, s: { y: -1 },
  PageUp: { z: 1 }, PageDown: { z: -1 }, q: { z: 1 }, e: { z: -1 }, r: { z: 1 }, f: { z: -1 },
}

/** Attaches WASD/arrow/PgUp/PgDn handling; returns a cleanup function. */
export function attachKeyboard(jog: JogController, opts: { invertY: () => boolean; enabled: () => boolean }): () => void {
  const held = new Set<string>()
  const source = (): Vec3 => {
    const v: Vec3 = { x: 0, y: 0, z: 0 }
    for (const k of held) {
      const d = MAP[k]
      if (!d) continue
      v.x += d.x ?? 0; v.y += d.y ?? 0; v.z += d.z ?? 0
    }
    if (opts.invertY()) v.y = -v.y
    return v
  }
  const isEditable = (t: EventTarget | null) =>
    t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)

  const down = (e: KeyboardEvent) => {
    if (!opts.enabled() || isEditable(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
    if (!(k in MAP)) return
    e.preventDefault()
    if (held.has(k)) return
    held.add(k)
    jog.setSource('keyboard', source)
  }
  const up = (e: KeyboardEvent) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
    if (held.delete(k)) jog.setSource('keyboard', held.size ? source : null)
  }
  const blur = () => { held.clear(); jog.setSource('keyboard', null) }
  window.addEventListener('keydown', down)
  window.addEventListener('keyup', up)
  window.addEventListener('blur', blur)
  return () => {
    window.removeEventListener('keydown', down)
    window.removeEventListener('keyup', up)
    window.removeEventListener('blur', blur)
  }
}
