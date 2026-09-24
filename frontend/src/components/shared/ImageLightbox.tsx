import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { Copy, Download, Trash2 } from 'lucide-react'
import { Spinner } from '@/components/shared/Spinner'
import ContextMenu, { type ContextMenuEntry, type ContextMenuPos } from '@/components/shared/ContextMenu'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { useLongPress } from '@/hooks/useLongPress'
import { copyImageToClipboard } from '@/lib/clipboard'
import { downloadImageFromUrl } from '@/lib/downloads'
import {
  constrainImageLightboxZoom,
  pinchImageLightboxZoom,
  INITIAL_IMAGE_LIGHTBOX_ZOOM,
  type ImageLightboxPoint,
  type ImageLightboxZoom,
} from '@/lib/imageLightboxZoom'
import { toast } from '@/lib/toast'
import styles from './ImageLightbox.module.css'

interface ImageLightboxProps {
  src: string | null
  fallbackSrc?: string | null
  onClose: () => void
  /**
   * When provided, a "Delete" entry is added to the right-click / long-press
   * menu. The callback performs the actual deletion; the lightbox handles the
   * confirmation prompt and closes itself once the promise resolves. Throw to
   * surface a failure toast.
   */
  onDelete?: () => void | Promise<void>
  /** Overrides the delete confirmation title (e.g. "Discard this image?"). */
  deleteTitle?: string
  /** Overrides the delete confirmation body copy. */
  deleteMessage?: string
  /** Filename for the Download action (extension is appended automatically if absent). */
  downloadFilename?: string
}

