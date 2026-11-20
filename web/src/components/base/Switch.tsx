import clsx from 'clsx'
import styles from './Switch.module.css'

/**
 * 开关：设置里用，视觉上就是 iOS/Android 那种胶囊滑钮。
 * 用 button + role="switch"，键盘空格与读屏都能正常操作。
 */
export const Switch = ({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  ariaLabel: string
  disabled?: boolean
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={ariaLabel}
    disabled={disabled}
    className={clsx(styles.track, checked && styles.on)}
    onClick={() => onChange(!checked)}
  >
    <span className={styles.knob} />
  </button>
)
