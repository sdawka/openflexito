import { describe, it, expect, beforeEach, vi } from 'vitest'
import { macroService } from '../macro.svelte'
import { device } from '../../store/device.svelte'
import { RpcClient } from '../../api/rpc'

describe('MacroService', () => {
  beforeEach(() => {
    macroService.steps = []
    macroService.recording = false
  })

  it('records RPC calls while recording is active', () => {
    macroService.start()
    expect(macroService.recording).toBe(true)

    // Manually invoke the hook (simulating a call)
    const callHook = (device.client as any)['callHook']
    if (callHook) {
      callHook('stage.move_rel', { x: 10 })
    }

    expect(macroService.steps.length).toBeGreaterThan(0)
    const step = macroService.steps[0]
    expect(step.kind).toBe('call')
    expect(step.method).toBe('stage.move_rel')
    expect(step.params).toEqual({ x: 10 })

    macroService.stop()
    expect(macroService.recording).toBe(false)
  })

  it('continues recording after a device reconnect', () => {
    macroService.start()
    expect(macroService.recording).toBe(true)

    // Invoke the hook before reconnect to capture a call
    let capturedHook = (device.client as any)['callHook']
    if (capturedHook) {
      capturedHook('stage.move_rel', { x: 10 })
    }
    const stepsBeforeReconnect = macroService.steps.length
    expect(stepsBeforeReconnect).toBe(1)

    // Simulate reconnect: create a new client and rebind
    const oldClient = device.client
    const newClient = new RpcClient('http://test')

    // Replace the client
    ;(device as any).client = newClient
    ;(device as any).bind(newClient)

    // Verify the hook was reapplied to the new client
    const newClientHook = (newClient as any)['callHook']
    expect(newClientHook).not.toBeNull()

    // Call the hook on the new client
    if (newClientHook) {
      newClientHook('light.set', { cc: 100 })
    }

    // Verify the new call was captured
    expect(macroService.steps.length).toBe(2)
    const newStep = macroService.steps[1]
    expect(newStep.kind).toBe('call')
    expect(newStep.method).toBe('light.set')
    expect(newStep.params).toEqual({ cc: 100 })

    macroService.stop()

    // Restore old client for cleanup
    ;(device as any).client = oldClient
  })

  it('does not record methods outside RECORD_METHODS', () => {
    macroService.start()

    // Try to record a call that should not be recorded (not in RECORD_METHODS)
    const callHook = (device.client as any)['callHook']
    if (callHook) {
      callHook('system.status', {})
    }

    // system.status is not in RECORD_METHODS, so steps should be empty
    expect(macroService.steps.length).toBe(0)

    macroService.stop()
  })

  it('clears steps when starting a new recording', () => {
    macroService.start()
    const callHook = (device.client as any)['callHook']
    if (callHook) {
      callHook('stage.move_rel', { x: 10 })
    }
    expect(macroService.steps.length).toBeGreaterThan(0)
    macroService.stop()

    const oldSteps = macroService.steps.length
    macroService.start()
    expect(macroService.steps.length).toBe(0)
    macroService.stop()
  })

  it('removes the hook when recording stops', () => {
    macroService.start()
    expect((device.client as any)['callHook']).not.toBeNull()

    macroService.stop()
    expect((device.client as any)['callHook']).toBeNull()
  })
})
