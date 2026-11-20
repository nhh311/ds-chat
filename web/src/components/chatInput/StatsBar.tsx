import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '../../services/chat/store.js'
import {
  CONTEXT_LIMIT,
  contextParts,
  contextTokens,
  formatTokenCount,
  formatTokens,
  sessionTiming,
  sessionUsage,
} from '../../services/chat/usage.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './StatsBar.module.css'

const SIZE = 20
const STROKE = 2.4
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** 圆环与分段条配色：正常走主色，八成提醒、九成报警 */
const toneOf = (ratio: number): string => {
  if (ratio >= 0.9) {
    return 'var(--dsw-alias-state-error-primary)'
  }
  return ratio >= 0.8 ? 'var(--dsw-static-amber-500)' : 'var(--dsw-alias-brand-primary)'
}

/** 22毫秒 / 1.3秒 / 38分50秒 —— 面板里的时长统一这个写法 */
const formatDuration = (ms: number): string => {
  if (ms <= 0) {
    return '—'
  }
  if (ms < 1000) {
    return `${Math.round(ms)}毫秒`
  }
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) {
    return `${(ms / 1000).toFixed(1)}秒`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes >= 60 ? `${Math.floor(minutes / 60)}时${minutes % 60}分` : `${minutes}分${seconds}秒`
}

type Props = {
  /** 新对话（欢迎页）传 null，状态条显示为全零 */
  sessionId: string | null
}

/**
 * 底部状态条：轮数 · 输出速度 · 累计 token / 缓存命中 · 上下文占用小圆环。
 * 点一下弹出面板：会话统计、Token 用量、上下文构成三块，全部来自本地已有的 usage 与计时。
 */
