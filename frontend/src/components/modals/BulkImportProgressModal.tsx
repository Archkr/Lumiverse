import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, XCircle, SkipForward } from 'lucide-react'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import { charactersApi } from '@/api/characters'
import type { Character, BulkImportResultItem } from '@/types/api'
import styles from './BulkImportProgressModal.module.css'

const JOB_POLL_INTERVAL_MS = 250

interface BulkImportProgressModalProps {
  isOpen: boolean
  files: File[]
  onComplete: (imported: Character[], lorebookCharacters: LorebookInfo[]) => void
  onClose: () => void
}

export interface LorebookInfo {
  characterId: string
  characterName: string
  lorebookName: string
  entryCount: number
}

export default function BulkImportProgressModal({
  isOpen,
  files,
  onComplete,
  onClose,
}: BulkImportProgressModalProps) {
  const { t } = useTranslation('modals')
  const { t: tc } = useTranslation('common')
  const [processed, setProcessed] = useState(0)
  const [results, setResults] = useState<BulkImportResultItem[]>([])
  const [currentFile, setCurrentFile] = useState('')
  const [done, setDone] = useState(false)
  const [skipDuplicates, setSkipDuplicates] = useState(false)
  const [started, setStarted] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'processing'>('idle')
  const cancelledRef = useRef(false)
  const activeJobIdRef = useRef<string | null>(null)
  const uploadAbortRef = useRef<AbortController | null>(null)
  const resultsEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isOpen && files.length > 0) {
      setProcessed(0)
      setResults([])
      setCurrentFile('')
      setDone(false)
      setStarted(false)
      setPhase('idle')
      cancelledRef.current = false
      activeJobIdRef.current = null
      uploadAbortRef.current = null
    }
  }, [isOpen, files])

  useEffect(() => {
    resultsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [results.length])

  const startImport = useCallback(async () => {
    setStarted(true)
    setPhase('uploading')
    setProcessed(0)
    let allResults: BulkImportResultItem[] = []

    try {
      const created = await charactersApi.createImportJob(files.length, skipDuplicates)
      activeJobIdRef.current = created.jobId

      // One raw file per request keeps both the browser and Bun working sets
      // bounded. The server streams each body to disk before parsing begins.
      for (let i = 0; i < files.length; i++) {
        if (cancelledRef.current) throw new DOMException('Import cancelled', 'AbortError')
        setCurrentFile(files[i].name)
        const controller = new AbortController()
        uploadAbortRef.current = controller
        await charactersApi.uploadImportJobFile(created.jobId, i, files[i], controller.signal)
        uploadAbortRef.current = null
        setProcessed(i + 1)
      }

      setPhase('processing')
      setProcessed(0)
      setCurrentFile(files[0]?.name || '')
      await charactersApi.startImportJob(created.jobId)

      while (true) {
        const snapshot = await charactersApi.getImportJob(created.jobId)
        allResults = snapshot.results
        setResults(snapshot.results)
        setProcessed(snapshot.processed)
        setCurrentFile(snapshot.processed < files.length ? files[snapshot.processed].name : '')

        if (snapshot.status === 'complete' || snapshot.status === 'cancelled' || snapshot.status === 'error') {
          if (snapshot.status === 'error') {
            throw new Error(snapshot.error || t('bulkImport.requestFailed'))
          }
          break
        }
        await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS))
      }

      const imported = allResults
        .filter((r) => r.success && !r.skipped && r.character)
        .map((r) => r.character!)

      const lorebookChars: LorebookInfo[] = allResults
        .filter((r) => r.success && !r.skipped && r.character && r.lorebook)
        .map((r) => ({
          characterId: r.character!.id,
          characterName: r.character!.name,
          lorebookName: r.lorebook!.name,
          entryCount: r.lorebook!.entryCount,
        }))

      onComplete(imported, lorebookChars)
    } catch (err: any) {
      if (!cancelledRef.current) {
        const errorMessage = err?.body?.error || err?.body?.message || err?.message || t('bulkImport.requestFailed')
        if (allResults.length === 0) {
          allResults = files.map((file) => ({ filename: file.name, success: false, error: errorMessage }))
          setResults(allResults)
          setProcessed(files.length)
        }
        const jobId = activeJobIdRef.current
        if (jobId) void charactersApi.cancelImportJob(jobId).catch(() => {})
      }
    } finally {
      uploadAbortRef.current = null
      activeJobIdRef.current = null
      setDone(true)
      setCurrentFile('')
    }
  }, [files, skipDuplicates, onComplete, t])

  const handleCancel = useCallback(() => {
    if (done) {
      onClose()
    } else {
      cancelledRef.current = true
      uploadAbortRef.current?.abort()
      const jobId = activeJobIdRef.current
      if (jobId) void charactersApi.cancelImportJob(jobId).catch(() => {})
    }
  }, [done, onClose])

  const total = files.length
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0
  const successCount = results.filter((r) => r.success && !r.skipped).length
  const skippedCount = results.filter((r) => r.skipped).length
  const errorCount = results.filter((r) => !r.success).length

  // Detail line for a successful import: combine the embedded lorebook entry
  // count and the portable LoRA reference, whichever are present.
  const successDetail = (r: BulkImportResultItem): string =>
    [
      r.lorebook ? t('bulkImport.wiEntries', { count: r.lorebook.entryCount }) : null,
      r.lumiverse_lora
        ? t('bulkImport.loraReference', { name: r.lumiverse_lora.lora_filename, weight: r.lumiverse_lora.weight })
        : null,
    ]
      .filter(Boolean)
      .join(' · ')

  return (
    <ModalShell isOpen={isOpen} onClose={onClose} maxWidth={520} closeOnBackdrop={done} closeOnEscape={done}>
      <div className={styles.header}>
        <span className={styles.title}>
          {done ? t('bulkImport.complete') : started ? t('bulkImport.importing') : t('bulkImport.title')}
        </span>
        {done && (
          <CloseButton onClick={onClose} />
        )}
      </div>

      <div className={styles.body}>
        {!started && (
          <div className={styles.dedupToggle}>
            <Toggle.Checkbox
              checked={skipDuplicates}
              onChange={setSkipDuplicates}
              label={t('bulkImport.skipDuplicates')}
            />
          </div>
        )}

        <div className={styles.progressSection}>
          <div className={styles.progressLabel}>
            <span>
              {started
                ? done
                  ? t('bulkImport.done')
                  : phase === 'uploading'
                    ? t('bulkImport.uploading')
                    : t('bulkImport.processing')
                : t('bulkImport.filesSelected', { count: total })}
            </span>
            <span className={styles.progressCount}>
              {processed}/{total}
            </span>
          </div>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ transform: `scaleX(${pct / 100})` }} />
          </div>
          {currentFile && <div className={styles.currentFile}>{currentFile}</div>}
        </div>

        {results.length > 0 && (
          <>
            <div className={styles.resultsList}>
              {results.map((r, i) => (
                <div key={i} className={styles.resultItem}>
                  <span className={styles.resultIcon}>
                    {r.skipped ? (
                      <SkipForward size={14} className={styles.resultSkipped} />
                    ) : r.success ? (
                      <CheckCircle2 size={14} className={styles.resultSuccess} />
                    ) : (
                      <XCircle size={14} className={styles.resultError} />
                    )}
                  </span>
                  <span className={styles.resultName}>
                    {r.skipped
                      ? r.filename
                      : r.success
                        ? r.character?.name || r.filename
                        : r.filename}
                  </span>
                  <span className={styles.resultDetail}>
                    {r.skipped
                      ? t('bulkImport.duplicate')
                      : r.success
                        ? successDetail(r)
                        : r.error || t('bulkImport.failed')}
                  </span>
                </div>
              ))}
              <div ref={resultsEndRef} />
            </div>

            {done && (
              <div className={styles.summary}>
                <span className={styles.summaryItem}>
                  <span
                    className={styles.summaryDot}
                    style={{ background: 'var(--lumiverse-success, #22c55e)' }}
                  />
                  {t('bulkImport.imported', { count: successCount })}
                </span>
                {skippedCount > 0 && (
                  <span className={styles.summaryItem}>
                    <span
                      className={styles.summaryDot}
                      style={{ background: 'var(--lumiverse-warning, #f59e0b)' }}
                    />
                    {t('bulkImport.skipped', { count: skippedCount })}
                  </span>
                )}
                {errorCount > 0 && (
                  <span className={styles.summaryItem}>
                    <span
                      className={styles.summaryDot}
                      style={{ background: 'var(--lumiverse-danger, #ef4444)' }}
                    />
                    {t('bulkImport.failedCount', { count: errorCount })}
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className={styles.footer}>
        {!started ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {tc('actions.cancel')}
            </Button>
            <Button variant="primary" onClick={startImport}>
              {t('bulkImport.startImport')}
            </Button>
          </>
        ) : done ? (
          <Button variant="primary" onClick={onClose}>
            {tc('actions.close')}
          </Button>
        ) : (
          <Button variant="ghost" onClick={handleCancel}>
            {tc('actions.cancel')}
          </Button>
        )}
      </div>
    </ModalShell>
  )
}
