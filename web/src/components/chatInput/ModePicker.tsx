import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { IconCheckOutline16, IconChevronDownOutline14 } from '../base/icons.js'
import {
  normalizeEffort,
  setEffort,
  setMode,
  useSettings,
  type ChatMode,
  type ThinkingEffort,
} from '../../services/settings.js'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import styles from './ModePicker.module.css'

/** 三种聊天模式：快速最省、标准带联网、深度开思考 */
const MODES: { value: ChatMode; label: TranslationKey; hint: TranslationKey }[] = [
  { value: 'fast', label: 'modeFast', hint: 'modeFastHint' },
  { value: 'standard', label: 'modeStandard', hint: 'modeStandardHint' },
  { value: 'deep', label: 'modeDeep', hint: 'modeDeepHint' },
]

/**
 * 深度思考的强度档位：Off / Low / High / Max。
 * 服务端只区分 low / high / max（medium 与 xhigh 都映射成 high），
 * 所以「中」这种名不副实的档位已经删掉，换成真正有效的「关闭」。
 */
const EFFORTS: { value: ThinkingEffort; label: TranslationKey }[] = [
  { value: 'off', label: 'effortOff' },
  { value: 'low', label: 'effortLow' },
  { value: 'high', label: 'effortHigh' },
  { value: 'max', label: 'effortMax' },
]

const PANEL_WIDTH = 232

type Panel = 'mode' | 'effort' | null

/**
 * 聊天模式选择。
 *
 * 移动端只占一个胶囊（当前模式的文字 + 小箭头），点开才出现「快速 / 标准 /
 * 深度思考」；选了深度思考，旁边再出现一个独立的强度胶囊（低/中/高/最高）。
 * 两个弹层都是 fixed 定位的浮层，不参与这一行的布局，所以不会把语音、
 * 附件、发送这些按钮挤走，也不会让图标消失。
 */
export const ModePicker = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const mode = useSettings((state) => state.mode)
  const effort = useSettings((state) => state.effort)
  const [panel, setPanel] = useState<Panel>(null)
  const [box, setBox] = useState<{ left: number; bottom: number } | null>(null)
  /** 选了深度思考后，自动把强度弹层接着弹出来 */
  const [openEffortNext, setOpenEffortNext] = useState(false)
  const modeRef = useRef<HTMLButtonElement>(null)
  const effortRef = useRef<HTMLButtonElement>(null)

  const modeLabel = t(MODES.find((item) => item.value === mode)?.label ?? 'modeStandard')
  const effortValue = normalizeEffort(effort)
  const effortLabel = t(EFFORTS.find((item) => item.value === effortValue)?.label ?? 'effortHigh')

  const close = () => {
    setPanel(null)
    setBox(null)
  }

  const openPanel = (which: 'mode' | 'effort') => {
    const anchor = which === 'mode' ? modeRef.current : effortRef.current
    if (!anchor) {
      return
    }
    const rect = anchor.getBoundingClientRect()
    const maxLeft = Math.max(8, window.innerWidth - PANEL_WIDTH - 8)
    setBox({
      left: Math.min(Math.max(8, rect.left), maxLeft),
      // 从锚点上方展开；视口太矮时至少留 8px
      bottom: Math.max(8, window.innerHeight - rect.top + 8),
    })
    setPanel(which)
  }

  const togglePanel = (which: 'mode' | 'effort') => {
    if (panel === which) {
      close()
    } else {
      openPanel(which)
    }
  }

  // 模式切到深度思考后，强度胶囊是这一帧才出现的，等它渲染完再定位
  useEffect(() => {
    if (!openEffortNext || mode !== 'deep') {
      return
    }
    setOpenEffortNext(false)
    const frame = requestAnimationFrame(() => openPanel('effort'))
    return () => cancelAnimationFrame(frame)
  }, [openEffortNext, mode])

  const chooseMode = (value: ChatMode) => {
    setMode(value)
    if (value === 'deep' && mode !== 'deep') {
      setOpenEffortNext(true)
    }
    close()
  }

  const chooseEffort = (value: ThinkingEffort) => {
    setEffort(value)
    close()
  }

  const panelBody =
    panel === 'mode' ? (
      <div className={styles.panel} style={box ?? undefined} role="menu">
        <div className={styles.panelTitle}>{t('chatMode')}</div>
        {MODES.map((item) => (
          <button
            key={item.value}
            type="button"
            role="menuitemradio"
            aria-checked={mode === item.value}
            className={clsx(styles.option, mode === item.value && styles.optionActive)}
            onClick={() => chooseMode(item.value)}
          >
            <span className={styles.optionText}>
              <span className={styles.optionLabel}>{t(item.label)}</span>
              <span className={styles.optionHint}>{t(item.hint)}</span>
            </span>
            {mode === item.value ? <IconCheckOutline16 /> : null}
          </button>
        ))}
      </div>
    ) : panel === 'effort' ? (
      <div className={styles.panel} style={box ?? undefined} role="menu">
        <div className={styles.panelTitle}>{t('thinkingEffort')}</div>
        {EFFORTS.map((item) => (
          <button
            key={item.value}
            type="button"
            role="menuitemradio"
            aria-checked={effortValue === item.value}
            className={clsx(styles.option, effortValue === item.value && styles.optionActive)}
            onClick={() => chooseEffort(item.value)}
          >
            <span className={styles.optionText}>
              <span className={styles.optionLabel}>{t(item.label)}</span>
            </span>
            {effortValue === item.value ? <IconCheckOutline16 /> : null}
          </button>
        ))}
      </div>
    ) : null

  return (
    <>
      {isMobile ? (
        <div className={styles.pills}>
          <button
            ref={modeRef}
            type="button"
            className={clsx(styles.pill, panel === 'mode' && styles.pillOpen)}
            aria-haspopup="menu"
            aria-expanded={panel === 'mode'}
            aria-label={t('chatMode')}
            onClick={() => togglePanel('mode')}
          >
            <span>{modeLabel}</span>
            <IconChevronDownOutline14 />
          </button>
          {mode === 'deep' ? (
            <button
              ref={effortRef}
              type="button"
              className={clsx(styles.pill, styles.effortPill, panel === 'effort' && styles.pillOpen)}
              aria-haspopup="menu"
              aria-expanded={panel === 'effort'}
              aria-label={t('thinkingEffort')}
              onClick={() => togglePanel('effort')}
            >
              <span>{effortLabel}</span>
              <IconChevronDownOutline14 />
            </button>
          ) : null}
        </div>
      ) : (
        <div className={styles.desktopToggles}>
          {MODES.map((item) => (
            <button
              key={item.value}
              type="button"
              title={t(item.hint)}
              className={clsx(styles.toggle, mode === item.value && styles.toggleSelected)}
              aria-label={t(item.label)}
              aria-pressed={mode === item.value}
              onClick={() => setMode(item.value)}
            >
              <span>{t(item.label)}</span>
            </button>
          ))}
          {mode === 'deep' ? (
            <div className={styles.desktopEffort}>
              <button
                ref={effortRef}
                type="button"
                className={clsx(styles.toggle, styles.toggleSelected)}
                aria-haspopup="menu"
                aria-expanded={panel === 'effort'}
                aria-label={t('thinkingEffort')}
                onClick={() => togglePanel('effort')}
              >
                <span>{effortLabel}</span>
                <IconChevronDownOutline14 />
              </button>
            </div>
          ) : null}
        </div>
      )}
      {panelBody ? (
        <>
          <div className={styles.backdrop} onClick={close} aria-hidden />
          {panelBody}
        </>
      ) : null}
    </>
  )
}
