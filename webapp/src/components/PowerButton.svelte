<script lang="ts">
  /** Standby toggle shown in the app shell on every route (CLAUDE.md App.svelte). Confirms before
   *  switching off (a real capture in flight, or someone else at the eyepiece); switching back on
   *  needs no confirmation. A missing `status.power` (older device) reads as on via device.powerOn. */
  import { device } from '../lib/store/device.svelte'

  let busy = $state(false)

  // A quiet "sleeps in Ng min" hint once the auto-standby countdown (device.idleIn, kept fresh by
  // lib/services/activity.svelte.ts's heartbeat) is close; not shown at all otherwise, so it never
  // competes with the button on a phone.
  const soonMin = $derived.by(() => {
    if (!device.powerOn || device.idleIn < 0 || device.idleIn > 120) return null
    return Math.max(1, Math.ceil(device.idleIn / 60))
  })

  const title = $derived(!device.powerOn ? 'Wake microscope' : soonMin != null ? `Switch to standby (auto standby in ${soonMin} min)` : 'Switch to standby')

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
  title={title}
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
  {#if soonMin != null}
    <!-- Quiet countdown badge: an overlay, not a flex sibling, so it costs no extra width in the
         one-row mobile top bar (App.svelte) — just numerals, the title attribute has the full text. -->
    <span class="soon" aria-hidden="true">{soonMin}</span>
  {/if}
</button>

<style>
  .power-btn {
    position: relative; display: inline-flex; align-items: center; justify-content: center;
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
  .soon {
    position: absolute; top: -4px; right: -4px; min-width: 14px; height: 14px; padding: 0 3px;
    border-radius: 999px; background: var(--warn); color: #201a08; font-size: 10px; font-weight: 700;
    line-height: 14px; text-align: center;
  }

  @media (pointer: coarse) {
    .power-btn { width: 44px; height: 44px; }
  }
</style>
