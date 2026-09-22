<script lang="ts">
  /** HUD overlay for the Live stream: jog D-pad + Z + autofocus (bottom-right), position/fps readout
   *  (bottom-left), immersive toggle + XY step chip (top-right). Absolutely positioned inside `.stream`
   *  with `pointer-events: none` on the container so drags/clicks on the image pass through; only the
   *  buttons themselves are interactive. Fades to low opacity after 2.5 s without pointer movement over
   *  the stream, full opacity on hover/focus. Reuses the same `JogController` the keyboard drives, so a
   *  press-and-hold here behaves exactly like holding a jog key. */
  import { onMount } from 'svelte'
  import { device } from '../lib/store/device.svelte'
  import { settings, saveSettings } from '../lib/store/settings.svelte'
  import { ui } from '../lib/store/ui.svelte'
  import { focusCtl } from '../lib/store/focusCtl.svelte'
  import type { JogController } from '../lib/input/jog'

  let { jog }: { jog: JogController } = $props()

  const XY_STEPS = [50, 200, 500, 2000, 5000]

  let root: HTMLElement
  let faded = $state(false)
  let fadeTimer: ReturnType<typeof setTimeout> | null = null

  function resetFade() {
    faded = false
    if (fadeTimer) clearTimeout(fadeTimer)
    fadeTimer = setTimeout(() => (faded = true), 2500)
  }

  // ---- jog buttons: a press shorter than HOLD_MS is a tap and does one raw step (like StagePad); a
  // press held longer starts continuous motion through the shared JogController and the release
  // only stops it. The jog must not start on pointerdown: a tap would then move by the jog *and*
  // the step. pointercancel/pointerleave stop any motion without adding a step, so a hold that
  // drifts off the button doesn't fire a step on top of whatever motion already happened. ----
  const HOLD_MS = 250
  type Dir = { x?: number; y?: number; z?: number }
  const holdTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const holding = new Set<string>()
  function holdSource(d: Dir) {
    return () => ({ x: d.x ?? 0, y: d.y ?? 0, z: d.z ?? 0 })
  }
  function onDirDown(name: string, d: Dir) {
    resetFade()
    clearTimeout(holdTimers.get(name))
    holdTimers.set(name, setTimeout(() => { holding.add(name); jog.setSource(name, holdSource(d)) }, HOLD_MS))
  }
  function onDirUp(name: string, d: Dir) {
    clearTimeout(holdTimers.get(name)); holdTimers.delete(name)
    if (holding.delete(name)) { jog.setSource(name, null); return }
    const step = { x: (d.x ?? 0) * settings.stepXY, y: (d.y ?? 0) * settings.stepXY, z: (d.z ?? 0) * settings.stepZ }
    device.moveRel(step, false).catch(() => {})
  }
  function onDirCancel(name: string) {
    clearTimeout(holdTimers.get(name)); holdTimers.delete(name)
    if (holding.delete(name)) jog.setSource(name, null)
  }

  function cycleStep() {
    resetFade()
    const i = XY_STEPS.indexOf(settings.stepXY)
    settings.stepXY = XY_STEPS[(i + 1 + XY_STEPS.length) % XY_STEPS.length] ?? XY_STEPS[0]
    saveSettings()
  }

  function onKey(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (document.querySelector('.overlay')) return   // a Viewer or similar overlay owns Esc/F while open
    if (e.key === 'f' || e.key === 'F') ui.toggleImmersive()
    else if (e.key === 'Escape' && ui.immersive) ui.toggleImmersive()
  }

  onMount(() => {
    resetFade()
    const parent = root.parentElement
    const onMove = (e: PointerEvent) => {
      if (parent && (e.target === parent || parent.contains(e.target as Node))) resetFade()
    }
    parent?.addEventListener('pointermove', onMove)
    window.addEventListener('keydown', onKey)
    return () => {
      parent?.removeEventListener('pointermove', onMove)
      window.removeEventListener('keydown', onKey)
      if (fadeTimer) clearTimeout(fadeTimer)
      for (const t of holdTimers.values()) clearTimeout(t)
      for (const n of holding) jog.setSource(n, null)
    }
  })

  const pos = $derived(device.position)
</script>

