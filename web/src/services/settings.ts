import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import type { ChatModel, ThinkingEffortLevel } from './api/types.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 聊天模式：快速最省；标准带联网搜索；深度开深度思考 */
export type ChatMode = 'fast' | 'standard' | 'deep'

/**
 * 思考强度：off 表示这一轮不思考，low / high / max 是真正的三档。
 * 服务端没有「中」这一档（medium 会被当成 high），所以界面只给这四个选项。
 */
export type ThinkingEffort = 'off' | ThinkingEffortLevel

/** 把历史值与脏值归一成界面上的四档：off / low / high / max（旧的 medium 归到 high） */
export const normalizeEffort = (value: unknown): ThinkingEffort =>
  value === 'off' || value === 'low' || value === 'high' || value === 'max' ? value : 'high'

export const CHAT_MODELS: { id: ChatModel; label: string; hint: string }[] = [
  { id: 'deepseek-flash', label: 'Flash', hint: 'DeepSeek Flash · 日常对话，快' },
  { id: 'deepseek-v4-pro', label: 'V4 Pro', hint: 'DeepSeek V4 Pro · 复杂推理，慢' },
]

/** 本机设置，存 localStorage：API Key、服务地址、模型、聊天模式、思考强度、语言、主题、位置、朗读音色、侧边栏收起状态 */
type Settings = {
  apiKey: string | null
  /** 自定义服务地址；null 表示用构建期默认的官方地址，可指向本地薄后端 */
  apiBaseUrl: string | null
  model: ChatModel
  mode: ChatMode
  effort: ThinkingEffort
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
  /** 语音转写完先让模型整理一遍（只整理工作类内容，闲聊原样保留） */
  voicePolish: boolean
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  apiBaseUrl: 'chat-demo:api-base-url',
  model: 'chat-demo:model',
  mode: 'chat-demo:mode',
  effort: 'chat-demo:effort',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
  voicePolish: 'chat-demo:voice-polish',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

/** 未保存过时用 flash，与官方客户端的默认模型一致 */
const initialModel = (): ChatModel =>
  read(KEYS.model) === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash'

/** 未保存过时用标准模式：带联网搜索，不开深度思考 */
const initialMode = (): ChatMode => {
  const saved = read(KEYS.mode)
  return saved === 'fast' || saved === 'deep' ? saved : 'standard'
}

/** 旧版本存过 'off' 与 'medium'，这两种都归一成 high；没存过也用 high */
const initialEffort = (): ThinkingEffort => {
  const raw = read(KEYS.effort)
  const effort = normalizeEffort(raw)
  // 顺手把旧值改写成三档之一，免得每次启动都要归一一遍
  if (raw !== null && raw !== effort) {
    write(KEYS.effort, effort)
  }
  return effort
}

/** 空串与末尾斜杠归一：空串表示回落到构建期官方地址 */
export const normalizeBaseUrl = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? '').trim().replace(/\/+$/, '')
  return trimmed === '' ? null : trimmed
}

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  apiBaseUrl: normalizeBaseUrl(read(KEYS.apiBaseUrl)),
  model: initialModel(),
  mode: initialMode(),
  effort: initialEffort(),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  // 默认开启：语音识别原文口语化严重，整理一次提升很大；只有显式存过 'false' 才关闭
  voicePolish: read(KEYS.voicePolish) !== 'false',
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}

export const setVoicePolish = (voicePolish: boolean) => {
  write(KEYS.voicePolish, String(voicePolish))
  useSettings.setState({ voicePolish })
}

export const setModel = (model: ChatModel) => {
  write(KEYS.model, model)
  useSettings.setState({ model })
}

export const setMode = (mode: ChatMode) => {
  write(KEYS.mode, mode)
  useSettings.setState({ mode })
}

export const setEffort = (effort: ThinkingEffort) => {
  // 只允许三档；旧的 'off'/'medium' 传进来也收敛成 high，避免把无效值写进存储
  const next = normalizeEffort(effort)
  write(KEYS.effort, next)
  useSettings.setState({ effort: next })
}

/** 传空串表示恢复默认官方地址 */
export const setApiBaseUrl = (value: string | null) => {
  const apiBaseUrl = normalizeBaseUrl(value)
  write(KEYS.apiBaseUrl, apiBaseUrl)
  useSettings.setState({ apiBaseUrl })
}

/**
 * 模式到请求行为的映射：快速=不思考不联网（最省 token）；
 * 标准=不思考但联网搜索；深度=开深度思考并联网。
 */
export const modePreset = (mode: ChatMode): { thinking: boolean; search: boolean } => {
  if (mode === 'fast') {
    return { thinking: false, search: false }
  }
  return mode === 'deep' ? { thinking: true, search: true } : { thinking: false, search: true }
}

/** 当前设置实际生效的思考与联网开关（模式优先，旧开关仅作兜底） */
export const effectiveToggles = (): { thinking: boolean; search: boolean } => {
  const { mode } = useSettings.getState()
  return modePreset(mode)
}
