import { useRef, useState, useCallback, useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { ChevronRight, CircleHelp, Folder, Settings, Sparkles } from 'lucide-react'
import { useStore } from '@/store'
import useIsMobile from '@/hooks/useIsMobile'
import { CloseButton } from '@/components/shared/CloseButton'
import { GuideViewer } from '@/components/shared/GuideViewer'
import ContextMenu, { type ContextMenuEntry, type ContextMenuPos } from '@/components/shared/ContextMenu'
import { useLongPress } from '@/hooks/useLongPress'
import {
  DRAWER_TABS,
  adaptExtensionTabs,
  sanitizeHiddenDrawerTabIds,
  type DrawerTabEntry,
} from '@/lib/drawer-tab-registry'
import { reconcileDrawerLayout } from '@/lib/drawer-layout'
import { translateDrawerField } from '@/lib/i18n/resolveLabel'
import { useTranslation } from 'react-i18next'
import TabPanelContent from './TabPanelContent'
import styles from './ViewportDrawer.module.css'
import clsx from 'clsx'
import { filterEnabledFrontendContributions } from '@/lib/spindle/frontend-extension-availability'
import { useDrawerTabDrag } from '@/hooks/useDrawerTabDrag'

export default function ViewportDrawer() {
  const { t } = useTranslation('panels')
  const { t: ts } = useTranslation('settings')
  const drawerOpen = useStore((s) => s.drawerOpen)
  const drawerTab = useStore((s) => s.drawerTab)
  const openDrawer = useStore((s) => s.openDrawer)
  const closeDrawer = useStore((s) => s.closeDrawer)
  const setDrawerTab = useStore((s) => s.setDrawerTab)
  const openSettings = useStore((s) => s.openSettings)
  const openModal = useStore((s) => s.openModal)
  const setSetting = useStore((s) => s.setSetting)
  const settingsLoaded = useStore((s) => s.settingsLoaded)
  const drawerSettings = useStore((s) => s.drawerSettings)
  const drawerTabs = useStore((s) => s.drawerTabs)
  const extensions = useStore((s) => s.extensions)
  const hiddenPlacements = useStore((s) => s.hiddenPlacements)
  const isGroupChat = useStore((s) => s.isGroupChat)

  const isMobile = useIsMobile()
  const sidebarRef = useRef<HTMLDivElement>(null)
  const tabListRef = useRef<HTMLDivElement>(null)
  const panelContentRef = useRef<HTMLDivElement>(null)
  const [tabListScroll, setTabListScroll] = useState({ up: false, down: false })
  const [contextMenu, setContextMenu] = useState<ContextMenuPos | null>(null)
  const [guideOpen, setGuideOpen] = useState(false)
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null)

  const updateTabListScroll = useCallback(() => {
    const el = tabListRef.current
    if (!el) return
    setTabListScroll({
      up: el.scrollTop > 0,
      down: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
    })
  }, [])

  useEffect(() => {
    const el = tabListRef.current
    if (!el) return
    el.addEventListener('scroll', updateTabListScroll, { passive: true })
    const ro = new ResizeObserver(updateTabListScroll)
    ro.observe(el)
    updateTabListScroll()
    return () => {
      el.removeEventListener('scroll', updateTabListScroll)
      ro.disconnect()
    }
  }, [updateTabListScroll])

  const showTabLabels = drawerSettings.showTabLabels ?? true
  const hiddenTabIds = sanitizeHiddenDrawerTabIds(drawerSettings.hiddenTabIds)
  const hiddenTabIdsSet = useMemo(() => new Set(hiddenTabIds), [hiddenTabIds])
  const hiddenPlacementIdsSet = useMemo(() => new Set(hiddenPlacements), [hiddenPlacements])

  const updateDrawer = useCallback(
    (partial: Partial<typeof drawerSettings>) => {
      setSetting('drawerSettings', { ...drawerSettings, ...partial })
    },
    [drawerSettings, setSetting],
  )

  const commitDrawerTabPosition = useCallback((verticalPosition: number) => {
    const state = useStore.getState()
    state.setSetting(
      'drawerSettings',
      { ...state.drawerSettings, verticalPosition },
      'user-interaction',
    )
  }, [])

  const drawerTabDrag = useDrawerTabDrag({
    position: drawerSettings.verticalPosition,
    onCommit: commitDrawerTabPosition,
  })

  const enabledDrawerTabs = filterEnabledFrontendContributions(drawerTabs, extensions)
  const extensionEntries = useMemo(() => adaptExtensionTabs(enabledDrawerTabs), [enabledDrawerTabs])
  const extensionStateById = useMemo(
    () => new Map(enabledDrawerTabs.map((tab) => [tab.id, tab] as const)),
    [enabledDrawerTabs],
  )
  const tabEntryById = useMemo(
    () => new Map([...DRAWER_TABS, ...extensionEntries].map((tab) => [tab.id, tab] as const)),
    [extensionEntries],
  )
  const extensionIds = useMemo(() => new Set(extensionEntries.map((tab) => tab.id)), [extensionEntries])

  const layout = useMemo(() => reconcileDrawerLayout({
    layout: drawerSettings.layout,
    builtInIds: DRAWER_TABS.map((tab) => tab.id),
    extensionIds: extensionEntries.map((tab) => tab.id),
    legacyTabOrder: drawerSettings.tabOrder,
  }), [drawerSettings.layout, drawerSettings.tabOrder, extensionEntries])

  const isTabVisible = useCallback((tabId: string) => {
    if (!tabEntryById.has(tabId)) return false
    if (hiddenTabIdsSet.has(tabId)) return false
    if (extensionIds.has(tabId) && hiddenPlacementIdsSet.has(tabId)) return false
    return true
  }, [extensionIds, hiddenPlacementIdsSet, hiddenTabIdsSet, tabEntryById])

  const allTabs = useMemo(
    () => [...tabEntryById.values()].filter((tab) => isTabVisible(tab.id)),
    [isTabVisible, tabEntryById],
  )
  const requestedActiveTab = drawerTab || 'profile'
  const activeTab = allTabs.some((tab) => tab.id === requestedActiveTab) ? requestedActiveTab : 'profile'
  const activeTabConfig = tabEntryById.get(activeTab) ?? DRAWER_TABS[0]
  const activeFolder = activeFolderId
    ? layout.find((item) => item.type === 'folder' && item.id === activeFolderId)
    : undefined
  const activeFolderTabs = activeFolder?.type === 'folder'
    ? activeFolder.children
        .filter(isTabVisible)
        .map((tabId) => tabEntryById.get(tabId))
        .filter((entry): entry is DrawerTabEntry => Boolean(entry))
    : []

  const activeTabTitle =
    activeTab === 'profile' && isGroupChat
      ? t('group')
      : translateDrawerField(
          activeTabConfig.id,
          'tabHeaderTitle',
          activeTabConfig.tabHeaderTitle ?? activeTabConfig.tabName,
        )
  const panelTitle = activeFolder?.type === 'folder'
    ? activeFolder.name.trim() || t('viewportDrawer.folder', { defaultValue: 'Folder' })
    : activeTabTitle

  useEffect(() => {
    setGuideOpen(false)
  }, [activeTab, activeFolderId])

  useEffect(() => {
    // A direct host/command navigation to a tab should leave folder browsing.
    setActiveFolderId(null)
  }, [drawerTab])

  useEffect(() => {
    if (drawerTab && drawerTab !== activeTab) {
      setDrawerTab(activeTab)
    }
  }, [drawerTab, activeTab, setDrawerTab])

  const pendingActiveTabReset = useStore((s) => s.pendingActiveTabReset)
  const clearPendingReset = useStore((s) => s.clearPendingActiveTabReset)
  useEffect(() => {
    if (!pendingActiveTabReset) return
    const fallback = allTabs.find((tab) => tab.id !== pendingActiveTabReset)
    setDrawerTab(fallback?.id ?? 'profile')
    clearPendingReset()
  }, [pendingActiveTabReset, allTabs, setDrawerTab, clearPendingReset])

  const handleTabClick = useCallback(
    (tabId: string) => {
      setActiveFolderId(null)
      setDrawerTab(tabId)
      openDrawer(tabId)
    },
    [setDrawerTab, openDrawer],
  )

  const handleFolderClick = useCallback((folderId: string) => {
    setActiveFolderId(folderId)
    openDrawer()
  }, [openDrawer])

  const tabQuickMenu = useLongPress({
    onLongPress: (pos) => setContextMenu(pos),
  })

  const handleTabContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (e.defaultPrevented) return
      tabQuickMenu.onContextMenu(e)
    },
    [tabQuickMenu],
  )

  const contextMenuItems: ContextMenuEntry[] = [
    {
      key: 'toggle-labels',
      label: showTabLabels ? t('viewportDrawer.hideTabLabels') : t('viewportDrawer.showTabLabels'),
      danger: showTabLabels,
      onClick: () => {
        updateDrawer({ showTabLabels: !showTabLabels })
        setContextMenu(null)
      },
    },
    {
      key: 'configure-tabs',
      label: t('viewportDrawer.configureTabs'),
      onClick: () => {
        setContextMenu(null)
        openModal('configureTabs')
      },
    },
  ]

  const isRight = drawerSettings.side === 'right'
  const isCompact = drawerSettings.tabSize === 'compact'

  const panelWidthCSS = (() => {
    switch (drawerSettings.panelWidthMode) {
      case 'custom': return `${Math.max(20, Math.min(80, drawerSettings.customPanelWidth))}vw`
      default: return 'min(420px, calc(100vw - 64px))'
    }
  })()

  const renderTabButton = (tabId: string, options?: { organizedAnchor?: boolean }) => {
    const entry = tabEntryById.get(tabId)
    if (!entry || !isTabVisible(tabId)) return null
    const Icon = entry.tabIcon
    const extensionState = extensionStateById.get(tabId)
    const title = translateDrawerField(entry.id, 'tabName', entry.tabName)
    const shortName = translateDrawerField(entry.id, 'shortName', entry.shortName)
    const organizedAnchor = options?.organizedAnchor ?? false

    return (
      <button
        key={`${organizedAnchor ? 'organized-anchor' : 'tab'}:${tabId}`}
        type="button"
        className={clsx(
          styles.tabBtn,
          extensionIds.has(tabId) && styles.tabBtnExtension,
          showTabLabels && styles.tabBtnLabeled,
          !organizedAnchor && !activeFolder && activeTab === tabId && styles.tabBtnActive,
          organizedAnchor && styles.organizedTabAnchor,
        )}
        data-tab-id={tabId}
        onClick={organizedAnchor ? undefined : () => handleTabClick(tabId)}
        onContextMenu={organizedAnchor ? undefined : handleTabContextMenu}
        onTouchStart={organizedAnchor ? undefined : tabQuickMenu.onTouchStart}
        onTouchMove={organizedAnchor ? undefined : tabQuickMenu.onTouchMove}
        onTouchEnd={organizedAnchor ? undefined : tabQuickMenu.onTouchEnd}
        onTouchCancel={organizedAnchor ? undefined : tabQuickMenu.onTouchCancel}
        title={title}
        tabIndex={organizedAnchor ? -1 : undefined}
        aria-hidden={organizedAnchor || undefined}
      >
        <Icon size={20} strokeWidth={1.5} />
        {showTabLabels && <span className={styles.tabLabel}>{shortName}</span>}
        {extensionState?.badge && <span className={styles.tabBadge}>{extensionState.badge}</span>}
        <span data-spindle-mount="drawer_tab" data-spindle-scope={`drawer-tab:${tabId}`} style={{ display: 'contents' }} />
      </button>
    )
  }

  if (!settingsLoaded) return null

  return (
    <>
      <AnimatePresence>
        {isMobile && drawerOpen && (
          <motion.div
            className={styles.backdrop}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={closeDrawer}
          />
        )}
      </AnimatePresence>

      <div
        className={clsx(
          styles.wrapper,
          isCompact && styles.wrapperCompact,
          isRight ? styles.wrapperRight : styles.wrapperLeft,
          drawerOpen && styles.wrapperOpen,
        )}
        style={{ '--drawer-panel-w': panelWidthCSS } as React.CSSProperties}
      >
        <button
          type="button"
          className={clsx(
            styles.drawerTab,
            isCompact && styles.drawerTabCompact,
            drawerOpen && styles.drawerTabActive,
            drawerTabDrag.isDragging && styles.drawerTabDragging,
          )}
          onClick={(event) => {
            if (drawerTabDrag.consumeSuppressedClick(event)) return
            if (drawerOpen) closeDrawer()
            else openDrawer()
          }}
          style={{ marginTop: `${drawerTabDrag.verticalPosition}vh` }}
          {...drawerTabDrag.pointerHandlers}
        >
          <div className={styles.tabIconBox}>
            <Sparkles size={isCompact ? 14 : 16} />
          </div>
        </button>

        <div className={styles.drawer}>
          <div className={styles.sidebar} ref={sidebarRef} data-spindle-mount="sidebar">
            <span data-spindle-mount="sidebar_top" data-spindle-scope="drawer:sidebar-top" style={{ display: 'contents' }} />
            <div className={clsx(
              styles.tabListWrap,
              tabListScroll.up && styles.tabListScrollUp,
              tabListScroll.down && styles.tabListScrollDown,
            )}>
              <div className={styles.tabList} ref={tabListRef}>
                {layout.map((item) => {
                  if (item.type === 'divider') {
                    return (
                      <div
                        key={`divider:${item.id}`}
                        className={styles.tabDivider}
                        title={item.label || undefined}
                        aria-hidden="true"
                      />
                    )
                  }

                  if (item.type === 'tab') return renderTabButton(item.tabId)

                  const visibleChildren = item.children.filter(isTabVisible)
                  if (!visibleChildren.length) return null
                  const folderName = item.name.trim() || t('viewportDrawer.folder', { defaultValue: 'Folder' })
                  const folderActive = activeFolderId === item.id || (!activeFolder && item.children.includes(activeTab))

                  return (
                    <div key={`folder:${item.id}`} className={styles.folderSlot}>
                      <button
                        type="button"
                        className={clsx(
                          styles.tabBtn,
                          styles.folderTabBtn,
                          showTabLabels && styles.tabBtnLabeled,
                          folderActive && styles.tabBtnActive,
                        )}
                        onClick={() => handleFolderClick(item.id)}
                        onContextMenu={handleTabContextMenu}
                        onTouchStart={tabQuickMenu.onTouchStart}
                        onTouchMove={tabQuickMenu.onTouchMove}
                        onTouchEnd={tabQuickMenu.onTouchEnd}
                        onTouchCancel={tabQuickMenu.onTouchCancel}
                        title={`${folderName} · ${visibleChildren.length}`}
                      >
                        <Folder size={20} strokeWidth={1.5} />
                        {showTabLabels && <span className={styles.tabLabel}>{folderName}</span>}
                        <span className={styles.folderBadge}>{visibleChildren.length}</span>
                      </button>
                      <div className={styles.organizedTabAnchors} aria-hidden="true">
                        {visibleChildren.map((tabId) => renderTabButton(tabId, { organizedAnchor: true }))}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className={styles.sidebarBottom}>
              <span data-spindle-mount="sidebar_bottom" data-spindle-scope="drawer:sidebar-bottom" style={{ display: 'contents' }} />
              <button
                type="button"
                className={styles.tabBtn}
                onClick={() => openSettings()}
                title={ts('title', { defaultValue: 'Settings' })}
              >
                <Settings size={18} />
              </button>
            </div>
          </div>

          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <div className={styles.panelHeaderMain}>
                <h2 className={styles.panelTitle}>{panelTitle}</h2>

                {!activeFolder && activeTabConfig.guide && (
                  <button
                    type="button"
                    className={styles.guideButton}
                    onClick={() => setGuideOpen(true)}
                    aria-label={`Open guide for ${activeTabTitle}`}
                    title="Open guide"
                  >
                    <CircleHelp size={15} strokeWidth={1.7} />
                  </button>
                )}
              </div>

              <span className={styles.headerActions}>
                <span data-spindle-mount="drawer_header_actions" data-spindle-scope="drawer:header-actions" style={{ display: 'contents' }} />
              </span>
              <CloseButton onClick={closeDrawer} />
            </div>
            <div
              className={clsx(
                styles.panelContent,
                !activeFolder && (activeTab === 'loom' || activeTab === 'lumi' || activeTab === 'browser' || activeTab === 'lorebook') && styles.panelContentFull,
              )}
              ref={panelContentRef}
            >
              {activeFolder?.type === 'folder' ? (
                <div className={styles.folderPanel}>
                  <div className={styles.folderPanelIntro}>
                    <div>
                      <span className={styles.folderPanelEyebrow}>{t('viewportDrawer.sidebarFolder', { defaultValue: 'Sidebar folder' })}</span>
                      <p>{t('viewportDrawer.folderHint', { defaultValue: 'Choose a tab, or reorganize this folder from Configure Tabs.' })}</p>
                    </div>
                    <button type="button" className={styles.folderManageButton} onClick={() => openModal('configureTabs')}>
                      {t('viewportDrawer.configureTabs')}
                    </button>
                  </div>

                  {activeFolderTabs.length ? (
                    <div className={styles.folderGrid}>
                      {activeFolderTabs.map((entry) => {
                        const Icon = entry.tabIcon
                        return (
                          <button
                            key={entry.id}
                            type="button"
                            className={styles.folderTile}
                            onClick={() => handleTabClick(entry.id)}
                          >
                            <span className={styles.folderTileIcon}><Icon size={21} strokeWidth={1.6} /></span>
                            <span className={styles.folderTileCopy}>
                              <strong>{translateDrawerField(entry.id, 'tabName', entry.tabName)}</strong>
                              <span>{entry.tabDescription}</span>
                            </span>
                            <ChevronRight size={16} className={styles.folderTileChevron} />
                          </button>
                        )
                      })}
                    </div>
                  ) : (
                    <div className={styles.folderPanelEmpty}>
                      {t('viewportDrawer.folderEmpty', { defaultValue: 'This folder has no visible tabs right now.' })}
                    </div>
                  )}
                </div>
              ) : (
                <TabPanelContent tabId={activeTab} location={{ kind: 'main-drawer' }} />
              )}
            </div>
          </div>
          <span data-spindle-mount="drawer_footer" data-spindle-scope="drawer:footer" style={{ display: 'contents' }} />
        </div>
      </div>

      {!activeFolder && activeTabConfig.guide && (
        <GuideViewer
          isOpen={guideOpen}
          onClose={() => setGuideOpen(false)}
          guide={activeTabConfig.guide}
          title={activeTabTitle}
        />
      )}

      <ContextMenu
        position={contextMenu}
        items={contextMenuItems}
        onClose={() => setContextMenu(null)}
      />
    </>
  )
}
