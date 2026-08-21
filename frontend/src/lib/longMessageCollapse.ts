import type { LongMessageCollapsePreset } from '@/types/store'

export const LONG_MESSAGE_COLLAPSE_HEIGHTS: Readonly<Record<LongMessageCollapsePreset, number>> = Object.freeze({
  compact: 300,
  comfortable: 500,
  tall: 800,
})

export function getLongMessageCollapseHeight(preset: LongMessageCollapsePreset): number {
  return LONG_MESSAGE_COLLAPSE_HEIGHTS[preset] ?? LONG_MESSAGE_COLLAPSE_HEIGHTS.comfortable
}

export function isLongMessageCollapseEligible(input: {
  enabled: boolean
  isUser: boolean
  chatId?: string
  messageId?: string
}): boolean {
  return input.enabled && !input.isUser && !!input.chatId && !!input.messageId
}

export function longMessageExpansionKey(chatId: string, messageId: string): string {
  return `${chatId}:${messageId}`
}

export function isLongMessageOverflowing(contentHeight: number, maxHeight: number): boolean {
  return contentHeight > maxHeight + 1
}
