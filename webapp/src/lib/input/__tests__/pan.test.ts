import { describe, expect, it } from 'vitest'
import { PanController } from '../pan'
import type { Mat2 } from '../../algo/csm'

const tick = () => new Promise((r) => setTimeout(r, 0))

function harness(matrix: Mat2 = [[2, 0], [0, -2]]) {
  const moves: { x: number; y: number }[] = []
  let release: (() => void) | null = null
  const io = {
    matrix,
    move: (d: { x: number; y: number }) => new Promise<void>((r) => { moves.push(d); release = r }),
  }
  const pan = new PanController(io)
  return { pan, moves, finish: async () => { release?.(); release = null; await tick() } }
}

describe('PanController', () => {
  it('sends one move at a time and only the un-sent remainder', async () => {
    const { pan, moves, finish } = harness()
    pan.begin()
    pan.update([10, 0])          // 20 steps in x
    pan.update([25, 5])          // cursor moved on while the first move is in flight
    expect(moves).toEqual([{ x: 20, y: 0 }])
    await finish()
    expect(moves[1]).toEqual({ x: 30, y: -10 })   // (50, -10) total minus what was sent
    await finish()
    expect(moves.length).toBe(2)
  })

  it('ignores tiny remainders while dragging but flushes them on release', async () => {
    const { pan, moves, finish } = harness()
    pan.begin()
    pan.update([1, 0])           // 2 steps < minSteps
    expect(moves).toEqual([])
    pan.end()
    expect(moves).toEqual([{ x: 2, y: 0 }])
    await finish()
    expect(pan.busy).toBe(false)
    expect(pan.pendingPx()).toEqual([0, 0])
  })

  it('reports the part of the drag the stage has not caught up with', async () => {
    const { pan, finish } = harness()
    pan.begin()
    pan.update([10, 4])
    expect(pan.pendingPx()).toEqual([10, 4])    // move in flight, nothing settled yet
    await finish()
    expect(pan.pendingPx()).toEqual([0, 0])
  })

  it('a drag that starts while the previous one settles continues from the sent position', async () => {
    const { pan, moves, finish } = harness()
    pan.begin(); pan.update([10, 0]); pan.end()
    pan.begin()                   // still in flight
    pan.update([15, 0])
    await finish()                // first move done -> pump sends the remainder
    expect(moves).toEqual([{ x: 20, y: 0 }, { x: 10, y: 0 }])
    await finish()
  })

  it('gives up cleanly when the device rejects a move', async () => {
    const moves: unknown[] = []
    const pan = new PanController({ matrix: [[1, 0], [0, 1]], move: async (d) => { moves.push(d); throw new Error('stage busy') } })
    pan.begin(); pan.update([50, 0]); pan.end()
    await tick()
    expect(moves.length).toBe(1)
    expect(pan.busy).toBe(false)
    expect(pan.pendingPx()).toEqual([0, 0])
  })
})
