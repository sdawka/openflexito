import type { Vec3 } from '../api/types'
import type { JogController } from './jog'

export interface GamepadActions { snapshot?: () => void; autofocus?: () => void; stop?: () => void }

const DEADZONE = 0.15
const curve = (v: number) => (Math.abs(v) < DEADZONE ? 0 : Math.sign(v) * (Math.abs(v) - DEADZONE) / (1 - DEADZONE))

/** Standard-mapping gamepad: left stick = XY, right stick Y / triggers = Z, A = snapshot,
 *  X = autofocus, B = stop. Polls at ~30 Hz; returns a cleanup function. */
export function attachGamepad(jog: JogController, actions: GamepadActions, enabled: () => boolean): () => void {
  let state: Vec3 = { x: 0, y: 0, z: 0 }
  let active = false
  const prevButtons: boolean[] = []
  const source = (): Vec3 => state

  const poll = () => {
    if (!enabled()) { if (active) { active = false; jog.setSource('gamepad', null) } return }
    const gp = navigator.getGamepads?.().find((g) => g && g.connected)
    if (!gp) { if (active) { active = false; jog.setSource('gamepad', null) } return }
    const lx = curve(gp.axes[0] ?? 0), ly = -curve(gp.axes[1] ?? 0), ry = -curve(gp.axes[3] ?? 0)
    const trig = (gp.buttons[7]?.value ?? 0) - (gp.buttons[6]?.value ?? 0)
    state = { x: lx, y: ly, z: Math.max(-1, Math.min(1, ry + trig)) }
    const any = state.x || state.y || state.z
    if (any && !active) { active = true; jog.setSource('gamepad', source) }
    else if (!any && active) { active = false; jog.setSource('gamepad', null) }
    else if (any) jog.kick()
    gp.buttons.forEach((b, i) => {
      const pressed = b.pressed
      if (pressed && !prevButtons[i]) {
        if (i === 0) actions.snapshot?.()
        if (i === 2) actions.autofocus?.()
        if (i === 1) actions.stop?.()
      }
      prevButtons[i] = pressed
    })
  }
  const timer = setInterval(poll, 33)
  return () => { clearInterval(timer); jog.setSource('gamepad', null) }
}
