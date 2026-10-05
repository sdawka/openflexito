/** Human wording for per-tile autofocus outcomes in a scan (shared by the map, the run page and the
 *  gallery height-map overlay). Pure; mirrors `GalleryItem['scan']['tiles'][i].focus`. */

export const FOCUS_REASON_LABEL: Record<string, string> = {
  flat: 'flat curve', multimodal: 'several peaks', edge: 'peak at sweep edge',
  few: 'too few samples', suspect: 'off the plane', coarse: 'coarse sweep only',
}

export interface TileFocusLike { status?: string; reason?: string; contrast?: number; error?: string }
export interface TileFocusAt { col: number; row: number; z?: number }

export const reasonLabel = (reason?: string): string => (reason ? FOCUS_REASON_LABEL[reason] ?? reason : '')

const fmtNum = (v: number) => String(v).replace('-', '−')

/** One-line tooltip: "(2,1) measured · contrast 1.9 · z −920", "(2,1) predicted from the plane (flat curve)",
 *  "(2,1) failed: <error>". `focus` may be absent (focus off or tile not reached yet). */
export function describeTileFocus(focus: TileFocusLike | undefined | null, at: TileFocusAt): string {
  const head = `(${at.col},${at.row})`
  const z = at.z !== undefined ? ` · z ${fmtNum(Math.round(at.z))}` : ''
  if (!focus || !focus.status || focus.status === 'none') return `${head} not autofocused${z}`
  const why = focus.reason ? ` (${reasonLabel(focus.reason)})` : ''
  const contrast = focus.contrast !== undefined ? ` · contrast ${focus.contrast.toFixed(1)}` : ''
  switch (focus.status) {
    case 'failed': return `${head} failed: ${focus.error ?? 'autofocus error'}${z}`
    case 'predicted': return `${head} predicted from the plane${why}${z}`
    case 'refined': return `${head} refined from the height map${why}${contrast}${z}`
    default: return `${head} ${focus.status}${why}${contrast}${z}`
  }
}

/** Counts by status plus reasons: "7 measured · 2 predicted (1 flat curve, 1 several peaks)". */
export function summariseTileFocus(tiles: Iterable<TileFocusLike | undefined | null>): string {
  const by = new Map<string, { n: number; reasons: Map<string, number> }>()
  for (const f of tiles) {
    if (!f?.status || f.status === 'none') continue
    const e = by.get(f.status) ?? { n: 0, reasons: new Map() }
    e.n++
    if (f.reason) e.reasons.set(f.reason, (e.reasons.get(f.reason) ?? 0) + 1)
    by.set(f.status, e)
  }
  return (['measured', 'refined', 'predicted', 'failed'] as const).filter((k) => by.has(k)).map((k) => {
    const e = by.get(k)!
    const rs = [...e.reasons].map(([r, n]) => `${n} ${reasonLabel(r)}`)
    return `${e.n} ${k}${rs.length ? ` (${rs.join(', ')})` : ''}`
  }).join(' · ')
}
