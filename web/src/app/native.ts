/**
 * 原生外壳（window.DSK）的封装。
 *
 * 网页跑在 App 的 WebView 里时，原生侧注入了一个 `DSK` 对象，提供三件事：
 *   - insets()：状态栏 / 手势条 / 刘海的高度，用来把顶栏和底部输入框推进安全区；
 *   - 系统语音识别（startSpeech / stopSpeech / cancelSpeech），不依赖云端 ASR；
 *   - 一个真实存在的应用私有目录（storage / readStoreFile / writeStoreFile），
 *     用来存 skill 与 MCP 配置。
 *
 * 在普通浏览器里打开时 `DSK` 不存在，下面每个函数都会安全退化为「没有原生能力」。
 */

export type NativeInsets = { top: number; bottom: number; left: number; right: number }

/** 原生识别事件；type 与 NativeBridge 里的 JSON 一致 */
export type NativeSpeechEvent =
  | { type: 'ready' }
  | { type: 'speechstart' }
  | { type: 'speechend' }
  | { type: 'volume'; value: number }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'empty' }
  | { type: 'error'; code: string; message: string }

export type NativeInfo = {
  versionName?: string
  sdk?: number
  device?: string
  android?: string
  webView?: string
  speech?: 'ready' | 'denied' | 'missing'
}

type Bridge = {
  insets(): string
  info(): string
  speechStatus(): string
  startSpeech(language: string): boolean
  stopSpeech(): void
  cancelSpeech(): void
  startCloudSpeech(apiKey: string, origin: string, language: string): boolean
  stopCloudSpeech(): void
  cancelCloudSpeech(): void
  openExternal?(url: string): boolean
  storage(): string
  writeStoreFile(name: string, content: string): boolean
  readStoreFile(name: string): string | null
  deleteStoreFile(name: string): boolean
}

const EMPTY_INSETS: NativeInsets = { top: 0, bottom: 0, left: 0, right: 0 }

const bridge = (): Bridge | null => {
  if (typeof window === 'undefined') {
    return null
  }
  const candidate = (window as unknown as { DSK?: Partial<Bridge> }).DSK
  return candidate && typeof candidate.insets === 'function' ? (candidate as Bridge) : null
}

/** 是否运行在带原生桥的 Android 外壳里 */
export const hasNativeShell = (): boolean => bridge() !== null

/** 读取系统栏高度（CSS 像素）；没有原生桥时全 0 */
export const readInsets = (): NativeInsets => {
  const dsk = bridge()
  if (!dsk) {
    return EMPTY_INSETS
  }
  try {
    const raw = JSON.parse(dsk.insets()) as Partial<NativeInsets>
    return {
      top: Math.max(0, Number(raw.top) || 0),
      bottom: Math.max(0, Number(raw.bottom) || 0),
      left: Math.max(0, Number(raw.left) || 0),
      right: Math.max(0, Number(raw.right) || 0),
    }
  } catch {
    return EMPTY_INSETS
  }
}

/**
 * 把安全区写进 CSS 变量：--inset-top / --inset-bottom / --inset-left / --inset-right。
 * 顶栏据此下移，输入框据此上移；浏览器里（含 iOS Safari）回落到 env(safe-area-inset-*)。
 */
export const applyInsets = () => {
  const style = document.documentElement.style
  if (bridge()) {
    const insets = readInsets()
    style.setProperty('--inset-top', `${insets.top}px`)
    style.setProperty('--inset-bottom', `${insets.bottom}px`)
    style.setProperty('--inset-left', `${insets.left}px`)
    style.setProperty('--inset-right', `${insets.right}px`)
    return
  }
  style.removeProperty('--inset-top')
  style.removeProperty('--inset-bottom')
  style.removeProperty('--inset-left')
  style.removeProperty('--inset-right')
}

export const readNativeInfo = (): NativeInfo => {
  const dsk = bridge()
  if (!dsk) {
    return {}
  }
  try {
    return JSON.parse(dsk.info()) as NativeInfo
  } catch {
    return {}
  }
}

// --------------------------------------------------------------------- 语音

const speechListeners = new Set<(event: NativeSpeechEvent) => void>()
let speechHooked = false

