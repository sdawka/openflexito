<script lang="ts">
  import type { LensShading } from '../lib/algo/lst'
  import { LST_COLS, LST_ROWS } from '../lib/algo/lst'
  let { lst }: { lst: LensShading } = $props()

  function paint(canvas: HTMLCanvasElement, table: number[]) {
    const ctx = canvas.getContext('2d')!
    const min = Math.min(...table), max = Math.max(...table)
    const cw = canvas.width / LST_COLS, ch = canvas.height / LST_ROWS
    table.forEach((v, i) => {
      const f = max > min ? (v - min) / (max - min) : 0
      ctx.fillStyle = `hsl(${220 - 220 * f} 70% ${35 + 30 * f}%)`
      ctx.fillRect((i % LST_COLS) * cw, Math.floor(i / LST_COLS) * ch, cw, ch)
    })
  }
  function heat(node: HTMLCanvasElement, table: number[]) {
    paint(node, table)
    return { update(t: number[]) { paint(node, t) } }
  }
</script>

<div class="row lst-row" style="margin-top:10px">
  {#each [['luminance', lst.luminance], ['Cr (G/R)', lst.cr], ['Cb (G/B)', lst.cb]] as [name, table]}
    <div class="lst-item">
      <div class="label">{name} <span class="mono">{Math.min(...(table as number[])).toFixed(2)}–{Math.max(...(table as number[])).toFixed(2)}</span></div>
      <canvas width="160" height="120" use:heat={table as number[]} class="lst-canvas"></canvas>
    </div>
  {/each}
</div>

<style>
  .lst-row { gap: 8px; }
  .lst-item { flex: 1; min-width: 120px; }
  .lst-canvas { width: 100%; height: auto; }

  @media (max-width: 720px) {
    .lst-item { flex: 1 1 calc(50% - 4px); }
  }
</style>
