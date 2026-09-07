/** JSON-RPC 2.0 over a single WebSocket, with reconnect and server-push events. */

type Handler = (params: any) => void

export interface RpcErrorShape { code: number; message: string; data?: unknown }

export class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message)
  }
}

export class RpcClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private handlers = new Map<string, Set<Handler>>()
  private retryMs = 500
  private closed = false
  connected = false
  /** Set by services/macro.svelte.ts while recording: notified with (method, params) on every call(). */
  private callHook: ((method: string, params: unknown) => void) | null = null

  constructor(public baseUrl: string) {}

  /** http(s)://host[:port] -> ws(s)://host[:port]/ws ; '' means same origin */
  private wsUrl(): string {
    const base = this.baseUrl || window.location.origin
    return base.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws'
  }

  httpUrl(path: string): string {
    return (this.baseUrl || '').replace(/\/$/, '') + path
  }

  connect(): void {
    this.closed = false
    this.open()
  }

  close(): void {
    this.closed = true
    this.ws?.close()
  }

  private open(): void {
    const ws = new WebSocket(this.wsUrl())
    this.ws = ws
    ws.onopen = () => {
      this.connected = true
      this.retryMs = 500
      this.emit('$open', null)
    }
    ws.onclose = () => {
      this.connected = false
      for (const p of this.pending.values()) p.reject(new Error('connection closed'))
      this.pending.clear()
      this.emit('$close', null)
      if (!this.closed) {
        setTimeout(() => this.open(), this.retryMs)
        this.retryMs = Math.min(this.retryMs * 2, 5000)
      }
    }
    ws.onerror = () => ws.close()
    ws.onmessage = (ev) => {
      let msg: any
      try { msg = JSON.parse(ev.data) } catch { return }
      for (const m of Array.isArray(msg) ? msg : [msg]) this.dispatch(m)
    }
  }

  private dispatch(m: any): void {
    if (m.method && m.id === undefined) {
      this.emit(m.method, m.params)
      return
    }
    const p = this.pending.get(m.id)
    if (!p) return
    this.pending.delete(m.id)
    if (m.error) p.reject(new RpcError(m.error.code, m.error.message, m.error.data))
    else p.resolve(m.result)
  }

  /** Subscribe to every outgoing call (for macro recording); pass null to unsubscribe. */
  onCall(fn: ((method: string, params: unknown) => void) | null): void {
    this.callHook = fn
  }

  call<T = any>(method: string, params?: Record<string, unknown> | unknown[]): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('not connected'))
    }
    try { this.callHook?.(method, params) } catch (e) { console.error('call hook failed', e) }
    const id = this.nextId++
    const msg = { jsonrpc: '2.0', id, method, params }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws!.send(JSON.stringify(msg))
    })
  }

  /** Subscribe to `event.<name>` pushes (pass the full method name, e.g. 'event.position'). */
  on(name: string, fn: Handler): () => void {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set())
    this.handlers.get(name)!.add(fn)
    return () => this.handlers.get(name)?.delete(fn)
  }

  private emit(name: string, params: any): void {
    this.handlers.get(name)?.forEach((fn) => {
      try { fn(params) } catch (e) { console.error('handler failed', name, e) }
    })
  }
}
