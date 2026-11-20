import { useCallback, useEffect, useRef, useState } from 'react'
import {
  cancelCloudSpeech,
  cancelNativeSpeech,
  hasCloudSpeech,
  nativeSpeechStatus,
  onNativeSpeech,
  startCloudSpeech,
  startNativeSpeech,
  stopCloudSpeech,
  stopNativeSpeech,
} from '../../app/native.js'
import type { TranslationMessage } from '../../i18n/index.js'
import { apiOrigin } from '../../services/api/client.js'
import { transcribe } from '../../services/api/speech.js'
import { startRecording, type Recording } from '../../services/speech/recorder.js'
import { polishTranscript, type PolishContext } from '../../services/speech/polish.js'
import { useSettings } from '../../services/settings.js'
import { showToast } from '../base/toastState.js'

export type VoiceInputStatus = 'idle' | 'recording' | 'transcribing'

/** 一次语音输入的三种实现，按优先级从高到低选 */
type VoiceMode = 'cloud' | 'device' | 'browser' | 'none'

/**
 * 录音依赖 getUserMedia，只在安全上下文可用（HTTPS、localhost、file://）。
 * 普通 HTTP 页面上直接禁用入口，避免点击后必然失败。
 */
const SECURE = typeof window === 'undefined' || window.isSecureContext

/** App 里等系统识别出结果的最长时间；超时按失败处理，避免按钮一直转 */
const DEVICE_SETTLE_MS = 8000
/** 云端识别要上传 + 识别，给足 60 秒 */
const CLOUD_SETTLE_MS = 60000

const describeRecordingError = (error: unknown): TranslationMessage => {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return { key: 'voiceInputPermissionDenied' }
    }
    if (error.name === 'NotFoundError') {
      return { key: 'voiceInputNoDevice' }
    }
  }
  return { key: 'voiceInputFailed' }
}

/** 原生识别的错误码 → 提示文案 */
const describeNativeError = (code: string): TranslationMessage => {
  if (code === 'denied') {
    return { key: 'voiceInputPermissionDenied' }
  }
  if (code === 'missing') {
    return { key: 'voiceInputNoDevice' }
  }
  if (code === 'auth') {
    return { key: 'voiceInputAuthFailed' }
  }
  return { key: 'voiceInputFailed' }
}

/** 识别语言：跟随界面语言，缺省中文 */
const speechLanguage = () => {
  const language = typeof navigator === 'undefined' ? '' : navigator.language
  return language || 'zh-CN'
}

/**
 * 语音输入（oneshot）：点击开始，再次点击结束，结果交给 onText 填入输入框。
 *
 * 优先级：
 *   1. cloud   —— App 里原生录音，停止后直接 POST {origin}/v1/tools/asr。
 *                 不依赖设备自带识别服务，也不依赖 getUserMedia，最稳。
 *   2. device  —— App 里用系统 SpeechRecognizer（有识别服务的机器更快）。
 *   3. browser —— 普通浏览器里 getUserMedia 录音 + 云端转写。
 */
