import { useTranslate } from '../../i18n/index.js'
import { CHAT_MODELS, setModel, useSettings } from '../../services/settings.js'
import { Select } from '../base/Select.js'

/** 全局模型选择：移动端放顶栏，桌面端放页面右上角 */
export const ModelPicker = () => {
  const t = useTranslate()
  const model = useSettings((state) => state.model)
  return (
    <Select
      value={model}
      options={CHAT_MODELS.map((item) => ({ value: item.id, label: item.label }))}
      onChange={setModel}
      ariaLabel={t('modelLabel')}
    />
  )
}
