<script lang="ts">
  /** Macro recording and replay: hooks the RPC client to capture stage/light/camera calls (see
   *  `services/macro.svelte.ts`) plus high-level actions recorded explicitly by PhotoPanel/Live.
   *  Collapsed by default. */
  import { onMount } from 'svelte'
  import { macroService } from '../lib/services/macro.svelte'
  import type { Macro } from '../lib/algo/macro'

  let name = $state('')
  let speed = $state<'recorded' | 'fast'>('recorded')
  let repeat = $state(1)
  let loopWaitMs = $state(0)
  let fileInput: HTMLInputElement | undefined = $state()

  onMount(() => { macroService.loadSaved() })

  async function saveRecording() {
    await macroService.save(name)
    name = ''
  }
  async function onImportFile(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0]
    if (f) await macroService.import(f).catch((err) => (macroService.status = `import failed: ${(err as Error).message}`))
    if (fileInput) fileInput.value = ''
  }
  function replay(m: Macro) {
    macroService.replay(m, { speed, repeat, loopWaitMs })
  }
</script>

<details class="panel">
  <summary><h3 style="display:inline-block">Macro{macroService.recording ? ` · recording (${macroService.steps.length})` : ''}</h3></summary>

  <div class="row" style="margin-top:8px">
    {#if !macroService.recording}
      <button class="primary" onclick={() => macroService.start()} disabled={macroService.replaying}>Record</button>
    {:else}
      <button class="danger" onclick={() => macroService.stop()}>Stop</button>
    {/if}
    <input style="flex:1" placeholder="macro name" bind:value={name} disabled={macroService.recording || !macroService.steps.length} />
    <button onclick={saveRecording} disabled={macroService.recording || !macroService.steps.length}>Save</button>
  </div>
  {#if macroService.recording}
    <div class="muted small" style="margin-top:4px">recording stage, light and camera calls, plus photo/autofocus actions taken from this panel's siblings…</div>
  {:else if macroService.steps.length}
    <div class="muted small" style="margin-top:4px">{macroService.steps.length} step(s) recorded, not yet saved</div>
  {/if}

  <h4 class="sub">Replay</h4>
  <div class="row">
    <label class="mini">speed
      <select bind:value={speed} disabled={macroService.replaying}>
        <option value="recorded">recorded timing</option>
        <option value="fast">as fast as possible</option>
      </select>
    </label>
    <label class="mini">repeat <input type="number" min="1" max="99" style="width:4.5em" bind:value={repeat} disabled={macroService.replaying} /></label>
    <label class="mini">loop wait (ms) <input type="number" min="0" step="100" style="width:6em" bind:value={loopWaitMs} disabled={macroService.replaying} /></label>
  </div>

  {#if macroService.replaying}
    <div class="row" style="margin-top:6px">
      <button onclick={() => (macroService.paused ? macroService.resume() : macroService.pause())}>{macroService.paused ? 'Resume' : 'Pause'}</button>
      <button class="danger" onclick={() => macroService.stopReplay()}>Stop</button>
    </div>
    <div class="steps">
      {#each macroService.replaySteps as s, i}
        <span class="step" class:done={i < macroService.progress} class:on={i === macroService.progress}>{s.label}</span>
      {/each}
    </div>
  {/if}
  {#if macroService.status}<div class="status-line {macroService.replaying ? 'busy' : macroService.status.includes('failed') ? 'err' : 'ok'}">{macroService.status}</div>{/if}

  <h4 class="sub">Saved macros</h4>
  {#if !macroService.saved.length}<div class="muted small">no saved macros yet</div>{/if}
  {#each macroService.saved as m (m.id)}
    <div class="macro-row">
      <span>{m.name} <span class="muted">· {m.steps.length} step(s)</span></span>
      <div class="row">
        <button onclick={() => replay(m)} disabled={macroService.replaying || macroService.recording} title="replay this macro">▶</button>
        <button onclick={() => macroService.export(m)} title="export as a .json file">↓</button>
        <button class="danger" onclick={() => macroService.remove(m.id)} disabled={macroService.replaying} title="delete">✕</button>
      </div>
    </div>
  {/each}
  <div class="row" style="margin-top:6px">
    <input type="file" accept="application/json" bind:this={fileInput} onchange={onImportFile} />
  </div>
</details>

<style>
  .mini { font-size: 11px; display: flex; flex-direction: column; gap: 3px; color: var(--muted); }
  .macro-row { display: flex; justify-content: space-between; align-items: center; padding: 5px 0; border-top: 1px solid var(--border); font-size: 12px; gap: 8px; }
  .steps { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
  .step { font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); background: var(--panel2); }
  .step.done { opacity: .55; }
  .step.on { border-color: var(--accent); color: var(--text); }
</style>
