/** File names for exported gallery items. A stem reads
 *  `20260910-192530_pond-water-a3_focus-stack-9x50_x120_y-40_z1234` so files sort by capture time,
 *  group by sample and still say what they are and where the stage was; blob names are appended by
 *  the caller (`…_image.jpg`, `…_slice-3.jpg`, `…_dng.dng`). Pure and tested. */

export interface Nameable {
  when: string                       // ISO time of capture
  name: string                       // mode label, e.g. "Focus stack 9×50"
  kind?: string
  sample?: { name?: string } | null
  position?: { x: number; y: number; z: number } | null
}

/** Lower-case, ASCII, `-` between words, nothing a file system dislikes. `×` becomes `x`. */
export function slug(s: string, max = 40): string {
  const out = s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[×✕]/g, 'x').replace(/µ/g, 'u')
    .toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-')
  return out.length > max ? out.slice(0, max).replace(/-+$/g, '') : out
}

/** `YYYYMMDD-HHMMSS` in local time (files are read where they were taken). Invalid dates → 'undated'. */
export function timestampStem(when: string | Date, local = true): string {
  const d = when instanceof Date ? when : new Date(when)
  if (isNaN(d.getTime())) return 'undated'
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return local
    ? `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    : `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
}

/** Strip a locale date/time that older items embedded in their label ("Snapshot 10/09/2026, 19:25:30"). */
function stripEmbeddedDate(label: string): string {
  return label.replace(/\s*\d{1,4}[./-]\d{1,2}[./-]\d{1,4},?\s*\d{1,2}:\d{2}(:\d{2})?(\s*[AP]M)?\s*$/i, '').trim()
}

export function fileStem(item: Nameable, opts: { local?: boolean } = {}): string {
  const parts = [timestampStem(item.when, opts.local ?? true)]
  const sample = item.sample?.name ? slug(item.sample.name, 30) : ''
  if (sample) parts.push(sample)
  const label = slug(stripEmbeddedDate(item.name) || item.kind || 'item')
  parts.push(label || 'item')
  if (item.position) {
    const r = (v: number) => Math.round(v)
    parts.push(`x${r(item.position.x)}_y${r(item.position.y)}_z${r(item.position.z)}`)
  }
  return parts.join('_')
}

/** File name for one blob of an item: `<stem>_<blob>.<ext>`; 'image' is the main image and gets no suffix. */
export function blobFileName(item: Nameable, blob: string, ext: string): string {
  const stem = fileStem(item)
  const suffix = blob === 'image' ? '' : `_${slug(blob.replace(/\//g, '-'), 24)}`
  return `${stem}${suffix}.${ext}`
}
