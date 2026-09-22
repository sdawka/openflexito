/** Live page chrome: which drawer tool is open (or none) and whether the app is in immersive
 *  (chrome-free, optionally fullscreen) mode. Persisted to localStorage so a reload keeps the drawer
 *  where the user left it; on a first visit (nothing persisted yet) the drawer starts closed on
 *  desktop and open on `stage` on mobile, matching `matchMedia('(max-width: 720px)')` read once here. */

export type ToolId =
  | 'stage' | 'focus' | 'camera' | 'look' | 'photo' | 'measure'
  | 'timelapse' | 'tracking' | 'ai' | 'sample' | 'macro' | 'help'

const KEY = 'openflexito.ui'

interface Persisted { open: boolean; tool: ToolId }

function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as Persisted
  } catch { /* ignore */ }
  const mobile = typeof matchMedia === 'function' && matchMedia('(max-width: 720px)').matches
  return { open: mobile, tool: 'stage' }
}

function save(open: boolean, tool: ToolId): void {
  try { localStorage.setItem(KEY, JSON.stringify({ open, tool })) } catch { /* ignore */ }
}

const initial = load()

class UiStore {
  open = $state(initial.open)
  tool = $state<ToolId>(initial.tool)
  immersive = $state(false)

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) this.immersive = false })
    }
  }

  /** Open the drawer on `tool`, or close it if that tool is already the open one. */
  openTool(tool: ToolId): void {
    if (this.open && this.tool === tool) this.open = false
    else { this.tool = tool; this.open = true }
    save(this.open, this.tool)
  }

  close(): void {
    if (!this.open) return
    this.open = false
    save(this.open, this.tool)
  }

  /** Toggle chrome-free viewing: hides nav/rail/drawer and asks the browser to go fullscreen; drops
   *  back out of immersive whenever fullscreen ends by any means (Esc, browser chrome, this toggle). */
  toggleImmersive(): void {
    if (this.immersive) {
      this.immersive = false
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
      return
    }
    this.immersive = true
    document.documentElement.requestFullscreen?.().catch(() => {})
  }
}

export const ui = new UiStore()