<div class="hud" class:faded bind:this={root}>
  <div class="corner bottom-left mono">
    <div>x {pos.x} y {pos.y} z {pos.z}</div>
    <div>{device.fps.toFixed(0)} fps{#if device.moving} · moving{/if}</div>
  </div>

  <div class="corner top-right">
    <button class="chip" onclick={cycleStep} title="cycle XY step size">{settings.stepXY}</button>
    <button class="icon" aria-pressed={ui.immersive} onclick={() => ui.toggleImmersive()} title="immersive (F)">⛶</button>
  </div>

  <div class="corner bottom-right">
    <div class="pad">
      <span></span>
      <button onpointerdown={() => onDirDown('hud-y', { y: 1 })} onpointerup={() => onDirUp('hud-y', { y: 1 })} onpointercancel={() => onDirCancel('hud-y')} onpointerleave={() => onDirCancel('hud-y')} title="W / ↑">▲</button>
      <span></span>
      <button onpointerdown={() => onDirDown('hud-x', { x: -1 })} onpointerup={() => onDirUp('hud-x', { x: -1 })} onpointercancel={() => onDirCancel('hud-x')} onpointerleave={() => onDirCancel('hud-x')} title="A / ←">◀</button>
      <button class="danger" onclick={() => device.stop()} title="stop">■</button>
      <button onpointerdown={() => onDirDown('hud-x', { x: 1 })} onpointerup={() => onDirUp('hud-x', { x: 1 })} onpointercancel={() => onDirCancel('hud-x')} onpointerleave={() => onDirCancel('hud-x')} title="D / →">▶</button>
      <span></span>
      <button onpointerdown={() => onDirDown('hud-y', { y: -1 })} onpointerup={() => onDirUp('hud-y', { y: -1 })} onpointercancel={() => onDirCancel('hud-y')} onpointerleave={() => onDirCancel('hud-y')} title="S / ↓">▼</button>
      <span></span>
    </div>
    <div class="zcol">
      <button onpointerdown={() => onDirDown('hud-z', { z: 1 })} onpointerup={() => onDirUp('hud-z', { z: 1 })} onpointercancel={() => onDirCancel('hud-z')} onpointerleave={() => onDirCancel('hud-z')} title="PgUp / Q">Z+</button>
      <button onpointerdown={() => onDirDown('hud-z', { z: -1 })} onpointerup={() => onDirUp('hud-z', { z: -1 })} onpointercancel={() => onDirCancel('hud-z')} onpointerleave={() => onDirCancel('hud-z')} title="PgDn / E">Z−</button>
    </div>
    <button class="af" class:busy={focusCtl.focusing} onclick={() => focusCtl.run()} title="autofocus">
      {#if focusCtl.focusing}<span class="spinner"></span>{:else}AF{/if}
    </button>
  </div>
</div>

<style>
  .hud { position: absolute; inset: 0; pointer-events: none; transition: opacity .3s; }
  .hud.faded { opacity: .35; }
  .hud:hover, .hud:focus-within { opacity: 1; }
  .corner { position: absolute; display: flex; gap: 8px; align-items: center; pointer-events: none; }
  .corner button { pointer-events: auto; }
  .bottom-left { bottom: 12px; left: 12px; flex-direction: column; align-items: flex-start; gap: 2px;
    background: rgba(0,0,0,.5); padding: 6px 10px; border-radius: 6px; font-size: 12px; }
  .top-right { top: 12px; right: 12px; }
  .bottom-right { bottom: 12px; right: 12px; align-items: flex-end; }

  .chip { min-width: 44px; height: 36px; padding: 0 10px; border-radius: 6px; background: rgba(0,0,0,.5);
    color: inherit; border: 1px solid var(--border); font-size: 12px; }
  .icon { width: 36px; height: 36px; border-radius: 6px; background: rgba(0,0,0,.5); border: 1px solid var(--border);
    color: inherit; font-size: 16px; padding: 0; }
  .icon[aria-pressed="true"] { background: var(--accent, #3a7); color: #fff; }

  .pad { display: grid; grid-template-columns: repeat(3, 36px); grid-auto-rows: 36px; gap: 4px; }
  .pad button, .zcol button, .af { background: rgba(0,0,0,.5); border: 1px solid var(--border); color: inherit;
    border-radius: 6px; padding: 0; font-size: 14px; touch-action: none; }
  .pad button.danger { color: var(--err, #f66); }
  .zcol { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
  .zcol button { width: 36px; height: 36px; }
  .af { width: 100%; height: 32px; margin-top: 6px; font-weight: 600; display: flex; align-items: center; justify-content: center; }
  .af.busy { color: var(--accent, #3a7); }
  .spinner { width: 12px; height: 12px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  @media (pointer: coarse) {
    .pad button, .zcol button, .icon, .chip { min-width: 44px; min-height: 44px; }
  }

  @media (max-width: 720px) {
    .pad, .zcol { display: none; }
    .bottom-right { flex-direction: column; }
    .af { width: 44px; height: 44px; }
  }
</style>
