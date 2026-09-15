<script lang="ts">
  /** Standby toggle shown in the app shell on every route (CLAUDE.md App.svelte). Confirms before
   *  switching off (a real capture in flight, or someone else at the eyepiece); switching back on
   *  needs no confirmation. A missing `status.power` (older device) reads as on via device.powerOn. */
  import { device } from '../lib/store/device.svelte'

  let busy = $state(false)

  async function toggle(): Promise<void> {
    if (busy) return
    const turningOff = device.powerOn
    if (turningOff && !confirm('Switch the microscope to standby? The camera and stage will stop; the webapp stays reachable.')) return
    busy = true
    try { await device.togglePower() } catch { /* device.error already set; button just re-enables */ }
    finally { busy = false }
  }
</script>

<button
  class="power-btn"
  class:off={!device.powerOn}
  aria-label="power"
  title={device.powerOn ? 'Switch to standby' : 'Wake microscope'}
  disabled={busy || !device.connected}
  onclick={toggle}
>
  {#if busy}
    <span class="spin"></span>
  {:else}
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M12 3v8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <path d="M7 6.5a8 8 0 1 0 10 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>
  {/if}
</button>

<style>
  .power-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; padding: 0; border-radius: 50%; flex: none;
    color: var(--ok);
  }
  .power-btn.off { color: var(--muted); }
  .power-btn:hover:not(:disabled) { border-color: currentColor; }
  .spin {
    width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--accent); border-top-color: transparent;
    animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  @media (pointer: coarse) {
    .power-btn { width: 44px; height: 44px; }
  }
</style>
