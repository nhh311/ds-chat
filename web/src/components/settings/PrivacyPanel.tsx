import { useEffect, useState } from 'react'
import { apiOrigin } from '../../services/api/client.js'
import { openExternal } from '../../app/native.js'
import { clearHistory } from '../../services/chat/backup.js'
import { setLocation, useSettings } from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import styles from './PrivacyPanel.module.css'

/** 官方 DeepSeek 的隐私政策与「数据用于优化体验」开关说明页 */
const POLICY_URL = 'https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html'
const APP_URL = 'https://chat.deepseek.com/'
const PLATFORM_URL = 'https://platform.deepseek.com/'
const CONTACT_EMAIL = 'privacy@deepseek.com'

const formatBytes = (value: number): string => {
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB`
  }
  return `${value} B`
}

/**
 * 隐私分组：说清数据去了哪里、训练开关在哪里关、本机数据怎么清。
 * 训练用途是 DeepSeek 账户级开关，应用侧没有对应请求字段，只能给出确切的关闭入口。
 */
export const PrivacyPanel = () => {
  const t = useTranslate()
  const location = useSettings((state) => state.location)
  const origin = apiOrigin()

  return (
    <div className={styles.panel}>
      <section className={styles.section}>
        <div>
          <h3 className={styles.sectionTitle}>{t('privacyOutboundTitle')}</h3>
          <p className={styles.sectionHint}>{t('privacyOutboundDescription')}</p>
        </div>
        <ul className={styles.list}>
          <li className={styles.item}>
            <span className={styles.itemPath}>POST /anthropic/v1/messages</span>
            <span className={styles.itemText}>{t('privacyEndpointMessages')}</span>
          </li>
          <li className={styles.item}>
            <span className={styles.itemPath}>POST /anthropic/v1/files</span>
            <span className={styles.itemText}>{t('privacyEndpointFiles')}</span>
          </li>
          <li className={styles.item}>
            <span className={styles.itemPath}>POST /v1/tools/asr</span>
            <span className={styles.itemText}>{t('privacyEndpointAsr')}</span>
          </li>
          <li className={styles.item}>
            <span className={styles.itemPath}>POST /v1/tools/tts</span>
            <span className={styles.itemText}>{t('privacyEndpointTts')}</span>
          </li>
        </ul>
        <p className={styles.note}>
          {t('privacyOriginNote', { origin })}
        </p>
      </section>

      <section className={styles.section}>
        <div>
          <h3 className={styles.sectionTitle}>{t('privacyTrainingTitle')}</h3>
          <p className={styles.sectionHint}>{t('privacyTrainingDescription')}</p>
        </div>
        <p className={styles.note}>
          <strong>{t('privacyTrainingSwitchLabel')}</strong>
          <br />
          {t('privacyTrainingSwitchPath')}
        </p>
        <div className={styles.actions}>
          <Button
            variant="outlined"
            size="m"
            onClick={() => openExternal(APP_URL)}
          >
            {t('privacyOpenApp')}
          </Button>
          <Button
            variant="outlined"
            size="m"
            onClick={() => openExternal(PLATFORM_URL)}
          >
            {t('privacyOpenPlatform')}
          </Button>
          <Button
            variant="outlined"
            size="m"
            onClick={() => openExternal(POLICY_URL)}
          >
            {t('privacyOpenPolicy')}
          </Button>
        </div>
        <p className={styles.note}>{t('privacyTrainingEmail', { email: CONTACT_EMAIL })}</p>
      </section>

      <section className={styles.section}>
        <div>
          <h3 className={styles.sectionTitle}>{t('privacyLocalTitle')}</h3>
          <p className={styles.sectionHint}>{t('privacyLocalDescription')}</p>
        </div>
        <StorageUsage />
        <div className={styles.actions}>
          {location ? (
            <Button
              variant="outlined"
              size="m"
              onClick={() => {
                setLocation(null)
                showToast({ key: 'privacyLocationCleared' })
              }}
            >
              {t('privacyClearLocation')}
            </Button>
          ) : null}
          <ClearLocalData />
        </div>
        <p className={styles.sectionHint}>{t('privacyClearDataHint')}</p>
      </section>
    </div>
  )
}

/** 本机已用存储：navigation.storage.estimate 在 file:// 与 WebView 里都可读，不可读时不显示 */
const StorageUsage = () => {
  const t = useTranslate()
  const [text, setText] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const read = async () => {
      try {
        const estimate = await navigator.storage?.estimate?.()
        if (!estimate || cancelled || typeof estimate.usage !== 'number') {
          return
        }
        setText(
          estimate.quota
            ? t('privacyStorageUsage', {
                usage: formatBytes(estimate.usage),
                quota: formatBytes(estimate.quota),
              })
            : t('privacyStorageUsageOnly', { usage: formatBytes(estimate.usage) })
        )
      } catch {
        // 拿不到就不展示，不影响其它内容
      }
    }
    void read()
    return () => {
      cancelled = true
    }
  }, [t])

  return text ? <p className={styles.usage}>{text}</p> : null
}

const ClearLocalData = () => {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)

  const run = async () => {
    setBusy(true)
    try {
      await clearHistory()
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button variant="dangerOutlined" size="m" disabled={busy} onClick={() => void run()}>
      {t(busy ? 'historyDeleting' : 'privacyClearAll')}
    </Button>
  )
}
