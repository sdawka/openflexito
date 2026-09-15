<script lang="ts">
  import { device } from '../lib/store/device.svelte'
  import { settings, saveSettings } from '../lib/store/settings.svelte'

  const stepsXY = [50, 200, 500, 2000, 5000]
  const stepsZ = [10, 50, 100, 500, 2000]
  let goto = $state({ x: 0, y: 0, z: 0 })
  const move = (d: Partial<Record<'x' | 'y' | 'z', number>>) => device.moveRel(d).catch(() => {})
</script>

<div class="panel">
  <h3>Stage</h3>
  <div class="grid">
    <div class="pad">
      <span></span><button onclick={() => move({ y: settings.stepXY })} title="W / ↑">▲</button><span></span>
      <button onclick={() => move({ x: -settings.stepXY })} title="A / ←">◀</button>
      <button class="danger" onclick={() => device.stop()} title="stop">■</button>
      <button onclick={() => move({ x: settings.stepXY })} title="D / →">▶</button>
      <span></span><button onclick={() => move({ y: -settings.stepXY })} title="S / ↓">▼</button><span></span>
    </div>
    <div class="zcol">
      <button onclick={() => move({ z: settings.stepZ })} title="PgUp / Q">Z+</button>
      <button onclick={() => move({ z: -settings.stepZ })} title="PgDn / E">Z−</button>
    </div>
  </div>
  <div class="row" style="margin-top:10px">
    <div>
      <div class="label">XY step</div>
      <select bind:value={settings.stepXY} onchange={saveSettings}>
        {#each stepsXY as s}<option value={s}>{s}</option>{/each}
      </select>
    </div>
    <div>
      <div class="label">Z step</div>
      <select bind:value={settings.stepZ} onchange={saveSettings}>
        {#each stepsZ as s}<option value={s}>{s}</option>{/each}
      </select>
    </div>
  </div>
  <div class="row goto-row" style="margin-top:10px">
    <input class="mono" type="number" bind:value={goto.x} placeholder="x" title="x" />
    <input class="mono" type="number" bind:value={goto.y} placeholder="y" title="y" />
    <input class="mono" type="number" bind:value={goto.z} placeholder="z" title="z" />
    <button onclick={() => device.moveTo(goto).catch(() => {})} title="absolute move to x y z (steps)">Go to</button>
    <button onclick={() => (goto = { ...device.position })} title="copy the current position into the fields">Here</button>
  </div>
  <div class="row" style="margin-top:10px">
    <button onclick={() => device.zero()} title="set current position as origin">Zero</button>
    <button onclick={() => device.release()} title="de-energise coils">Release</button>
    <button onclick={() => device.restorePosition()} title="re-apply last saved position after a power cycle">Restore pos</button>
  </div>
</div>

<style>
  .grid { display: flex; gap: 12px; align-items: stretch; }
  .pad { display: grid; grid-template-columns: repeat(3, 40px); grid-auto-rows: 40px; gap: 4px; }
  .pad button, .zcol button { width: 40px; height: 40px; padding: 0; font-size: 14px; touch-action: manipulation; }
  .zcol { display: flex; flex-direction: column; gap: 4px; justify-content: center; }

  @media (max-width: 720px) {
    .grid { flex-direction: column; }
    .pad { grid-template-columns: repeat(3, 1fr); }
    .pad button, .zcol button { width: auto; height: auto; padding: 8px 4px; }
  }

  @media (pointer: coarse) {
    .pad button, .zcol button { min-width: 44px; min-height: 44px; }
  }

  .goto-row input { min-width: 64px; }
  @media (max-width: 720px) {
    .goto-row { flex-wrap: wrap; }
    .goto-row input { flex: 1; min-width: 64px; }
  }
</style>