export const StatsBar = ({ sessionId }: Props) => {
  const t = useTranslate()
  const session = useChatStore((state) => (sessionId ? state.sessionCache[sessionId] : undefined))
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState<{ left: number; bottom: number } | null>(null)
  const barRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const totals = sessionUsage(session)
  const timing = sessionTiming(session)
  const used = contextTokens(session)
  const ratio = Math.min(1, used / CONTEXT_LIMIT)
  const parts = contextParts(session)
  const tone = toneOf(ratio)
  const hasData = totals.total > 0

  const close = () => {
    setOpen(false)
    setBox(null)
  }

  const toggle = () => {
    if (open) {
      close()
      return
    }
    const rect = barRef.current?.getBoundingClientRect()
    if (!rect) {
      return
    }
    const width = 268
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8)
    setBox({ left, bottom: Math.max(8, window.innerHeight - rect.top + 6) })
    setOpen(true)
  }

  useEffect(() => {
    if (!open) {
      return
    }
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && (panelRef.current?.contains(target) || barRef.current?.contains(target))) {
        return
      }
      close()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close()
      }
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const share = (value: number) => (used > 0 ? Math.max((value / CONTEXT_LIMIT) * 100, value > 0 ? 0.4 : 0) : 0)

  return (
    <div className={styles.wrap}>
      <button
        ref={barRef}
        type="button"
        className={clsx(styles.bar, open && styles.barOpen)}
        aria-label={t('statsTitle')}
        aria-expanded={open}
        onClick={toggle}
      >
        <span className={styles.group}>
          <span className={styles.rounds}>{t('statsRounds', { rounds: timing.rounds, steps: timing.steps })}</span>
          {timing.tps !== null ? (
            <>
              <span className={styles.dot}>·</span>
              <span className={styles.speed}>{Math.round(timing.tps)} tok/s</span>
            </>
          ) : null}
        </span>
        <span className={styles.dot}>·</span>
        <span className={clsx(styles.group, styles.preferWide)}>
          <span className={styles.tokens}>
            {hasData ? `${formatTokens(totals.total)} tok` : '—'}
          </span>
          {hasData ? (
            <>
              <span className={styles.dot}>·</span>
              <span className={styles.hit}>
                {t('usageHitRate')} {Math.round(totals.hitRate * 100)}%
              </span>
            </>
          ) : null}
        </span>
        <span className={styles.dot}>·</span>
        <span className={styles.group}>
          <span className={styles.contextText}>
            {formatTokens(used)} / {formatTokens(CONTEXT_LIMIT)}
          </span>
          <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden className={styles.ring}>
            <circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke="var(--dsw-alias-border-l2)"
              strokeWidth={STROKE}
            />
            <circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke={tone}
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={`${CIRCUMFERENCE * ratio} ${CIRCUMFERENCE}`}
              transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
              className={styles.arc}
            />
          </svg>
          <span className={styles.percent}>{Math.round(ratio * 100)}%</span>
        </span>
      </button>
      {open && box ? (
        <>
          <div className={styles.backdrop} onClick={close} />
          <div ref={panelRef} className={styles.panel} role="dialog" style={box}>
            <div className={styles.section}>
              <div className={styles.sectionHead}>
                <span className={styles.sectionTitle}>{t('statsTitle')}</span>
                <span className={styles.sectionValue}>
                  {t('statsRounds', { rounds: timing.rounds, steps: timing.steps })}
                </span>
              </div>
              <div className={styles.rows}>
                <div className={styles.row}>
                  <span className={styles.label}>{t('statsModelTime')}</span>
                  <span className={styles.value}>{formatDuration(timing.modelMs)}</span>
                </div>
                <div className={styles.row}>
                  <span className={styles.label}>{t('statsToolTime')}</span>
                  <span className={styles.value}>{formatDuration(timing.toolMs)}</span>
                </div>
                <div className={styles.row}>
                  <span className={styles.label}>{t('statsTtft')}</span>
                  <span className={styles.value}>
                    {timing.ttftMs === null ? '—' : formatDuration(timing.ttftMs)}
                  </span>
                </div>
                <div className={styles.row}>
                  <span className={styles.label}>{t('statsTps')}</span>
                  <span className={styles.value}>
                    {timing.tps === null ? '—' : `${Math.round(timing.tps)} tok/s`}
                  </span>
                </div>
              </div>
            </div>

            <div className={styles.section}>
              <div className={styles.sectionHead}>
                <span className={styles.sectionTitle}>{t('usageTitle')}</span>
                <span className={styles.sectionValue}>
                  {formatTokenCount(totals.total)} tok
                </span>
              </div>
              <div className={styles.rows}>
                <div className={styles.row}>
                  <span className={styles.label}>{t('usageHitRate')}</span>
                  <span className={clsx(styles.value, styles.highlight)}>
                    {Math.round(totals.hitRate * 100)}%
                  </span>
                </div>
                <div className={styles.row}>
                  <span className={styles.label}>{t('usageUncached')}</span>
                  <span className={styles.value}>{formatTokenCount(totals.uncached)} tok</span>
                </div>
                {totals.cacheCreate > 0 ? (
                  <div className={styles.row}>
                    <span className={styles.label}>{t('usageCacheCreate')}</span>
                    <span className={styles.value}>{formatTokenCount(totals.cacheCreate)} tok</span>
                  </div>
                ) : null}
                <div className={styles.row}>
                  <span className={styles.label}>{t('usageCacheRead')}</span>
                  <span className={styles.value}>{formatTokenCount(totals.cacheRead)} tok</span>
                </div>
                <div className={styles.row}>
                  <span className={styles.label}>{t('usageOutput')}</span>
                  <span className={styles.value}>{formatTokenCount(totals.output)} tok</span>
                </div>
              </div>
            </div>

            <div className={styles.section}>
              <div className={styles.sectionHead}>
                <span className={styles.sectionTitle}>
                  {t('statsContextUsed')} {Math.round(ratio * 100)}%
                </span>
                <span className={styles.sectionValue}>
                  ~{formatTokens(used)} / {formatTokens(CONTEXT_LIMIT)}
                </span>
              </div>
              <div className={styles.split}>
                <div
                  className={clsx(styles.slice, styles.sliceSystem)}
                  style={{ width: `${share(parts.system)}%` }}
                />
                <div
                  className={clsx(styles.slice, styles.sliceTools)}
                  style={{ width: `${share(parts.tools)}%` }}
                />
                <div
                  className={clsx(styles.slice, styles.sliceMessages)}
                  style={{ width: `${share(parts.messages)}%` }}
                />
              </div>
              <div className={styles.rows}>
                <div className={styles.row}>
                  <span className={styles.label}>
                    <i className={clsx(styles.chip, styles.chipSystem)} />
                    {t('statsContextSystem')}
                  </span>
                  <span className={styles.value}>~{formatTokens(parts.system)}</span>
                </div>
                <div className={styles.row}>
                  <span className={styles.label}>
                    <i className={clsx(styles.chip, styles.chipTools)} />
                    {t('statsContextTools')}
                  </span>
                  <span className={styles.value}>~{formatTokens(parts.tools)}</span>
                </div>
                <div className={styles.row}>
                  <span className={styles.label}>
                    <i className={clsx(styles.chip, styles.chipMessages)} />
                    {t('statsContextMessages')}
                  </span>
                  <span className={styles.value}>~{formatTokens(parts.messages)}</span>
                </div>
              </div>
            </div>

            <div className={styles.foot}>{t('statsHint')}</div>
          </div>
        </>
      ) : null}
    </div>
  )
}
