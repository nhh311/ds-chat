import clsx from 'clsx'
import { useEffect } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { formatSize, getExtension } from '../../services/attachments.js'
import type { DraftAttachment } from '../../services/chat/drafts.js'
import { IconCheckOutline16, IconCloseOutline16 } from '../base/icons.js'
import { FileIcon } from '../files/FileIcon.js'
import styles from './AttachmentPreview.module.css'

/**
 * 附件预览：点开输入框里的附件先看内容，再决定要不要。
 * 右上角两个按钮：✓ 保留（关闭），✗ 删除（关闭并移除）。
 */
export const AttachmentPreview = ({
  item,
  status,
  error,
  onClose,
  onRemove,
}: {
  item: DraftAttachment
  status: 'uploading' | 'done' | 'error'
  error?: string
  onClose: () => void
  onRemove: () => void
}) => {
  const t = useTranslate()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const ext = getExtension(item.file.name)
  const statusText =
    status === 'uploading'
      ? t('uploadFileStatusUploading')
      : status === 'error'
        ? (error ?? t('uploadFileStatusFailed'))
        : [ext, formatSize(item.file.size)].filter(Boolean).join(' ')

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={t('attachPreview')}>
      <div className={styles.backdrop} onClick={onClose} />
      <div className={styles.sheet}>
        <div className={styles.header}>
          <button
            type="button"
            className={clsx(styles.action, styles.remove)}
            aria-label={t('attachPreviewRemove')}
            onClick={() => {
              onRemove()
              onClose()
            }}
          >
            <IconCloseOutline16 />
          </button>
          <div className={styles.title} title={item.file.name}>
            {item.file.name}
          </div>
          <button
            type="button"
            className={clsx(styles.action, styles.keep)}
            aria-label={t('attachPreviewKeep')}
            onClick={onClose}
          >
            <IconCheckOutline16 />
          </button>
        </div>
        <div className={styles.body}>
          {item.previewUrl ? (
            <img className={styles.image} src={item.previewUrl} alt={item.file.name} />
          ) : (
            <div className={styles.fileBox}>
              <FileIcon ext={ext} />
              <div className={styles.fileName}>{item.file.name}</div>
              <div className={styles.fileMeta}>{statusText}</div>
            </div>
          )}
        </div>
        {item.previewUrl ? <div className={styles.footer}>{statusText}</div> : null}
      </div>
    </div>
  )
}
