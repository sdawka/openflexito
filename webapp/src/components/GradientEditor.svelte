<script lang="ts">
  /** 1D colour-map gradient editor: a horizontal bar of colour stops. Pure editing logic lives in
   *  `algo/gradientStops.ts`; this component turns pointer events and the native colour picker into
   *  calls into that module. Value is a `Stop[]`, changed via the `onChange` callback prop. */
  import { evenlySpace, insertStop, moveStop, removeStop, reverseStops, setStopColor, type Stop } from '../lib/algo/gradientStops'

  interface Props {
    value: Stop[]
    onChange: (stops: Stop[]) => void
  }
  let { value, onChange }: Props = $props()

  let barEl: HTMLDivElement | undefined
  let dragIndex = $state<number | null>(null)

  function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v }

  function toHex([r, g, b]: [number, number, number]): string {
    const h = (v: number): string => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')
    return `#${h(r)}${h(g)}${h(b)}`
  }
  function fromHex(hex: string): [number, number, number] {
    const n = parseInt(hex.slice(1), 16)
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
  }

  function gradientCss(): string {
    if (value.length === 0) return 'transparent'
    const sorted = [...value].sort((a, b) => a.pos - b.pos)
    return `linear-gradient(to right, ${sorted.map((s) => `${toHex(s.color)} ${(s.pos * 100).toFixed(2)}%`).join(', ')})`
  }

  function posFromClientX(clientX: number): number {
    const rect = barEl!.getBoundingClientRect()
    return clamp01((clientX - rect.left) / rect.width)
  }

  function onBarClick(e: MouseEvent): void {
    if ((e.target as HTMLElement).closest('.stop')) return
    onChange(insertStop(value, posFromClientX(e.clientX)))
  }

  function onStopPointerDown(i: number, e: PointerEvent): void {
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragIndex = i
  }
  function onStopPointerMove(e: PointerEvent): void {
    if (dragIndex === null || !barEl) return
    onChange(moveStop(value, dragIndex, posFromClientX(e.clientX)))
  }
  function onStopPointerUp(e: PointerEvent): void {
    dragIndex = null
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* already released */ }
  }

  function onColorInput(i: number, e: Event): void {
    onChange(setStopColor(value, i, fromHex((e.currentTarget as HTMLInputElement).value)))
  }

  function onRemove(i: number, e: MouseEvent): void {
    e.stopPropagation()
    onChange(removeStop(value, i))
  }
</script>

<div class="gradient-editor">
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="bar" bind:this={barEl} style="background:{gradientCss()}" onclick={onBarClick}>
    {#each value as s, i (i)}
      <div
        class="stop"
        style="left:{s.pos * 100}%"
        onpointerdown={(e) => onStopPointerDown(i, e)}
        onpointermove={onStopPointerMove}
        onpointerup={onStopPointerUp}
        onpointercancel={onStopPointerUp}
        role="slider"
        aria-label={`gradient stop ${i + 1}`}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={s.pos}
        tabindex="0"
      >
        <input type="color" value={toHex(s.color)} oninput={(e) => onColorInput(i, e)} onclick={(e) => e.stopPropagation()} aria-label={`stop ${i + 1} colour`} />
        {#if value.length > 2}
          <button type="button" class="rm" onclick={(e) => onRemove(i, e)} title="remove stop">✕</button>
        {/if}
      </div>
    {/each}
  </div>
  <div class="row">
    <button type="button" onclick={() => onChange(reverseStops(value))}>Reverse</button>
    <button type="button" onclick={() => onChange(evenlySpace(value))}>Evenly space</button>
  </div>
  <div class="hint">click the bar to add a stop, drag to move, the swatch picks the colour</div>
</div>

<style>
  .gradient-editor { display: flex; flex-direction: column; gap: 6px; }
  .bar { position: relative; height: 28px; border: 1px solid var(--border); border-radius: 6px; cursor: copy; }
  .stop { position: absolute; top: -6px; width: 18px; height: 40px; transform: translateX(-9px); display: flex; flex-direction: column; align-items: center; gap: 2px; cursor: grab; touch-action: none; }
  .stop input[type=color] { width: 18px; height: 18px; padding: 0; border: 2px solid #fff; border-radius: 3px; box-shadow: 0 0 0 1px var(--border); cursor: pointer; background: none; }
  .stop .rm { font-size: 9px; line-height: 1; padding: 0 2px; border: none; background: transparent; color: var(--muted); cursor: pointer; }
  .stop .rm:hover { color: var(--err, #e5484d); }
  .row { display: flex; gap: 6px; }
  .row button { font-size: 11px; padding: 3px 8px; }
  .hint { font-size: 10px; color: var(--muted); }

  @media (pointer: coarse) {
    .stop { width: 24px; transform: translateX(-12px); }
    .stop input[type=color] { width: 24px; height: 24px; }
    .row button { min-height: 28px; }
  }
</style>
