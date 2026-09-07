/** Shared worker plumbing. `defineWorker` installs the message handler and turns any exception into an
 *  `{ error }` message, so a bug in an algorithm surfaces in the caller's status line instead of
 *  killing the worker silently. `post` is `postMessage` with an optional transfer list. */
export function post(message: unknown, transfer: Transferable[] = []): void {
  ;(self as unknown as Worker).postMessage(message, transfer)
}

export function defineWorker<M>(handler: (m: M) => void | Promise<void>): void {
  self.onmessage = async (ev: MessageEvent<M>) => {
    try { await handler(ev.data) } catch (e) { post({ error: (e as Error).message }) }
  }
}