export default function ImageLightbox({
  src,
  fallbackSrc,
  onClose,
  onDelete,
  deleteTitle,
  deleteMessage,
  downloadFilename,
}: ImageLightboxProps) {
  const { t } = useTranslation('shared', { keyPrefix: 'imageLightbox' })
  const [currentSrc, setCurrentSrc] = useState(src)
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [menuPos, setMenuPos] = useState<ContextMenuPos | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [imageZoom, setImageZoom] = useState(INITIAL_IMAGE_LIGHTBOX_ZOOM)
  const zoomRef = useRef(INITIAL_IMAGE_LIGHTBOX_ZOOM)
  const imageRef = useRef<HTMLImageElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const pinchStartRef = useRef<{ distance: number; point: ImageLightboxPoint; zoom: ImageLightboxZoom } | null>(null)
  const panPointRef = useRef<ImageLightboxPoint | null>(null)

  // Mirror the overlay states into refs so the document-level Escape and
  // backdrop handlers can tell when an inner layer (menu / confirm dialog)
  // owns the interaction and should swallow it instead of closing the lightbox.
  const menuOpenRef = useRef(false)
  const confirmingRef = useRef(false)
  menuOpenRef.current = menuPos !== null
  confirmingRef.current = confirmingDelete

  useEffect(() => {
    setCurrentSrc(src)
    if (src) {
      setIsLoading(true)
      setHasError(false)
    } else {
      setMenuPos(null)
      setConfirmingDelete(false)
      setDeleting(false)
    }
  }, [src, fallbackSrc])

  useEffect(() => {
    zoomRef.current = INITIAL_IMAGE_LIGHTBOX_ZOOM
    setImageZoom(INITIAL_IMAGE_LIGHTBOX_ZOOM)
    pinchStartRef.current = null
    panPointRef.current = null
  }, [currentSrc])

  useEffect(() => {
    if (!src) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Let an open menu / confirm dialog handle Escape themselves.
      if (menuOpenRef.current || confirmingRef.current) return
      onClose()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [src, onClose])

  const mouseDownTargetRef = useRef<EventTarget | null>(null)
  const menuOpenAtDownRef = useRef(false)

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      // A click that dismissed an open context menu shouldn't also close the
      // lightbox — swallow this one and let the next click through.
      if (menuOpenAtDownRef.current) {
        menuOpenAtDownRef.current = false
        return
      }
      if (e.target === e.currentTarget && mouseDownTargetRef.current === e.currentTarget) onClose()
    },
    [onClose]
  )

  const handleLoad = useCallback(() => setIsLoading(false), [])
  const handleError = useCallback(() => {
    if (fallbackSrc && currentSrc !== fallbackSrc) {
      setCurrentSrc(fallbackSrc)
      setIsLoading(true)
      setHasError(false)
      return
    }
    setIsLoading(false)
    setHasError(true)
  }, [currentSrc, fallbackSrc])

  const longPress = useLongPress({ onLongPress: (pos) => setMenuPos(pos) })

  const updateImageZoom = (zoom: ImageLightboxZoom) => {
    zoomRef.current = zoom
    setImageZoom(zoom)
  }

  const getZoomGeometry = () => {
    const image = imageRef.current
    const backdrop = backdropRef.current
    if (!image || !backdrop) return null
    const rect = backdrop.getBoundingClientRect()
    const uiScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lumiverse-ui-scale')) || 1
    return {
      uiScale,
      bounds: {
        imageWidth: image.offsetWidth,
        imageHeight: image.offsetHeight,
        viewportWidth: backdrop.clientWidth,
        viewportHeight: backdrop.clientHeight,
      },
      point: (clientX: number, clientY: number) => ({
        x: (clientX - rect.left - rect.width / 2) / uiScale,
        y: (clientY - rect.top - rect.height / 2) / uiScale,
      }),
    }
  }

  const startPinch = (touches: React.TouchList) => {
    const geometry = getZoomGeometry()
    if (!geometry) return
    pinchStartRef.current = {
      distance: Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY),
      point: geometry.point(
        (touches[0].clientX + touches[1].clientX) / 2,
        (touches[0].clientY + touches[1].clientY) / 2,
      ),
      zoom: zoomRef.current,
    }
    panPointRef.current = null
  }

  const handleImageTouchStart = (event: React.TouchEvent<HTMLImageElement>) => {
    if (event.touches.length > 1) {
      longPress.onTouchCancel()
      startPinch(event.touches)
      return
    }
    longPress.onTouchStart(event)
    if (zoomRef.current.scale > 1) {
      panPointRef.current = { x: event.touches[0].clientX, y: event.touches[0].clientY }
    }
  }

  const handleImageTouchMove = (event: React.TouchEvent<HTMLImageElement>) => {
    if (event.touches.length > 1) {
      longPress.onTouchCancel()
      if (!pinchStartRef.current) startPinch(event.touches)
      const start = pinchStartRef.current
      const geometry = getZoomGeometry()
      if (!start || !geometry) return
      const distance = Math.hypot(
        event.touches[0].clientX - event.touches[1].clientX,
        event.touches[0].clientY - event.touches[1].clientY,
      )
      const point = geometry.point(
        (event.touches[0].clientX + event.touches[1].clientX) / 2,
        (event.touches[0].clientY + event.touches[1].clientY) / 2,
      )
      updateImageZoom(pinchImageLightboxZoom(start.zoom, start.distance, distance, start.point, point, geometry.bounds))
      return
    }

    longPress.onTouchMove(event)
    if (event.touches.length !== 1 || zoomRef.current.scale <= 1) return
    const touch = event.touches[0]
    const previous = panPointRef.current
    panPointRef.current = { x: touch.clientX, y: touch.clientY }
    const geometry = getZoomGeometry()
    if (!previous || !geometry) return
    updateImageZoom(constrainImageLightboxZoom({
      ...zoomRef.current,
      x: zoomRef.current.x + (touch.clientX - previous.x) / geometry.uiScale,
      y: zoomRef.current.y + (touch.clientY - previous.y) / geometry.uiScale,
    }, geometry.bounds))
  }

  const handleImageTouchEnd = (event: React.TouchEvent<HTMLImageElement>) => {
    longPress.onTouchEnd(event)
    if (event.touches.length > 1) {
      startPinch(event.touches)
      return
    }
    pinchStartRef.current = null
    panPointRef.current = event.touches.length === 1
      ? { x: event.touches[0].clientX, y: event.touches[0].clientY }
      : null
  }

  const handleImageTouchCancel = () => {
    longPress.onTouchCancel()
    pinchStartRef.current = null
    panPointRef.current = null
  }

  const handleCopy = useCallback(async () => {
    setMenuPos(null)
    if (!currentSrc) return
    try {
      await copyImageToClipboard(currentSrc)
      toast.success(t('copied'))
    } catch {
      toast.error(t('copyFailed'))
    }
  }, [currentSrc, t])

  const handleDownload = useCallback(async () => {
    setMenuPos(null)
    if (!currentSrc) return
    try {
      await downloadImageFromUrl(currentSrc, downloadFilename)
    } catch {
      toast.error(t('downloadFailed'))
    }
  }, [currentSrc, downloadFilename, t])

  const handleConfirmDelete = useCallback(async () => {
    if (!onDelete) return
    setDeleting(true)
    try {
      await onDelete()
      setConfirmingDelete(false)
      onClose()
    } catch {
      toast.error(t('deleteFailed'))
    } finally {
      setDeleting(false)
    }
  }, [onDelete, onClose, t])

  const menuItems = useMemo<ContextMenuEntry[]>(() => {
    const items: ContextMenuEntry[] = [
      { key: 'copy', label: t('copyImage'), icon: <Copy size={14} />, onClick: () => { void handleCopy() } },
      { key: 'download', label: t('downloadImage'), icon: <Download size={14} />, onClick: () => { void handleDownload() } },
    ]
    if (onDelete) {
      items.push({ key: 'delete-divider', type: 'divider' })
      items.push({
        key: 'delete',
        label: t('deleteImage'),
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => { setMenuPos(null); setConfirmingDelete(true) },
      })
    }
    return items
  }, [t, onDelete, handleCopy, handleDownload])

  return createPortal(
    <>
      <AnimatePresence>
        {src && (
          <motion.div
            ref={backdropRef}
            className={styles.backdrop}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onMouseDown={(e) => {
              mouseDownTargetRef.current = e.target
              menuOpenAtDownRef.current = menuOpenRef.current
            }}
            onClick={handleBackdropClick}
          >
            {isLoading && (
              <div className={styles.spinner}>
                <Spinner size={32} />
              </div>
            )}
            {hasError ? (
              <div className={styles.error}>{t('loadFailed')}</div>
            ) : (
              <img
                ref={imageRef}
                src={currentSrc || ''}
                alt=""
                className={styles.image}
                style={{
                  opacity: isLoading ? 0 : 1,
                  transform: `translate3d(${imageZoom.x}px, ${imageZoom.y}px, 0) scale(${imageZoom.scale})`,
                }}
                draggable={false}
                onLoad={handleLoad}
                onError={handleError}
                onContextMenu={longPress.onContextMenu}
                onTouchStart={handleImageTouchStart}
                onTouchMove={handleImageTouchMove}
                onTouchEnd={handleImageTouchEnd}
                onTouchCancel={handleImageTouchCancel}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <ContextMenu position={menuPos} items={menuItems} onClose={() => setMenuPos(null)} />

      {onDelete && (
        <ConfirmationModal
          isOpen={confirmingDelete}
          onConfirm={() => { void handleConfirmDelete() }}
          onCancel={() => setConfirmingDelete(false)}
          title={deleteTitle ?? t('deleteTitle')}
          message={deleteMessage ?? t('deleteMessage')}
          variant="danger"
          confirmText={t('delete')}
          zIndex={11050}
          loading={deleting}
        />
      )}
    </>,
    document.body
  )
}
