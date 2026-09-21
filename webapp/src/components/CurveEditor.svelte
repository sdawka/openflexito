<script lang="ts">
  /** Draggable tone-curve editor: channel tabs Master / R / G / B, each a canvas with control points
   *  connected by a `monotoneCubic` spline. Pure editing logic lives in `algo/curvePoints.ts`; this
   *  component only turns pointer/keyboard events into calls into that module and redraws the canvas.
   *  Value is a `CurveChannels`, changed via the `onChange` callback prop - no two-way binding, so there
   *  is never a `$state` this component both reads and writes inside the same `$effect`. */
  import {
    identityCurve, identityCurveChannels, insertPoint, movePoint, nearestPoint, removePoint,
    type CurveChannels, type CurvePoint,
  } from '../lib/algo/curvePoints'
  import { monotoneCubic } from '../lib/algo/curves'

  interface Props {
    value?: CurveChannels
    onChange: (ch: CurveChannels) => void
  }
  let { value = identityCurveChannels(), onChange }: Props = $props()

  type Channel = 'master' | 'r' | 'g' | 'b'
  const TABS: Array<{ key: Channel; label: string; colour: string }> = [
    { key: 'master', label: 'Master', colour: '#ddd' },
    { key: 'r', label: 'R', colour: '#e5484d' },
    { key: 'g', label: 'G', colour: '#30a46c' },
    { key: 'b', label: 'B', colour: '#3b82f6' },
  ]

  let tab = $state<Channel>('master')
  let selected = $state<number | null>(null)
  let dragging = $state(false)
  let canvasEl: HTMLCanvasElement | undefined
  const SIZE = 220

  function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v }
  function activePoints(): CurvePoint[] { return value[tab] }
  function activeColour(): string { return TABS.find((t) => t.key === tab)!.colour }

  function setPoints(pts: CurvePoint[]): void {
    onChange({ ...value, [tab]: pts })
  }

  function draw(): void {
    if (!canvasEl) return
    const ctx = canvasEl.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = SIZE, h = SIZE
    if (canvasEl.width !== Math.round(w * dpr)) { canvasEl.width = Math.round(w * dpr); canvasEl.height = Math.round(h * dpr) }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(127,127,127,0.05)'
    ctx.fillRect(0, 0, w, h)

    ctx.strokeStyle = 'rgba(127,127,127,0.22)'
    ctx.lineWidth = 1
    for (let i = 1; i < 4; i++) {
      const p = Math.round((w * i) / 4) + 0.5
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, h); ctx.stroke()
      const q = Math.round((h * i) / 4) + 0.5
      ctx.beginPath(); ctx.moveTo(0, q); ctx.lineTo(w, q); ctx.stroke()
    }
    ctx.strokeStyle = 'rgba(127,127,127,0.4)'
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1)

    const pts = activePoints()
    const fn = monotoneCubic(pts)
    const colour = activeColour()
    ctx.strokeStyle = colour
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let i = 0; i <= w; i++) {
      const x = i / w
      const y = clamp01(fn(x))
      const px = i, py = h - y * h
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
    }
    ctx.stroke()

    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i]
      const px = x * w, py = h - y * h
      ctx.beginPath()
      ctx.arc(px, py, i === selected ? 5.5 : 4, 0, Math.PI * 2)
      ctx.fillStyle = i === selected ? colour : '#fff'
      ctx.fill()
      ctx.strokeStyle = colour
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }

  function toNorm(clientX: number, clientY: number): { x: number; y: number } {
    const rect = canvasEl!.getBoundingClientRect()
    return { x: clamp01((clientX - rect.left) / rect.width), y: clamp01(1 - (clientY - rect.top) / rect.height) }
  }

  function onPointerDown(e: PointerEvent): void {
    if (!canvasEl) return
    canvasEl.focus()
    canvasEl.setPointerCapture(e.pointerId)
    const { x, y } = toNorm(e.clientX, e.clientY)
    const pts = activePoints()
    const hit = nearestPoint(pts, x, y, 0.05)
    if (hit >= 0) {
      selected = hit
      dragging = true
    } else {
      const next = insertPoint(pts, x, y)
      let newIdx = 0, best = Infinity
      for (let i = 0; i < next.length; i++) {
        const d = Math.abs(next[i][0] - x) + Math.abs(next[i][1] - y)
        if (d < best) { best = d; newIdx = i }
      }
      setPoints(next)
      selected = newIdx
      dragging = true
    }
    draw()
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragging || selected === null || !canvasEl) return
    const { x, y } = toNorm(e.clientX, e.clientY)
    setPoints(movePoint(activePoints(), selected, x, y))
  }

  function onPointerUp(e: PointerEvent): void {
    dragging = false
    if (canvasEl) { try { canvasEl.releasePointerCapture(e.pointerId) } catch { /* already released */ } }
  }

  function onDblClick(e: MouseEvent): void {
    if (!canvasEl) return
    const { x, y } = toNorm(e.clientX, e.clientY)
    const hit = nearestPoint(activePoints(), x, y, 0.08)
    if (hit >= 0) { setPoints(removePoint(activePoints(), hit)); selected = null }
  }

  function onKeydown(e: KeyboardEvent): void {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected !== null) {
      e.preventDefault()
      setPoints(removePoint(activePoints(), selected))
      selected = null
    }
  }

  function selectTab(k: Channel): void { tab = k; selected = null }
  function resetChannel(): void { setPoints(identityCurve()) }
  function resetAll(): void { selected = null; onChange(identityCurveChannels()) }

  $effect(() => { void value; void tab; void selected; draw() })
</script>

<div class="curve-editor-wrap">
  <div class="tabs" role="tablist">
    {#each TABS as t (t.key)}
      <button type="button" class:active={tab === t.key} style={tab === t.key ? `--tab-colour:${t.colour}` : ''} onclick={() => selectTab(t.key)}>{t.label}</button>
    {/each}
  </div>
  <canvas
    bind:this={canvasEl}
    class="curve-editor"
    style="width:{SIZE}px;height:{SIZE}px"
    tabindex="0"
    aria-label={`${TABS.find((t) => t.key === tab)!.label} tone curve editor`}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    ondblclick={onDblClick}
    onkeydown={onKeydown}
  ></canvas>
  <div class="row">
    <button type="button" onclick={resetChannel}>Reset {TABS.find((t) => t.key === tab)!.label.toLowerCase()}</button>
    <button type="button" onclick={resetAll}>Reset all curves</button>
  </div>
  <div class="hint">click to add a point, drag to move, double-click or Delete to remove</div>
</div>

<style>
  .curve-editor-wrap { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
  .tabs { display: flex; gap: 4px; }
  .tabs button { padding: 2px 8px; font-size: 11px; border: 1px solid var(--border); border-radius: 4px; background: transparent; cursor: pointer; }
  .tabs button.active { border-color: var(--tab-colour, var(--accent)); color: var(--tab-colour, var(--accent)); font-weight: 600; }
  .curve-editor { border: 1px solid var(--border); border-radius: 6px; touch-action: none; cursor: crosshair; }
  .row { display: flex; gap: 6px; }
  .row button { font-size: 11px; padding: 3px 8px; }
  .hint { font-size: 10px; color: var(--muted); max-width: 220px; }

  @media (pointer: coarse) {
    .curve-editor { touch-action: none; }
    .tabs button, .row button { min-height: 28px; }
  }
</style>
