import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconButton } from '../base/IconButton.js'
import { IconPaperclipOutline16 } from '../base/icons.js'
import { useIsMobile } from '../../app/viewport.js'
import styles from './AttachSheet.module.css'

const PANEL_WIDTH = 200
const PANEL_HEIGHT = 116

/** 相册图标：没有现成的图标组件，这里内联一个 */
const PhotoIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
    <rect x="1.75" y="3" width="14.5" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="6.4" cy="7.2" r="1.35" stroke="currentColor" strokeWidth="1.2" />
    <path
      d="M2.4 13.2l3.9-3.6a1.4 1.4 0 0 1 1.9 0l2.2 2 1.6-1.4a1.4 1.4 0 0 1 1.9 0l1.7 1.6"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </svg>
)

/**
 * 回形针：先问「上传文件」还是「从相册选择」，再触发对应的隐藏 input。
 * 浮层用 fixed 定位，不参与输入行布局，避免把发送按钮挤出去。
 */
export const AttachSheet = ({
  disabled,
  onPickFile,
  onPickImage,
}: {
  disabled?: boolean
  onPickFile: () => void
  onPickImage: () => void
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null)

  const close = () => {
    setOpen(false)
    setPosition(null)
  }

  const openSheet = () => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) {
      return
    }
    const width = Math.min(PANEL_WIDTH, window.innerWidth - 16)
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8)
    const bottom = Math.max(8, window.innerHeight - rect.top + 8)
    setPosition({ left, bottom })
    setOpen(true)
  }

  useEffect(() => {
    if (!open) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  const pick = (action: () => void) => {
    close()
    action()
  }

  return (
    <>
      <span ref={anchorRef} className={styles.anchor}>
        <IconButton
          size="m"
          tone="primary"
          icon={<IconPaperclipOutline16 />}
          tooltip={t('uploadFile')}
          disabled={disabled}
          onClick={() => (open ? close() : openSheet())}
        />
      </span>
      {open && position ? (
        <>
          <div className={styles.backdrop} onClick={close} />
          <div
            className={styles.panel}
            style={{
              left: `${position.left}px`,
              bottom: `${position.bottom}px`,
              width: `${Math.min(PANEL_WIDTH, window.innerWidth - 16)}px`,
              maxHeight: `calc(100vh - ${PANEL_HEIGHT + 24}px)`,
            }}
          >
            <button type="button" className={styles.option} onClick={() => pick(onPickFile)}>
              <span className={styles.optionIcon}>
                <IconPaperclipOutline16 />
              </span>
              <span className={styles.optionLabel}>{t('attachPickFile')}</span>
            </button>
            <button type="button" className={styles.option} onClick={() => pick(onPickImage)}>
              <span className={styles.optionIcon}>
                <PhotoIcon />
              </span>
              <span className={styles.optionLabel}>{t('attachPickImage')}</span>
            </button>
            {isMobile ? null : (
              <div className={styles.hint}>{t('attachPickHint')}</div>
            )}
          </div>
        </>
      ) : null}
    </>
  )
}
