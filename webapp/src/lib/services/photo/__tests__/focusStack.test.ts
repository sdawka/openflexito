import { describe, it, expect, vi, afterEach } from 'vitest'
import { moveZVerified } from '../focusStack'
import { device } from '../../../store/device.svelte'
import type { MoveResult } from '../../../algo/types'

/** `stage.py#_to_program`: `sign * (hw + offset)`. A z axis inverted (the rig's default) with a
 *  nonzero restore-position offset makes the program frame and the raw hardware frame numerically
 *  unrelated — a program-frame target compared against `end_hw` would look wildly wrong even for a
 *  move that landed exactly on target. These fixtures model that so a regression back to comparing
 *  the wrong frame would fail loudly instead of only showing up as a flaky e2e "did not reach z=". */
function moveResult(programZ: number, hwZ: number, cancelled = false): MoveResult {
  return {
    position: { x: 0, y: 0, z: programZ },
    start_hw: { x: 0, y: 0, z: hwZ },
    end_hw: { x: 0, y: 0, z: hwZ },
    t0: 0, t1: 1, cancelled,
  }
}

describe('moveZVerified', () => {
  afterEach(() => vi.restoreAllMocks())

  it('compares the program-frame position, not the unrelated raw hw frame, when they diverge', async () => {
    device.position = { x: 0, y: 0, z: 100 }
    // z inverted + offset 500 (see stage.py _to_program): program 150 <-> hw -650, nothing alike numerically
    vi.spyOn(device, 'moveRel').mockResolvedValueOnce(moveResult(150, -650))
    const say = vi.fn()
    const z = await moveZVerified(50, 'z', say, 'focus stack')
    expect(z).toBe(150)
    expect(say).not.toHaveBeenCalled()   // arrived first try, no retry/mismatch chatter
  })

  it('retries a short move using the residual program-frame distance, then succeeds', async () => {
    device.position = { x: 0, y: 0, z: 0 }
    vi.spyOn(device, 'moveRel')
      .mockResolvedValueOnce(moveResult(40, -540))   // short of the target (50) by 10, in program frame
      .mockResolvedValueOnce(moveResult(50, -550))
    const say = vi.fn()
    const z = await moveZVerified(50, 'z', say, 'focus stack')
    expect(z).toBe(50)
    expect(device.moveRel).toHaveBeenNthCalledWith(2, { z: 10 }, 'z')
    expect(say).toHaveBeenCalledTimes(1)
  })

  it('throws if the stage still misses target after one retry', async () => {
    device.position = { x: 0, y: 0, z: 0 }
    vi.spyOn(device, 'moveRel')
      .mockResolvedValueOnce(moveResult(40, -540))
      .mockResolvedValueOnce(moveResult(45, -545))
    await expect(moveZVerified(50, 'z', vi.fn(), 'focus stack')).rejects.toThrow(/did not reach z=50/)
  })
})
