import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import {
  act,
  createElement,
  forwardRef,
  type ReactNode,
} from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const dom = new JSDOM(
  '<!doctype html><html><body></body></html>',
  {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  },
)

const originalWindow = globalThis.window
const originalDocument = globalThis.document
const originalElement = globalThis.Element
const originalHTMLElement = globalThis.HTMLElement
const originalNode = globalThis.Node
const originalEvent = globalThis.Event
const originalMouseEvent = globalThis.MouseEvent
const originalNavigator = globalThis.navigator

let storeState: Record<string, unknown> = {}

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

mock.module('@/store', () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(storeState),
}))

mock.module('@/api/regex', () => ({
  regexApi: {
    testRegex: async () => ({ result: '', matches: 0 }),
  },
}))

mock.module('@/lib/toast', () => ({
  toast: { error: () => {}, success: () => {} },
}))

mock.module('@/hooks/useFolders', () => ({
  useFolders: () => ({ folders: [], createFolder: () => {} }),
}))

mock.module('@/components/shared/ModalShell', () => ({
  ModalShell: ({
    isOpen,
    children,
  }: {
    isOpen: boolean
    children: ReactNode
  }) =>
    isOpen
      ? createElement('div', { 'data-testid': 'modal' }, children)
      : null,
}))

mock.module('@/components/shared/FormComponents', () => ({
  Button: (props: any) =>
    createElement(
      'button',
      { type: 'button', onClick: props.onClick },
      props.children,
    ),
}))

mock.module('@/components/shared/CloseButton', () => ({
  CloseButton: (props: any) =>
    createElement('button', { type: 'button', onClick: props.onClick }, 'Close'),
}))

mock.module('@/components/shared/ExpandedTextEditor', () => ({
  ExpandableTextarea: forwardRef((props: any, _ref: unknown) =>
    createElement('textarea', {
      value: props.value,
      onChange: (event: any) => props.onChange(event.target.value),
    })),
}))

mock.module('@/components/shared/Toggle', () => ({
  Toggle: (props: any) =>
    createElement('input', {
      type: 'checkbox',
      checked: !!props.checked,
      onChange: () => props.onChange?.(!props.checked),
    }),
}))

mock.module('@/components/shared/FolderDropdown', () => ({
  default: () => createElement('div'),
}))

mock.module('lucide-react', () => {
  const Icon = () => createElement('span')
  return {
    ChevronDown: Icon,
    ChevronRight: Icon,
    Plus: Icon,
    Trash2: Icon,
  }
})

mock.module('./RegexEditorModal.module.css', () => ({
  default: new Proxy(
    {},
    { get: (_target, key) => String(key) },
  ),
}))

let RegexEditorModal: typeof import('./RegexEditorModal').default

beforeAll(async () => {
  const domWindow =
    dom.window as unknown as Window & typeof globalThis

  Object.assign(globalThis, {
    window: domWindow,
    document: domWindow.document,
    Element: domWindow.Element,
    HTMLElement: domWindow.HTMLElement,
    Node: domWindow.Node,
    Event: domWindow.Event,
    MouseEvent: domWindow.MouseEvent,
  })

  Object.defineProperty(
    globalThis,
    'navigator',
    {
      configurable: true,
      value: domWindow.navigator,
    },
  )

  ;(
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT: boolean
    }
  ).IS_REACT_ACT_ENVIRONMENT = true

  RegexEditorModal = (await import('./RegexEditorModal')).default
})

afterAll(() => {
  Object.assign(globalThis, {
    window: originalWindow,
    document: originalDocument,
    Element: originalElement,
    HTMLElement: originalHTMLElement,
    Node: originalNode,
    Event: originalEvent,
    MouseEvent: originalMouseEvent,
  })

  Object.defineProperty(
    globalThis,
    'navigator',
    {
      configurable: true,
      value: originalNavigator,
    },
  )
})

function makeScript(findRegex: string) {
  return {
    id: 'script-1',
    user_id: 'user',
    name: 'Test script',
    script_id: 'test_script',
    find_regex: findRegex,
    replace_string: '$1',
    actions: [],
    flags: 'g',
    placement: ['ai_output'],
    scope: 'global',
    scope_id: null,
    target: ['display'],
    min_depth: null,
    max_depth: null,
    trim_strings: [],
    run_on_edit: false,
    substitute_macros: 'none',
    disabled: false,
    sort_order: 0,
    description: '',
    folder: '',
    metadata: {},
    created_at: 0,
    updated_at: 0,
  }
}

function seedStore(
  findRegex: string,
  updateSpy: ReturnType<typeof mock>,
  closeSpy: ReturnType<typeof mock>,
) {
  storeState = {
    modalProps: { scriptId: 'script-1' },
    regexScripts: [makeScript(findRegex)],
    updateRegexScript: updateSpy,
    closeModal: closeSpy,
    activeCharacterId: null,
    activeChatId: null,
  }
}

async function renderModal(): Promise<{
  container: HTMLElement
  root: ReturnType<typeof createRoot>
}> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(RegexEditorModal))
  })
  return { container, root }
}

async function waitFor(
  container: HTMLElement,
  predicate: () => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  throw new Error(
    `Timed out waiting for condition. Rendered: ${container.textContent}`,
  )
}

async function clickSave(container: HTMLElement): Promise<void> {
  const saveButton = Array.from(
    container.querySelectorAll('button'),
  ).find((button) => button.textContent === 'actions.save')
  expect(saveButton).toBeDefined()
  await act(async () => {
    saveButton!.dispatchEvent(
      new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('RegexEditorModal risk banner', () => {
  let updateSpy: ReturnType<typeof mock>
  let closeSpy: ReturnType<typeof mock>

  beforeEach(() => {
    updateSpy = mock(async () => {})
    closeSpy = mock(() => {})
  })

  test(
    'benign pattern saves and closes without a warning banner',
    async () => {
      seedStore('\\bfoo\\b', updateSpy, closeSpy)
      const { container, root } = await renderModal()
      try {
        await clickSave(container)
        await waitFor(container, () => closeSpy.mock.calls.length === 1)
        expect(updateSpy.mock.calls.length).toBe(1)
        expect(
          container.querySelector('[data-testid="regex-risk-banner"]'),
        ).toBeNull()
      } finally {
        await act(async () => {
          root.unmount()
        })
        container.remove()
      }
    },
  )

  test(
    'risky pattern shows a non-blocking banner on first save, closes on confirmed second save',
    async () => {
      seedStore('DATE:\\s*([^|]*)\\s*\\|', updateSpy, closeSpy)
      const { container, root } = await renderModal()
      try {
        await clickSave(container)
        await waitFor(
          container,
          () =>
            !!container.querySelector('[data-testid="regex-risk-banner"]'),
        )
        expect(updateSpy.mock.calls.length).toBe(1)
        expect(closeSpy.mock.calls.length).toBe(0)
        expect(container.textContent).toContain(
          'capture boundary is ambiguous',
        )

        const savedMetadata = (updateSpy.mock.calls[0][1] as any).metadata
        expect(savedMetadata.analyzer_risk.risk).toBe('high')
        expect(Array.isArray(savedMetadata.analyzer_risk.reasons)).toBe(true)

        await clickSave(container)
        await waitFor(container, () => closeSpy.mock.calls.length === 1)
      } finally {
        await act(async () => {
          root.unmount()
        })
        container.remove()
      }
    },
  )
})
