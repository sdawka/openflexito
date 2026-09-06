/** Small in-place radix-2 FFT (1-D and 2-D) on split real/imaginary Float64Arrays. */

export function nextPow2(n: number): number { let p = 1; while (p < n) p <<= 1; return p }

export function fft1d(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length
  if (n & (n - 1)) throw new Error('fft size must be a power of two')
  // bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? 1 : -1)
    const wr = Math.cos(ang), wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr; im[b] = im[a] - ti
        re[a] += tr; im[a] += ti
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n }
}

/** 2-D FFT of a w x h (both powers of two) row-major array, in place. */
export function fft2d(re: Float64Array, im: Float64Array, w: number, h: number, inverse = false): void {
  const rowR = new Float64Array(w), rowI = new Float64Array(w)
  for (let y = 0; y < h; y++) {
    rowR.set(re.subarray(y * w, (y + 1) * w)); rowI.set(im.subarray(y * w, (y + 1) * w))
    fft1d(rowR, rowI, inverse)
    re.set(rowR, y * w); im.set(rowI, y * w)
  }
  const colR = new Float64Array(h), colI = new Float64Array(h)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) { colR[y] = re[y * w + x]; colI[y] = im[y * w + x] }
    fft1d(colR, colI, inverse)
    for (let y = 0; y < h; y++) { re[y * w + x] = colR[y]; im[y * w + x] = colI[y] }
  }
}