export const useVoiceInput = (
  onText: (text: string) => void,
  getContext?: () => PolishContext,
) => {
  const apiKey = useSettings((state) => state.apiKey) ?? ''
  const cloudBridge = hasCloudSpeech()
  const deviceStatus = nativeSpeechStatus()
  const device = deviceStatus === 'ready' || deviceStatus === 'denied'
  const canCloud = cloudBridge && apiKey.trim().length > 0
  const mode: VoiceMode = canCloud ? 'cloud' : device ? 'device' : SECURE ? 'browser' : 'none'
  const nativeMode = mode === 'cloud' || mode === 'device'

  const [status, setStatus] = useState<VoiceInputStatus>('idle')
  /** 本次录音已录秒数，只在录音中递增 */
  const [seconds, setSeconds] = useState(0)
  const recordingRef = useRef<Recording | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const operationRef = useRef(0)
  const levelRef = useRef(0)
  const settleTimerRef = useRef<number | null>(null)
  const polishControllerRef = useRef<AbortController | null>(null)
  const onTextRef = useRef(onText)
  onTextRef.current = onText
  const contextRef = useRef(getContext)
  contextRef.current = getContext

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = null
    }
  }, [])

  const cancelOperation = useCallback(() => {
    operationRef.current++
    clearSettleTimer()
    recordingRef.current?.cancel()
    recordingRef.current = null
    controllerRef.current?.abort()
    controllerRef.current = null
    polishControllerRef.current?.abort()
    polishControllerRef.current = null
    levelRef.current = 0
    if (mode === 'cloud') {
      cancelCloudSpeech()
    } else if (mode === 'device') {
      cancelNativeSpeech()
    }
  }, [clearSettleTimer, mode])

  /**
   * 转写结果落到输入框：开了「语音整理」就先让模型判断要不要改写。
   * 整理失败、超时、或判定为闲聊时都退回原文，绝不吞掉用户说的话。
   */
  const applyText = useCallback(async (operation: number, raw: string) => {
    const settings = useSettings.getState()
    if (!settings.voicePolish || !settings.apiKey) {
      onTextRef.current(raw)
      return
    }
    const controller = new AbortController()
    polishControllerRef.current = controller
    setStatus('transcribing')
    try {
      const polished = await polishTranscript(
        settings.apiKey,
        raw,
        contextRef.current?.() ?? {},
        controller.signal,
      )
      if (operationRef.current !== operation) {
        return
      }
      onTextRef.current(polished ?? raw)
    } catch {
      // 整理只是锦上添花，出错就静默用原文
      if (operationRef.current === operation) {
        onTextRef.current(raw)
      }
    } finally {
      if (polishControllerRef.current === controller) {
        polishControllerRef.current = null
      }
    }
  }, [])

  const cancel = useCallback(() => {
    cancelOperation()
    setStatus('idle')
  }, [cancelOperation])

  /** 原生识别结束：拿最终文本（必要时先整理），或给出提示 */
  const settleNative = useCallback(
    (operation: number, text: string | null, errorKey: TranslationMessage | null) => {
      if (operationRef.current !== operation) {
        return
      }
      clearSettleTimer()
      levelRef.current = 0
      if (errorKey) {
        setStatus('idle')
        showToast(errorKey)
        return
      }
      const trimmed = (text ?? '').trim()
      if (!trimmed) {
        setStatus('idle')
        showToast({ key: 'voiceInputEmpty' })
        return
      }
      void applyText(operation, trimmed).finally(() => {
        if (operationRef.current === operation) {
          setStatus('idle')
        }
      })
    },
    [applyText, clearSettleTimer],
  )

  // 原生事件（云端识别与系统识别共用同一条通道），用操作号丢弃过期结果
  useEffect(() => {
    if (!nativeMode) {
      return
    }
    return onNativeSpeech((event) => {
      const operation = operationRef.current
      switch (event.type) {
        case 'volume':
          levelRef.current = event.value
          break
        case 'speechend':
          // 录音结束，等待最终文本
          setStatus((current) => (current === 'recording' ? 'transcribing' : current))
          break
        case 'final':
          settleNative(operation, event.text, null)
          break
        case 'empty':
          settleNative(operation, null, null)
          break
        case 'error':
          settleNative(operation, null, describeNativeError(event.code))
          break
        default:
          break
      }
    })
  }, [nativeMode, settleNative])

  const finish = useCallback(async () => {
    const recording = recordingRef.current
    if (!recording) {
      // 仍在等待麦克风授权时也允许取消；迟到的录音对象会立即释放。
      cancel()
      return
    }
    const operation = operationRef.current
    recordingRef.current = null
    let controller: AbortController | null = null
    try {
      let audio: Blob | null
      try {
        audio = await recording.stop()
      } finally {
        recording.cancel()
      }
      if (operationRef.current !== operation || !audio) {
        return
      }
      controller = new AbortController()
      controllerRef.current = controller
      setStatus('transcribing')
      const text = await transcribe(useSettings.getState().apiKey ?? '', audio, controller.signal)
      if (controller.signal.aborted || operationRef.current !== operation) {
        return
      }
      if (text.trim()) {
        await applyText(operation, text.trim())
      } else {
        showToast({ key: 'voiceInputEmpty' })
      }
    } catch {
      if (operationRef.current === operation && !controller?.signal.aborted) {
        showToast({ key: 'voiceInputFailed' })
      }
    } finally {
      if (operationRef.current === operation) {
        controllerRef.current = null
        setStatus('idle')
      }
    }
  }, [applyText, cancel])

  /** 云端 / 系统识别共用的开关 */
  const toggleNative = useCallback(() => {
    if (status === 'recording') {
      const operation = operationRef.current
      setStatus('transcribing')
      if (mode === 'cloud') {
        stopCloudSpeech()
      } else {
        stopNativeSpeech()
      }
      clearSettleTimer()
      settleTimerRef.current = window.setTimeout(
        () => {
          settleNative(operation, null, { key: 'voiceInputFailed' })
        },
        mode === 'cloud' ? CLOUD_SETTLE_MS : DEVICE_SETTLE_MS,
      )
      return
    }
    if (status === 'transcribing') {
      cancel()
      return
    }
    const operation = ++operationRef.current
    setStatus('recording')
    levelRef.current = 0
    if (mode === 'cloud') {
      if (!startCloudSpeech(apiKey, apiOrigin(), speechLanguage())) {
        // 第一次点击会弹出麦克风授权，授权后原生会自动开始录音
        clearSettleTimer()
        settleTimerRef.current = window.setTimeout(() => {
          // 用户迟迟不授权时把按钮复位
          if (operationRef.current === operation) {
            setStatus((current) => (current === 'recording' ? 'idle' : current))
          }
        }, 120000)
      }
      return
    }
    if (!startNativeSpeech(speechLanguage()) && nativeSpeechStatus() === 'missing') {
      settleNative(operation, null, { key: 'voiceInputNoDevice' })
    }
  }, [status, cancel, clearSettleTimer, settleNative, mode, apiKey])

  const toggle = useCallback(async () => {
    if (mode === 'cloud' || mode === 'device') {
      toggleNative()
      return
    }
    if (mode === 'none') {
      return
    }
    if (status === 'recording') {
      await finish()
      return
    }
    if (status === 'transcribing') {
      cancel()
      return
    }
    const operation = ++operationRef.current
    setStatus('recording')
    try {
      const recording = await startRecording(() => {
        if (operationRef.current === operation) {
          showToast({ key: 'voiceInputLimitReached' })
          void finish()
        }
      })
      if (operationRef.current !== operation) {
        recording.cancel()
        return
      }
      recordingRef.current = recording
    } catch (error) {
      if (operationRef.current === operation) {
        setStatus('idle')
        showToast(describeRecordingError(error))
      }
    }
  }, [mode, toggleNative, status, finish, cancel])

  useEffect(() => {
    if (status !== 'recording') {
      return
    }
    const startedAt = Date.now()
    setSeconds(0)
    // 半秒刷新一次，让显示的秒数与实际录音时长保持一致
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 500)
    return () => clearInterval(timer)
  }, [status])

  useEffect(() => cancelOperation, [cancelOperation])

  /** 当前录音的频谱分析节点，未录音时为 null */
  const getAnalyser = useCallback(() => recordingRef.current?.analyser ?? null, [])

  /** 原生录音的音量（0-1）；浏览器录音时返回 null，频谱改用 analyser */
  const getLevel = useCallback(() => (nativeMode ? levelRef.current : null), [nativeMode])

  return {
    status,
    seconds,
    getAnalyser,
    getLevel,
    toggle,
    cancel,
    available: mode !== 'none',
    native: nativeMode,
  }
}