const hookSpeech = () => {
  if (speechHooked || typeof window === 'undefined') {
    return
  }
  speechHooked = true
  ;(window as unknown as { __dskSpeechEvent?: (event: NativeSpeechEvent) => void }).__dskSpeechEvent =
    (event) => {
      speechListeners.forEach((listener) => listener(event))
    }
}

/** ready 可用；denied 缺麦克风权限；missing 本机没有识别服务；none 不在原生外壳里 */
export const nativeSpeechStatus = (): 'ready' | 'denied' | 'missing' | 'none' => {
  const dsk = bridge()
  if (!dsk) {
    return 'none'
  }
  try {
    const status = dsk.speechStatus()
    return status === 'ready' || status === 'denied' || status === 'missing' ? status : 'none'
  } catch {
    return 'none'
  }
}

export const onNativeSpeech = (listener: (event: NativeSpeechEvent) => void): (() => void) => {
  hookSpeech()
  speechListeners.add(listener)
  return () => {
    speechListeners.delete(listener)
  }
}

/** 返回 false 表示正在申请麦克风权限：结果会通过 onNativeSpeech 的 error 事件回来 */
export const startNativeSpeech = (language: string): boolean => {
  const dsk = bridge()
  if (!dsk) {
    return false
  }
  try {
    return dsk.startSpeech(language) !== false
  } catch {
    return false
  }
}

export const stopNativeSpeech = () => {
  try {
    bridge()?.stopSpeech()
  } catch {
    // 已经结束
  }
}

export const cancelNativeSpeech = () => {
  try {
    bridge()?.cancelSpeech()
  } catch {
    // 已经结束
  }
}

// ------------------------------------------------- 原生录音 + 云端识别（ASR）

/** 原生侧是否有云端识别能力（0.3.0 起的外壳都有） */
export const hasCloudSpeech = (): boolean => {
  const dsk = bridge()
  return dsk !== null && typeof dsk.startCloudSpeech === 'function'
}

/**
 * 开始一次原生录音，停止后由原生直接上传到 `${origin}/v1/tools/asr`。
 * 返回 false 表示正在申请麦克风权限，录制会在授权后自动开始。
 */
export const startCloudSpeech = (apiKey: string, origin: string, language: string): boolean => {
  const dsk = bridge()
  if (!dsk || typeof dsk.startCloudSpeech !== 'function') {
    return false
  }
  try {
    return dsk.startCloudSpeech(apiKey, origin, language) !== false
  } catch {
    return false
  }
}

/** 结束录音并上传，结果走 onNativeSpeech 的 final / empty / error */
export const stopCloudSpeech = () => {
  try {
    bridge()?.stopCloudSpeech()
  } catch {
    // 已经结束
  }
}

/** 丢弃这次录音，不上传也不回调 */
export const cancelCloudSpeech = () => {
  try {
    bridge()?.cancelCloudSpeech()
  } catch {
    // 已经结束
  }
}

/** 打开 http(s) 外链：有原生桥交给系统浏览器，否则退回 window.open */
export const openExternal = (url: string) => {
  const dsk = bridge()
  if (dsk && typeof dsk.openExternal === 'function') {
    try {
      if (dsk.openExternal(url)) {
        return
      }
    } catch {
      // 落到 window.open
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

// --------------------------------------------------------- 应用私有目录
export type NativeStorage = { path: string; files: string[] }

/** 应用私有目录的绝对路径与文件清单；没有原生桥时为 null */
export const nativeStorage = (): NativeStorage | null => {
  const dsk = bridge()
  if (!dsk) {
    return null
  }
  try {
    const raw = JSON.parse(dsk.storage()) as { path?: string; files?: string[] }
    return { path: raw.path ?? '', files: Array.isArray(raw.files) ? raw.files : [] }
  } catch {
    return null
  }
}

export const writeNativeFile = (name: string, content: string): boolean => {
  try {
    return bridge()?.writeStoreFile(name, content) === true
  } catch {
    return false
  }
}

export const readNativeFile = (name: string): string | null => {
  try {
    return bridge()?.readStoreFile(name) ?? null
  } catch {
    return null
  }
}

export const deleteNativeFile = (name: string): boolean => {
  try {
    return bridge()?.deleteStoreFile(name) === true
  } catch {
    return false
  }
}
