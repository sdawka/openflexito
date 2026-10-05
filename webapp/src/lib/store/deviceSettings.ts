/** Pure helpers for the settings that live on the microscope (`calibration.set {key:'settings'}`).
 *  Kept free of runes so they are unit-testable; `store/settings.svelte.ts` supplies the key list. */

export type DeviceSettingsBlob<T> = Partial<T> & { when?: string }

/** The listed keys of `source`, deep-copied (plain JSON values only). */
export function pickKeys<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>
  for (const k of keys) if (source[k] !== undefined) out[k] = JSON.parse(JSON.stringify(source[k]))
  return out
}

/** The fields of a device blob that are allowed device settings and have the same JSON type as the
 *  default; anything else (unknown keys, `when`, wrong types from an older/newer client) is dropped. */
export function acceptRemote<T extends object, K extends keyof T>(
  remote: unknown, keys: readonly K[], defaults: T,
): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {}
  if (!remote || typeof remote !== 'object') return out
  const r = remote as Record<string, unknown>
  for (const k of keys) {
    const v = r[k as string]
    if (v === undefined) continue
    const d = defaults[k]
    // a `number | 'native'` field defaults to the string, so a number is also fine there
    const same = typeof v === typeof d || (typeof d === 'string' && typeof v === 'number')
    if (same && Array.isArray(v) === Array.isArray(d) && (v !== null) === (d !== null)) out[k] = JSON.parse(JSON.stringify(v))
  }
  return out
}

/** True when two subsets are equal as JSON. */
export const sameSubset = (a: object, b: object): boolean => JSON.stringify(a) === JSON.stringify(b)
