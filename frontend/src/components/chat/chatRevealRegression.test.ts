import { describe, expect, test } from 'bun:test'

const readSource = (file: string) => Bun.file(`${import.meta.dir}/${file}`).text()

describe('staging chat reveal regression contracts', () => {
  test('ignores a populated event emitted for a stale chat', async () => {
    const source = await readSource('ChatView.tsx')
    const listener = source.match(
      /const handlePopulated = \(event: Event\) => \{[\s\S]*?\n    \}/,
    )?.[0] ?? ''

    expect(listener).toContain("event as CustomEvent<{ chatId?: string }>")
    expect(listener).toMatch(/populatedChatId\s*!==\s*chatId\)\s*return/)
    expect(listener).toContain('setChatChromeEntering(false)')
  })

  test('scopes the empty-chat two-frame reveal to the active load', async () => {
    const source = await readSource('ChatView.tsx')
    const emptyChat = source.match(
      /if \(msgPage\.data\.length === 0\) \{[\s\S]*?\n        \}/,
    )?.[0] ?? ''

    expect(emptyChat).toContain('requestAnimationFrame(() => {')
    expect((emptyChat.match(/requestAnimationFrame\(\(\) => \{/g) ?? []).length).toBe(2)
    expect(emptyChat).toMatch(/if\s*\(cancelled\)\s*return/)
    expect(emptyChat).toMatch(/detail:\s*\{\s*chatId\s*\}/)
  })

  test('cancels a pending populated reveal so hydration can retry after rows return', async () => {
    const source = await readSource('MessageList.tsx')
    const revealEffect = source.match(
      /const hasPopulated = virtualItems\.some\([\s\S]*?\n  \}, \[chatId, hasPopulated\]\)/,
    )?.[0] ?? ''

    expect(revealEffect).toMatch(/if \(hasFadedInRef\.current \|\| !hasPopulated\) return/)
    expect(revealEffect).toMatch(/let cancelled = false/)
    expect(revealEffect).toMatch(/if \(!cancelled\) \{[\s\S]*?hasFadedInRef\.current = true/)
    expect(revealEffect).toMatch(/return \(\) => \{\s*cancelled = true/)
    expect(revealEffect).toMatch(/\}, \[chatId, hasPopulated\]\)$/)
  })
})
