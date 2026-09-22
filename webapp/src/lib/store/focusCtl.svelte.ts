/** Autofocus control shared by `components/FocusPanel.svelte` (mode/range pickers, the Autofocus
 *  button) and the HUD's AF button (`components/LiveHud.svelte`), plus the gamepad's A-button binding
 *  in `routes/Live.svelte`. One place owns `focusing` so both entry points show the same spinner and
 *  cancel the same in-flight sweep. */

import { runAutofocus, cancelAutofocus } from '../services/autofocusService'
import { macroService } from '../services/macro.svelte'

export type AfMode = 'fast' | 'looping' | 'step' | 'twopass'

class FocusCtl {
  mode = $state<AfMode>('fast')
  range = $state(2000)
  focusing = $state(false)
  log = $state('')

  /** Start an autofocus sweep with the current mode/range, or cancel one already running. */
  async run(): Promise<void> {
    if (this.focusing) { cancelAutofocus(); return }
    this.focusing = true
    this.log = 'autofocus…'
    try {
      const r = await runAutofocus({ mode: this.mode, dz: this.range, metric: 'jpeg', onProgress: (m) => (this.log = m) })
      this.log = `focused at z=${r.peakZ} (${r.samples.length} samples)`
      macroService.recordAction('autofocus', { mode: this.mode, dz: this.range }, `autofocus (${this.mode})`)
    } catch (e) {
      this.log = (e as Error).message
    } finally {
      this.focusing = false
    }
  }

  cancel(): void { cancelAutofocus() }
}

export const focusCtl = new FocusCtl()
