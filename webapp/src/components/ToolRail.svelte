<script lang="ts">
  import { ui, type ToolId } from '../lib/store/ui.svelte'
  import { liveStack } from '../lib/services/liveStack.svelte'
  import { recorder } from '../lib/services/recorder.svelte'
  import { timelapse } from '../lib/services/timelapse.svelte'
  import { tracking } from '../lib/services/tracking.svelte'
  import { macroService } from '../lib/services/macro.svelte'
  import { ai } from '../lib/services/aiService.svelte'
  import { follow } from '../lib/services/followService.svelte'

  interface Tool { id: ToolId; label: string; icon: string; busy?: () => boolean }

  // Icons are plain 20px-stroke SVG paths (viewBox 0 0 20 20), no icon library.
  const tools: Tool[] = [
    { id: 'stage', label: 'Stage', icon: 'M10 2v5M10 13v5M2 10h5M13 10h5M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z' },
    { id: 'focus', label: 'Focus', icon: 'M10 2v3M10 15v3M2 10h3M15 10h3M10 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z', busy: () => liveStack.active },
    { id: 'camera', label: 'Camera', icon: 'M3 7h3l1.5-2h5L14 7h3v9H3V7Zm7 2.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z' },
    { id: 'look', label: 'Look', icon: 'M10 3c-4 3-6 5.5-6 8.5A6 6 0 0 0 10 17a6 6 0 0 0 6-5.5C16 8.5 14 6 10 3Z' },
    { id: 'photo', label: 'Photo', icon: 'M3 6h3l1.4-1.8h5.2L14 6h3v10H3V6Zm7 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z', busy: () => recorder.recording },
    { id: 'measure', label: 'Measure', icon: 'M3 13 13 3l4 4L7 17H3v-4Zm5-1 3 3M9 9l2 2', busy: () => false },
    { id: 'timelapse', label: 'Time-lapse', icon: 'M10 2v2M10 16v2M4 10H2M18 10h-2M10 6v4l3 2M10 6a4 4 0 1 0 4 4', busy: () => timelapse.active },
    { id: 'tracking', label: 'Tracking', icon: 'M3 4h4v4H3V4Zm10 12h4v-4h-4v4ZM7 6h6M13 6v6M7 6l0 6M7 12h6', busy: () => tracking.active },
    { id: 'ai', label: 'AI', icon: 'M10 2 3 6v8l7 4 7-4V6l-7-4ZM3 6l7 4 7-4M10 10v8', busy: () => ai.busy > 0 || follow.active },
    { id: 'sample', label: 'Sample', icon: 'M8 2h4v4l4 9a2 2 0 0 1-2 3H6a2 2 0 0 1-2-3l4-9V2Z' },
    { id: 'macro', label: 'Macro', icon: 'M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z', busy: () => macroService.recording },
    { id: 'help', label: 'Help', icon: 'M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm0-5v-.5c0-1 3-1.2 3-3.5a3 3 0 1 0-6 0M10 14.5v.1' },
  ]
</script>

<aside class="tool-rail" aria-label="tools">
  {#each tools as t}
    <button data-tool={t.id} aria-pressed={ui.open && ui.tool === t.id} title={t.label} onclick={() => ui.openTool(t.id)}>
      <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d={t.icon} />
      </svg>
      <span>{t.label}</span>
      {#if t.busy?.()}<i class="busy-dot" aria-hidden="true"></i>{/if}
    </button>
  {/each}
</aside>

<style>
  .tool-rail { display: flex; flex-direction: column; width: 48px; flex: none; overflow-y: auto; overflow-x: hidden; background: var(--panel); border-left: 1px solid var(--border); }
  .tool-rail button {
    position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
    background: transparent; border: 0; border-radius: 0; padding: 8px 2px; width: 100%; color: var(--muted);
  }
  .tool-rail button:hover { color: var(--text); background: var(--panel2); }
  .tool-rail button[aria-pressed="true"] { color: var(--text); background: var(--panel2); box-shadow: inset 3px 0 0 var(--accent); }
  .tool-rail button span { font-size: 10px; line-height: 1; white-space: nowrap; }
  .busy-dot { position: absolute; top: 5px; right: 8px; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }

  @media (max-width: 720px) {
    .tool-rail { flex-direction: row; width: 100%; border-left: 0; border-bottom: 1px solid var(--border); overflow-x: auto; overflow-y: hidden; }
    .tool-rail button { width: auto; flex: none; padding: 6px 10px; min-width: 56px; }
  }
  @media (pointer: coarse) {
    .tool-rail button { min-height: 44px; }
  }
</style>
