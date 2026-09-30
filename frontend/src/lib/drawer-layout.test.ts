import { describe, expect, test } from 'bun:test'
import type { DrawerLayoutItem } from '@/types/store'
import {
  createDefaultDrawerLayout,
  drawerLayoutItemKey,
  moveDrawerLayoutItem,
  reconcileDrawerLayout,
  removeDrawerLayoutContainer,
  sanitizeDrawerLayout,
} from './drawer-layout'

describe('drawer layout', () => {
  test('migrates the legacy split order into tabs + the default extension divider', () => {
    expect(createDefaultDrawerLayout({
      builtInIds: ['profile', 'lorebook'],
      extensionIds: ['macro', 'regex-plus'],
      legacyTabOrder: ['lorebook', 'profile', 'regex-plus', 'macro'],
    })).toEqual([
      { type: 'tab', tabId: 'lorebook' },
      { type: 'tab', tabId: 'profile' },
      { type: 'divider', id: 'extensions', label: 'Extensions' },
      { type: 'tab', tabId: 'regex-plus' },
      { type: 'tab', tabId: 'macro' },
    ])
  })

  test('keeps unavailable legacy tab IDs during first migration', () => {
    expect(createDefaultDrawerLayout({
      builtInIds: ['profile'],
      extensionIds: ['live-extension'],
      legacyTabOrder: ['profile', 'missing-extension', 'live-extension'],
    })).toEqual([
      { type: 'tab', tabId: 'profile' },
      { type: 'divider', id: 'extensions', label: 'Extensions' },
      { type: 'tab', tabId: 'missing-extension' },
      { type: 'tab', tabId: 'live-extension' },
    ])
  })

  test('preserves unavailable saved tabs and appends newly discovered tabs at root', () => {
    const layout: DrawerLayoutItem[] = [
      { type: 'folder', id: 'tools', name: 'Tools', children: ['macro-missing', 'regex'] },
      { type: 'divider', id: 'writing', label: 'Writing' },
      { type: 'tab', tabId: 'profile' },
    ]

    expect(reconcileDrawerLayout({
      layout,
      builtInIds: ['profile', 'lorebook'],
      extensionIds: ['regex', 'new-tool'],
    })).toEqual([
      { type: 'folder', id: 'tools', name: 'Tools', children: ['macro-missing', 'regex'] },
      { type: 'divider', id: 'writing', label: 'Writing' },
      { type: 'tab', tabId: 'profile' },
      { type: 'tab', tabId: 'lorebook' },
      { type: 'tab', tabId: 'new-tool' },
    ])
  })

  test('deduplicates tabs across root and folders while keeping first placement', () => {
    expect(sanitizeDrawerLayout([
      { type: 'tab', tabId: 'profile' },
      { type: 'folder', id: 'tools', name: 'Tools', children: ['profile', 'regex', 'regex'] },
      { type: 'tab', tabId: 'regex' },
    ])).toEqual([
      { type: 'tab', tabId: 'profile' },
      { type: 'folder', id: 'tools', name: 'Tools', children: ['regex'] },
    ])
  })

  test('moves a root tab into a folder', () => {
    const layout: DrawerLayoutItem[] = [
      { type: 'tab', tabId: 'profile' },
      { type: 'folder', id: 'tools', name: 'Tools', children: ['regex'] },
    ]
    expect(moveDrawerLayoutItem(layout, 'tab:profile', 'folder:tools')).toEqual([
      { type: 'folder', id: 'tools', name: 'Tools', children: ['regex', 'profile'] },
    ])
  })

  test('promotes a folder child to root when dropped on a root tab', () => {
    const layout: DrawerLayoutItem[] = [
      { type: 'tab', tabId: 'profile' },
      { type: 'folder', id: 'tools', name: 'Tools', children: ['regex', 'macro'] },
    ]
    expect(moveDrawerLayoutItem(layout, 'tab:regex', 'tab:profile')).toEqual([
      { type: 'tab', tabId: 'regex' },
      { type: 'tab', tabId: 'profile' },
      { type: 'folder', id: 'tools', name: 'Tools', children: ['macro'] },
    ])
  })

  test('moves a tab between folders using a child as the target', () => {
    const layout: DrawerLayoutItem[] = [
      { type: 'folder', id: 'one', name: 'One', children: ['a', 'b'] },
      { type: 'folder', id: 'two', name: 'Two', children: ['c'] },
    ]
    expect(moveDrawerLayoutItem(layout, 'tab:b', 'tab:c')).toEqual([
      { type: 'folder', id: 'one', name: 'One', children: ['a'] },
      { type: 'folder', id: 'two', name: 'Two', children: ['b', 'c'] },
    ])
  })

  test('reorders root dividers and folders without nesting them', () => {
    const layout: DrawerLayoutItem[] = [
      { type: 'divider', id: 'one' },
      { type: 'folder', id: 'tools', name: 'Tools', children: ['regex'] },
      { type: 'tab', tabId: 'profile' },
    ]
    expect(moveDrawerLayoutItem(layout, 'divider:one', 'tab:profile')).toEqual([
      { type: 'folder', id: 'tools', name: 'Tools', children: ['regex'] },
      { type: 'tab', tabId: 'profile' },
      { type: 'divider', id: 'one' },
    ])
  })

  test('root-end drop promotes a folder child to the end of the root list', () => {
    const layout: DrawerLayoutItem[] = [
      { type: 'folder', id: 'tools', name: 'Tools', children: ['regex', 'macro'] },
      { type: 'tab', tabId: 'profile' },
    ]
    expect(moveDrawerLayoutItem(layout, 'tab:regex', 'drawer-layout:root-end')).toEqual([
      { type: 'folder', id: 'tools', name: 'Tools', children: ['macro'] },
      { type: 'tab', tabId: 'profile' },
      { type: 'tab', tabId: 'regex' },
    ])
  })

  test('deleting a folder spills its children back into the same root position', () => {
    const layout: DrawerLayoutItem[] = [
      { type: 'tab', tabId: 'profile' },
      { type: 'folder', id: 'tools', name: 'Tools', children: ['regex', 'macro'] },
      { type: 'divider', id: 'after' },
    ]
    expect(removeDrawerLayoutContainer(layout, drawerLayoutItemKey(layout[1]))).toEqual([
      { type: 'tab', tabId: 'profile' },
      { type: 'tab', tabId: 'regex' },
      { type: 'tab', tabId: 'macro' },
      { type: 'divider', id: 'after' },
    ])
  })
})
