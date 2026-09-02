import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Image as ImageIcon } from 'lucide-react'
import { CloseButton } from '@/components/shared/CloseButton'
import { ModalShell } from '@/components/shared/ModalShell'
import { imagesApi } from '@/api/images'
import { getGreetingTitle } from '@/lib/greetingMetadata'
import type { Character } from '@/types/api'
import styles from './GreetingPickerModal.module.css'
import clsx from 'clsx'

interface GreetingPickerModalProps {
  character: Character
  activeContent?: string
  onSelect: (greetingIndex: number) => void
  onCancel: () => void
}

function containsImageMarkup(content: string): boolean {
  return /<img\b/i.test(content) || /!\[[^\]]*]\([^)]*\)/.test(content)
}

export default function GreetingPickerModal({
  character,
  activeContent,
  onSelect,
  onCancel,
}: GreetingPickerModalProps) {
  const { t } = useTranslation('modals')

  const greetings = [
    {
      label: getGreetingTitle(character.extensions, 0) || t('greetingPicker.defaultGreeting'),
      content: character.first_mes,
    },
    ...(character.alternate_greetings || []).map((g, i) => ({
      label: getGreetingTitle(character.extensions, i + 1)
        || t('greetingPicker.greetingNumber', { number: i + 2 }),
      content: g,
    })),
  ]

  const activeIndex = activeContent !== undefined
    ? greetings.findIndex((g) => g.content === activeContent)
    : -1

  const listRef = useRef<HTMLDivElement>(null)
  const activeCardRef = useRef<HTMLButtonElement>(null)
  const greetingBgs = (character.extensions?.greeting_backgrounds ?? {}) as Record<number, string>

  useEffect(() => {
    if (activeIndex < 0) return
    const list = listRef.current
    const card = activeCardRef.current
    if (!list || !card) return
    const target = card.offsetTop - (list.clientHeight - card.clientHeight) / 2
    list.scrollTop = Math.max(0, target)
  }, [activeIndex])

  return (
    <ModalShell isOpen onClose={onCancel} maxWidth={620} maxHeight="80vh" className={styles.modal}>
      <CloseButton onClick={onCancel} variant="solid" position="absolute" className={styles.closeBtnPos} />

      <div className={styles.header}>
        <h3 className={styles.title}>{t('greetingPicker.title')}</h3>
        <span className={styles.count}>{t('greetingPicker.count', { count: greetings.length })}</span>
      </div>

      <div ref={listRef} className={styles.list}>
        {greetings.map((g, i) => {
          const isActive = i === activeIndex
          const hasImage = containsImageMarkup(g.content)
          return (
            <button
              key={i}
              ref={isActive ? activeCardRef : undefined}
              type="button"
              className={clsx(styles.card, isActive && styles.cardActive)}
              onClick={() => onSelect(i)}
              style={{ animationDelay: `${Math.min(i * 40, 200)}ms` }}
            >
              {greetingBgs[i] && (
                <div className={styles.cardBanner} aria-hidden="true">
                  <img src={imagesApi.smallUrl(greetingBgs[i])} alt="" loading="lazy" />
                </div>
              )}
              <div className={styles.cardHeader}>
                <span className={styles.cardLabel}>{g.label}</span>
                <span className={styles.badgeRow}>
                  {hasImage && (
                    <span className={styles.mediaBadge}>
                      <ImageIcon size={10} />
                      {t('greetingPicker.image')}
                    </span>
                  )}
                  {isActive && (
                    <span className={styles.activeBadge}>
                      <Check size={10} />
                      {t('greetingPicker.active')}
                    </span>
                  )}
                </span>
              </div>
              <div className={styles.cardPreview}>{g.content}</div>
            </button>
          )
        })}
      </div>
    </ModalShell>
  )
}
