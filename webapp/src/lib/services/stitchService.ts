import type { StitchRequest, StitchResponse } from '../workers/stitchWorker'

export function stitchInWorker(req: StitchRequest, onProgress?: (m: string) => void): Promise<StitchResponse> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../workers/stitchWorker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (ev) => {
      if (ev.data.progress) onProgress?.(ev.data.progress)
      if (ev.data.result) { resolve(ev.data.result); w.terminate() }
      if (ev.data.error) { reject(new Error(ev.data.error)); w.terminate() }
    }
    w.onerror = (e) => { reject(new Error(e.message)); w.terminate() }
    w.postMessage(req)
  })
}
