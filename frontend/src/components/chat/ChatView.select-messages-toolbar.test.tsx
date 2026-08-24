import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { isShowNativeSelectMessages } from '../quick-toolbar/quickToolbarDock'

describe('ChatView native select-messages toolbar', () => {
  test('isShowNativeSelectMessages stays on unless explicitly false', () => {
    expect(isShowNativeSelectMessages(undefined)).toBe(true)
    expect(isShowNativeSelectMessages({})).toBe(true)
    expect(isShowNativeSelectMessages({ showNativeSelectMessages: true })).toBe(true)
    expect(isShowNativeSelectMessages({ showNativeSelectMessages: false })).toBe(false)
  })

  test('ChatView gates the Suite toolbar controls and keeps MessageSelectBar', async () => {
    const source = await Bun.file(resolve(import.meta.dir, 'ChatView.tsx')).text()

    expect(source).toContain("import { hasEnabledFrontendExtension } from '@/lib/spindle/frontend-extension-availability'")
    expect(source).toContain("const suiteExtensionEnabled = useStore((s) => hasEnabledFrontendExtension(s.extensions, 'lumiverse_suite'))")
    expect(source).toContain('ListChecks')
    expect(source).toMatch(/suiteExtensionEnabled\s*&&\s*isShowNativeSelectMessages\(quickToolbarSettings\)\s*&&\s*\(/)
    expect(source).toMatch(/suiteExtensionEnabled\s*&&\s*isShowNativeScrollToTop\(quickToolbarSettings\)/)
    expect(source).toMatch(/suiteExtensionEnabled\s*&&\s*isShowNativeBrowseMessages\(quickToolbarSettings\)/)
    expect(source).toContain("const dockQuickToolbar = suiteExtensionEnabled && quickToolbarPlacement === 'chat_top_dock'")
    expect(source).toMatch(/aria-pressed=\{messageSelectMode\}/)
    expect(source).toMatch(/\{messageSelectMode && <MessageSelectBar chatId=\{chatId\} \/>\}/)

    const nativeButton = source.match(
      /\{suiteExtensionEnabled && isShowNativeSelectMessages\(quickToolbarSettings\) && \([\s\S]*?<ListChecks size=\{14\} \/>[\s\S]*?<\/button>\s*\)\}/,
    )?.[0] ?? ''
    expect(nativeButton).toContain('aria-pressed={messageSelectMode}')
    expect(nativeButton).toContain('ListChecks')
    expect(nativeButton).not.toContain('MessageSelectBar')

    const selectBarIndex = source.indexOf('{messageSelectMode && <MessageSelectBar chatId={chatId} />}')
    const gateIndex = source.indexOf('isShowNativeSelectMessages(quickToolbarSettings)')
    expect(selectBarIndex).toBeGreaterThan(gateIndex)
    expect(source.slice(gateIndex, selectBarIndex)).toContain('</button>')
  })

  test('InputArea removes the Suite connection picker and gear when the Suite is unavailable', async () => {
    const source = await Bun.file(resolve(import.meta.dir, 'InputArea.tsx')).text()

    expect(source).toContain("const hasLumiverseSuite = useStore((state) => hasEnabledFrontendExtension(state.extensions, 'lumiverse_suite'))")
    expect(source).toMatch(/connectionsPicker:\s*hasLumiverseSuite\s*\?\s*\(\(\)\s*=>/)
    expect(source).toContain('enableReorder={hasLumiverseSuite && enableToolbarIconReorder}')
    expect(source).toMatch(/\{hasLumiverseSuite && showComposerCustomizeGear && \(/)
    expect(source).toMatch(/\{hasLumiverseSuite && customizeOpen && \(/)
  })
})
