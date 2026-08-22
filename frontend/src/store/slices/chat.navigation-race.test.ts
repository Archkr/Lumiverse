/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, jest, mock, test } from 'bun:test'
import type { ChatSlice } from '@/types/store'

mock.module('@/api/settings', () => ({
  settingsApi: {
    put: async () => undefined,
  },
}))

let createChatSlice: typeof import('./chat').createChatSlice
const originalWindow = globalThis.window

beforeAll(async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: globalThis,
  })
  ;({ createChatSlice } = await import('./chat'))
})

afterAll(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: Window & typeof globalThis }).window
  } else {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    })
  }
})

function createStore(): ChatSlice {
  const state = {} as ChatSlice
  const set = (partial: Partial<ChatSlice> | ((current: ChatSlice) => Partial<ChatSlice>)) => {
    Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
  }
  const get = () => state
  Object.assign(state, createChatSlice(set as never, get as never, {} as never))
  return state
}

describe('chat navigation during streaming', () => {
  test('cancels a pending token flush when the active chat is cleared', () => {
    jest.useFakeTimers()
    const state = createStore()

    try {
      state.setActiveChat('chat-1')
      state.startStreaming('generation-1')
      state.appendStreamToken('late token')

      expect(state.getStreamBuffers().content).toBe('late token')

      state.setActiveChat(null)
      jest.runAllTimers()

      expect(state.activeChatId).toBeNull()
      expect(state.isStreaming).toBe(false)
      expect(state.streamingContent).toBe('')
      expect(state.getStreamBuffers()).toEqual({ content: '', reasoning: '' })
    } finally {
      jest.useRealTimers()
    }
  })
})
