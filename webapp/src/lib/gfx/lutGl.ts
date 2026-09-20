/** GPU colour-LUT renderer: uploads a baked `Lut3D` (`algo/lut.ts`) as a WebGL2 `sampler3D` and applies
 *  it to a source frame each `draw()` call — `out = mix(in, lut(in), strength)`, sampled with the
 *  standard half-texel offset (`in*(n-1)/n + 0.5/n`) so the LUT's own edge texels land exactly on 0 and
 *  1 instead of being interpolated against the texture's clamp-to-edge border.
 *
 *  This is the only WebGL code in the app (CLAUDE.md/integration-map: there was none before). It
 *  therefore lives outside `lib/algo` (which must stay pure/DOM-free/node-testable) as a small,
 *  self-contained class a service can own; the CPU fallback for when WebGL2 or `TEXTURE_3D` isn't
 *  available is `algo/lut.ts#applyLookRgba` — callers should check `LutRenderer.isSupported()` first.
 *
 *  `uploadLut` skips the re-upload when handed the exact same `Lut3D` object it uploaded last time (the
 *  look store's `current` is a memoised `$derived`, so its `.cube` reference only changes when the baked
 *  look actually changes) — no separate version counter needed. Losing the GL context is handled: `draw`
 *  returns `null` while lost so a caller falls back to the CPU path, and the context is rebuilt with the
 *  LUT re-uploaded on `webglcontextrestored`. */

import type { Lut3D } from '../algo/lut'

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform sampler3D uLut;
uniform float uStrength;
uniform float uSize;
void main() {
  vec4 c = texture(uSrc, vec2(vUv.x, 1.0 - vUv.y));
  vec3 coord = c.rgb * (uSize - 1.0) / uSize + 0.5 / uSize;
  vec3 looked = texture(uLut, coord).rgb;
  outColor = vec4(mix(c.rgb, looked, uStrength), c.a);
}`

function sourceSize(src: CanvasImageSource): { w: number; h: number } {
  const s = src as unknown as { naturalWidth?: number; naturalHeight?: number; videoWidth?: number; videoHeight?: number; width?: number; height?: number; displayWidth?: number; displayHeight?: number }
  if (typeof VideoFrame !== 'undefined' && src instanceof VideoFrame) return { w: src.displayWidth, h: src.displayHeight }
  if (s.naturalWidth) return { w: s.naturalWidth, h: s.naturalHeight as number }
  if (s.videoWidth) return { w: s.videoWidth, h: s.videoHeight as number }
  return { w: s.width ?? 0, h: s.height ?? 0 }
}

export class LutRenderer {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private srcTex: WebGLTexture | null = null
  private lutTex: WebGLTexture | null = null
  private lutSize = 2
  private lastLut: Lut3D | null = null
  private uStrengthLoc: WebGLUniformLocation | null = null
  private uSizeLoc: WebGLUniformLocation | null = null
  private lost = false

  /** WebGL2 + a working `TEXTURE_3D` (some ancient/software GL stacks expose webgl2 without it). */
  static isSupported(): boolean {
    try {
      const c: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(2, 2) : document.createElement('canvas')
      const gl = (c as unknown as { getContext(id: string): unknown }).getContext('webgl2') as WebGL2RenderingContext | null
      return !!gl && typeof gl.TEXTURE_3D === 'number'
    } catch { return false }
  }

  constructor(canvas?: HTMLCanvasElement | OffscreenCanvas) {
    this.canvas = canvas ?? (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas'))
    this.init()
    if (typeof (this.canvas as HTMLCanvasElement).addEventListener === 'function') {
      const el = this.canvas as HTMLCanvasElement
      el.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true })
      el.addEventListener('webglcontextrestored', () => { this.lost = false; this.lastLut = null; this.init() })
    }
  }

  private compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
    const sh = gl.createShader(type)!
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { gl.deleteShader(sh); return null }
    return sh
  }

  private init(): void {
    const gl = (this.canvas as unknown as { getContext(id: string, o?: object): unknown }).getContext('webgl2', { premultipliedAlpha: false }) as WebGL2RenderingContext | null
    this.gl = gl
    if (!gl) return
    const vs = this.compile(gl, gl.VERTEX_SHADER, VERT)
    const fs = this.compile(gl, gl.FRAGMENT_SHADER, FRAG)
    if (!vs || !fs) { this.program = null; return }
    const prog = gl.createProgram()!
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { this.program = null; return }
    this.program = prog
    gl.useProgram(prog)

    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    // one oversized triangle covering the viewport - avoids a seam at the diagonal a two-triangle quad has
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const posLoc = gl.getAttribLocation(prog, 'aPos')
    gl.enableVertexAttribArray(posLoc)
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0)

    this.srcTex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    this.lutTex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)

    this.uStrengthLoc = gl.getUniformLocation(prog, 'uStrength')
    this.uSizeLoc = gl.getUniformLocation(prog, 'uSize')
    gl.uniform1i(gl.getUniformLocation(prog, 'uSrc'), 0)
    gl.uniform1i(gl.getUniformLocation(prog, 'uLut'), 1)
  }

  /** Upload `lut` as the active 3D texture, skipping the upload if it is the same object (by reference)
   *  already uploaded. Tries a linear-filterable float texture first (`OES_texture_float_linear`);
   *  falls back to a quantised RGB8 texture (still linearly filtered, just 8-bit) when unavailable. */
  uploadLut(lut: Lut3D): void {
    const gl = this.gl
    if (!gl || !this.lutTex || lut === this.lastLut) return
    this.lastLut = lut
    this.lutSize = lut.size
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex)
    const floatOk = !!gl.getExtension('OES_texture_float_linear')
    if (floatOk) {
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, lut.size, lut.size, lut.size, 0, gl.RGB, gl.FLOAT, lut.data)
    } else {
      const bytes = new Uint8Array(lut.data.length)
      for (let i = 0; i < lut.data.length; i++) {
        const v = lut.data[i]
        bytes[i] = v < 0 ? 0 : v > 1 ? 255 : Math.round(v * 255)
      }
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, lut.size, lut.size, lut.size, 0, gl.RGB, gl.UNSIGNED_BYTE, bytes)
    }
  }

  /** Draw `src` through the currently uploaded LUT, mixed by `strength` (0 = untouched, 1 = full LUT).
   *  Returns the renderer's own canvas (resized to `src`'s dimensions), or `null` if the context is
   *  lost/unsupported/never initialised — the caller should fall back to `applyLookRgba` in that case. */
  draw(src: CanvasImageSource, opts: { strength: number }): HTMLCanvasElement | OffscreenCanvas | null {
    const gl = this.gl
    if (!gl || !this.program || this.lost) return null
    const { w, h } = sourceSize(src)
    if (!w || !h) return null
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h }
    gl.viewport(0, 0, w, h)
    gl.useProgram(this.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex)
    gl.uniform1f(this.uStrengthLoc, opts.strength)
    gl.uniform1f(this.uSizeLoc, this.lutSize)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    return this.canvas
  }

  destroy(): void {
    const gl = this.gl
    if (!gl) return
    if (this.srcTex) gl.deleteTexture(this.srcTex)
    if (this.lutTex) gl.deleteTexture(this.lutTex)
    if (this.program) gl.deleteProgram(this.program)
    this.gl = null; this.program = null; this.srcTex = null; this.lutTex = null; this.lastLut = null
  }
}
