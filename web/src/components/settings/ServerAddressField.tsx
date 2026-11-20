import { useState } from 'react'
import { useSettings, setApiBaseUrl, normalizeBaseUrl } from '../../services/settings.js'
import { DEFAULT_API_ORIGIN } from '../../services/api/client.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './Settings.module.css'

/** 服务地址：留空走构建期官方地址，填了则所有请求（含上传、语音）都改指向该地址 */
export const ServerAddressField = () => {
  const t = useTranslate()
  const saved = useSettings((state) => state.apiBaseUrl)
  const [value, setValue] = useState(saved ?? '')
  const [error, setError] = useState<string | null>(null)

  const commit = () => {
    const next = normalizeBaseUrl(value)
    if (next !== null && !/^https?:\/\//i.test(next)) {
      setError(t('serverAddressInvalid'))
      return
    }
    setError(null)
    setApiBaseUrl(next)
    setValue(next ?? '')
  }

  return (
    <div className={styles.cell}>
      <div className={styles.apiKey}>
        <div className={styles.label}>{t('serverAddressLabel')}</div>
        <div className={styles.apiKeyInput}>
          <input
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={DEFAULT_API_ORIGIN}
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              setError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                commit()
              }
            }}
            onBlur={commit}
          />
          {value.trim() ? (
            <>
              <span className={styles.divider} />
              <button
                type="button"
                className={styles.confirm}
                onMouseDown={(event) => event.preventDefault()}
                onClick={commit}
              >
                {t('confirm')}
              </button>
            </>
          ) : null}
        </div>
        {error ? (
          <div className={styles.error}>{error}</div>
        ) : (
          <div className={styles.apiKeySaved}>
            <span>{t('serverAddressHint')}</span>
          </div>
        )}
      </div>
    </div>
  )
}
