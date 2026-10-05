/** Keeps the browser's calibration stores in step with the microscope's `calibration.json`.
 *
 *  On every (re)connect the device's `calibration.get` is read and applied to the stores (device wins);
 *  a key the device lacks but the local cache has is uploaded once, which migrates calibrations made
 *  before the device stored them. Every `save*` in the stores calls `push`, which writes the key to the
 *  device (`calibration.set`, null deletes). Another client's change arrives as `event.calibration`
 *  (surfaced by the device store as `calibrationEvent`); the key is re-read unless its `when` already
 *  matches ours. The microscope-describing subset of `settings` (`DEVICE_SETTING_KEYS`) travels under
 *  key `settings` the same way (debounced push, device wins on connect). Imported once from `App.svelte` for its side effects. */

import { device } from '../store/device.svelte'
import { calibration, applyFromDevice, CAL_KEYS, calibrationSync, type CalSlot } from '../store/calibration.svelte'
import { settingsSync, applyDeviceSettings, deviceSettingsSubset } from '../store/settings.svelte'
import { scaleCal, saveManualScale, SCALE_KEY } from '../store/scaleCal.svelte'

type Entry = { when?: string } | null

const SETTINGS_KEY = 'settings'
/** `when` of the settings blob last sent or received, so an echo or an already-held version is skipped. */
let settingsWhen: string | null = null
let settingsTimer: ReturnType<typeof setTimeout> | undefined

const slotOf = (key: string): CalSlot | null => (Object.keys(CAL_KEYS) as CalSlot[]).find((s) => CAL_KEYS[s] === key) ?? null

function localValue(key: string): Entry {
  if (key === SETTINGS_KEY) return settingsWhen ? { when: settingsWhen } : null
  if (key === SCALE_KEY) return $state.snapshot(scaleCal.manual)
  const slot = slotOf(key)
  return slot ? ($state.snapshot(calibration[slot]) as Entry) : null
}

function apply(key: string, value: unknown): void {
  if (key === SETTINGS_KEY) {
    settingsWhen = (value as Entry)?.when ?? null
    if (value) applyDeviceSettings(value)
    return
  }
  if (key === SCALE_KEY) { saveManualScale((value ?? null) as never, true); return }
  const slot = slotOf(key)
  if (slot) applyFromDevice(slot, value)
}

/** Writes in flight, so our own `event.calibration` echoes are not re-read. */
const pending = new Map<string, string | null>()

export const syncState = $state<{ status: 'idle' | 'syncing' | 'synced' | 'error'; error: string | null }>({ status: 'idle', error: null })

async function pull(): Promise<void> {
  syncState.status = 'syncing'
  try {
    const all = await device.client.call<Record<string, Entry>>('calibration.get')
    const keys = new Set([...Object.values(CAL_KEYS), SCALE_KEY])
    const remoteSettings = all[SETTINGS_KEY] ?? null
    if (remoteSettings) apply(SETTINGS_KEY, remoteSettings)
    else await pushSettings(deviceSettingsSubset())   // migrate this browser's values onto the device
    for (const key of keys) {
      const remote = all[key] ?? null
      const local = localValue(key)
      if (remote) apply(key, remote)
      else if (local) await push(key, local)   // migrate a browser-only calibration onto the device
    }
    syncState.status = 'synced'; syncState.error = null
  } catch (e) {
    syncState.status = 'error'; syncState.error = (e as Error).message
    console.warn('calibration sync failed', e)
  }
}

async function push(key: string, value: object | null): Promise<void> {
  if (!device.connected) return   // the cache keeps it; the next connect uploads it
  const when = (value as Entry)?.when ?? null
  pending.set(key, when)
  try {
    await device.client.call('calibration.set', { key, value })
    device.refreshStatus().catch(() => {})   // the {key: when} summary in system.status feeds the Calibrate page's 'stored' line
  } catch (e) {
    console.warn(`calibration.set ${key} failed`, e)
  }
}

async function pushSettings(subset: object): Promise<void> {
  const when = new Date().toISOString()
  settingsWhen = when
  await push(SETTINGS_KEY, { ...subset, when })
}

settingsSync.push = (subset) => {
  clearTimeout(settingsTimer)
  settingsTimer = setTimeout(() => { void pushSettings(subset) }, 500)
}

calibrationSync.push = (key, value) => { void push(key, value) }

$effect.root(() => {
  $effect(() => {
    if (device.connected) void pull()
  })
  $effect(() => {
    const ev = device.calibrationEvent
    if (!ev) return
    if (pending.get(ev.key) === ev.when) { pending.delete(ev.key); return }   // our own write
    if ((localValue(ev.key)?.when ?? null) === ev.when) return                // already have it
    device.client.call<{ value: unknown }>('calibration.get', { key: ev.key }).then((r) => apply(ev.key, r.value)).catch(() => {})
  })
})
