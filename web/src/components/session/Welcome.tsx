import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { StatsBar } from '../chatInput/StatsBar.js'
import { MobileHeader } from './MobileHeader.js'
import { ModelPicker } from './ModelPicker.js'
import styles from './Welcome.module.css'

/** 新对话：鲸鱼标识 + 问候语 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  return (
    <div className={styles.container}>
      {isMobile ? (
        <MobileHeader />
      ) : (
        <div style={{ position: 'absolute', top: 14, right: 18, zIndex: 5 }}>
          <ModelPicker />
        </div>
      )}
      <div className={styles.welcome}>
        {/* 标识与问候语作为一组居中对齐，移动端一起吸在输入框上方 */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            margin: 'auto 0',
          }}
        >
          <div className={styles.greeting}>{t('welcomeMessageChat250808')}</div>
        </div>
        <ChatInput sessionId={null} />
        <StatsBar sessionId={null} />
      </div>
    </div>
  )
}
