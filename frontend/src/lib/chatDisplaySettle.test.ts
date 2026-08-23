import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  beginChatDisplayWork,
  endChatDisplayWork,
  isChatDisplaySettled,
  resetChatDisplaySettleForTests,
  trackInitialDisplayResolve,
} from './chatDisplaySettle'
import {
  reconcileMessageTagRuntimeCapabilities,
  resetMessageTagRuntimeReadinessForTests,
} from './spindle/message-tag-runtime-readiness'

beforeEach(() => {
  reconcileMessageTagRuntimeCapabilities([])
})

afterEach(() => {
  resetChatDisplaySettleForTests()
  resetMessageTagRuntimeReadinessForTests()
})

describe('chatDisplaySettle', () => {
  test('is settled immediately when runtime readiness and work queues are clear', () => {
    expect(isChatDisplaySettled()).toBe(true)
  })

  test('in-flight first resolves block settlement until they drain', async () => {
    let release!: (v: string) => void
    const pending = new Promise<string>((resolve) => { release = resolve })
    const tracked = trackInitialDisplayResolve(pending)
    expect(isChatDisplaySettled()).toBe(false)
    release('value')
    const result = await tracked
    expect(result).toBe('value')
    expect(isChatDisplaySettled()).toBe(true)
  })

  test('rejections also drain the pending count and propagate', async () => {
    let reject!: (err: Error) => void
    const pending = new Promise<string>((_resolve, rej) => { reject = rej })
    const tracked = trackInitialDisplayResolve(pending)
    expect(isChatDisplaySettled()).toBe(false)
    reject(new Error('boom'))
    try {
      await tracked
      throw new Error('expected rejection')
    } catch (err) {
      expect((err as Error).message).toBe('boom')
    }
    expect(isChatDisplaySettled()).toBe(true)
  })

  test('first-wave display work blocks settlement until it ends', () => {
    beginChatDisplayWork()
    expect(isChatDisplaySettled()).toBe(false)
    endChatDisplayWork()
    expect(isChatDisplaySettled()).toBe(true)
  })
})
