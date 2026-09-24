import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, createElement, forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
const globals = globalThis as unknown as Record<string, unknown>
const replacements = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  MouseEvent: dom.window.MouseEvent,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
}
const originals = Object.fromEntries(Object.keys(replacements).map(key => [key, globals[key]]))
Object.assign(globals, replacements)

mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
mock.module('motion/react', () => ({
  motion: {
    div: forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & {
      initial?: unknown
      animate?: unknown
      exit?: unknown
      transition?: unknown
    }>(function MotionDiv({ initial, animate, exit, transition, ...props }, ref) {
      return createElement('div', { ...props, ref })
    }),
  },
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
}))
mock.module('./ContextMenu', () => ({ default: () => null }))
mock.module('./ConfirmationModal', () => ({ default: () => null }))
mock.module('@/lib/toast', () => ({ toast: { success: () => {}, error: () => {} } }))

const { createRoot } = await import('react-dom/client')
const { default: ImageLightbox } = await import('./ImageLightbox')

let root: Root
let host: HTMLDivElement
let image: HTMLImageElement
let backdrop: HTMLDivElement

function touch(type: string, positions: Array<[number, number]>, target: Element = image) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', {
    value: positions.map(([clientX, clientY]) => ({ clientX, clientY })),
  })
  act(() => target.dispatchEvent(event))
}

beforeEach(async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(createElement(ImageLightbox, {
    src: 'https://lumiverse.test/first.png',
    onClose: () => {},
  })))
  image = document.querySelector('img')!
  backdrop = image.parentElement as HTMLDivElement
  Object.defineProperties(image, {
    offsetWidth: { configurable: true, value: 360 },
    offsetHeight: { configurable: true, value: 600 },
  })
  Object.defineProperties(backdrop, {
    clientWidth: { configurable: true, value: 400 },
    clientHeight: { configurable: true, value: 800 },
  })
  backdrop.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 800 }) as DOMRect
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.documentElement.style.removeProperty('--lumiverse-ui-scale')
})

afterAll(() => {
  mock.restore()
  Object.assign(globals, originals)
  dom.window.close()
})

describe('ImageLightbox image-only pinch zoom', () => {
  test('zooms the image, pans it after lifting one finger, and resets for another image', async () => {
    touch('touchstart', [[150, 400]])
    touch('touchstart', [[150, 400], [250, 400]])
    touch('touchmove', [[100, 400], [300, 400]])
    expect(image.style.transform).toContain('scale(2)')

    touch('touchend', [[300, 400]])
    touch('touchmove', [[350, 400]])
    expect(image.style.transform).toContain('translate3d(50px, 0px, 0)')
    touch('touchend', [])

    await act(async () => root.render(createElement(ImageLightbox, {
      src: 'https://lumiverse.test/second.png',
      onClose: () => {},
    })))
    expect(image.style.transform).toContain('scale(1)')
  })

  test('does not zoom the image when touches begin on the backdrop', () => {
    touch('touchstart', [[150, 400]], backdrop)
    touch('touchstart', [[150, 400], [250, 400]], backdrop)
    touch('touchmove', [[100, 400], [300, 400]], backdrop)
    expect(image.style.transform).toContain('scale(1)')
  })

  test('converts touch movement to layout pixels when the UI is scaled', () => {
    document.documentElement.style.setProperty('--lumiverse-ui-scale', '1.5')
    backdrop.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 1200 }) as DOMRect

    touch('touchstart', [[225, 600]])
    touch('touchstart', [[225, 600], [375, 600]])
    touch('touchmove', [[150, 600], [450, 600]])
    touch('touchend', [[450, 600]])
    touch('touchmove', [[525, 600]])

    expect(image.style.transform).toContain('translate3d(50px, 0px, 0)')
    expect(image.style.transform).toContain('scale(2)')
  })
})
