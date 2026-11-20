import { IconMenuOutline20, IconNewChatOutline20 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { newChat } from '../../services/chat/store.js'
import { IconButton } from '../base/IconButton.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import { ModelPicker } from './ModelPicker.js'
import styles from './MobileHeader.module.css'

/**
 * 移动端顶栏。
 *
 * 顶上那条浅色横杠是「抓手」：它把内容从状态栏下面推开，同时给用户一个
 * 视觉起点。菜单、标题、模型、新对话排在第二行，各自有固定宽度，长标题
 * 只压缩标题本身，不会把右边的「+」挤出屏幕。
 */
export const MobileHeader = ({ title }: { title?: string }) => {
  const t = useTranslate()
  return (
    <div className={styles.header}>
      <div className={styles.grabber} aria-hidden>
        <span className={styles.grabberBar} />
      </div>
      <div className={styles.row}>
        <IconButton
          size="xl"
          tone="primary"
          icon={<IconMenuOutline20 />}
          aria-label={t('expandSiderbarButton')}
          onClick={openMobileSider}
        />
        <div className={styles.title}>{title ?? ''}</div>
        <div className={styles.trailing}>
          <ModelPicker />
          <IconButton
            size="xl"
            tone="primary"
            icon={<IconNewChatOutline20 />}
            aria-label={t('newChat')}
            onClick={newChat}
          />
        </div>
      </div>
    </div>
  )
}
