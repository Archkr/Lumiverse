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

  test('ChatView restores native controls without mounting the Suite toolbar', async () => {
    const source = await Bun.file(resolve(import.meta.dir, 'ChatView.tsx')).text()

    expect(source).toContain("import { hasEnabledFrontendExtension } from '@/lib/spindle/frontend-extension-availability'")
    expect(source).toContain("const suiteExtensionEnabled = useStore((s) => hasEnabledFrontendExtension(s.extensions, 'lumiverse_suite'))")
    expect(source).toContain('ListChecks')
    expect(source).toContain('const showNativeSelectMessages = !suiteExtensionEnabled || isShowNativeSelectMessages(quickToolbarSettings)')
    expect(source).toContain('const showNativeScrollToTop = !suiteExtensionEnabled || isShowNativeScrollToTop(quickToolbarSettings)')
    expect(source).toContain('const showNativeBrowseMessages = !suiteExtensionEnabled || isShowNativeBrowseMessages(quickToolbarSettings)')
    expect(source).toContain("const dockQuickToolbar = suiteExtensionEnabled && quickToolbarPlacement === 'chat_top_dock'")
    expect(source).toContain('{dockQuickToolbar && <QuickToolbar />}')
    expect(source).toContain('hidden={suiteExtensionEnabled && !(dockQuickToolbar || keepFloatingDockHost)}')
    expect(source).toMatch(/aria-pressed=\{messageSelectMode\}/)
    expect(source).toMatch(/\{messageSelectMode && <MessageSelectBar chatId=\{chatId\} \/>\}/)

    const nativeButton = source.match(
      /\{showNativeSelectMessages && \([\s\S]*?<ListChecks size=\{14\} \/>[\s\S]*?<\/button>\s*\)\}/,
    )?.[0] ?? ''
    expect(nativeButton).toContain('aria-pressed={messageSelectMode}')
    expect(nativeButton).toContain('ListChecks')
    expect(nativeButton).not.toContain('MessageSelectBar')

    const selectBarIndex = source.indexOf('{messageSelectMode && <MessageSelectBar chatId={chatId} />}')
    const gateIndex = source.indexOf('{showNativeSelectMessages && (')
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
