import type { MessageUsage } from '../api/types.js'
import { getVisibleMessages } from './branches.js'
import type { Session } from './types.js'

/**
 * 上下文窗口：官方价格页写明 deepseek-flash 与 deepseek-v4-pro 均为 1M tokens。
 * 圆环用它当分母；换模型或官方调整时改这一处即可。
 */
export const CONTEXT_LIMIT = 1_000_000

/** 单次请求的用量汇总 */
export type UsageTotals = {
  /** 未命中缓存的输入 */
  uncached: number
  /** 命中缓存、按缓存价计费的输入 */
  cacheRead: number
  /** 写入缓存的输入 */
  cacheCreate: number
  /** 输出 */
  output: number
  /** 以上四项之和，与官方客户端的「Token 用量」口径一致 */
  total: number
  /** 缓存命中率 = 缓存读取 /（缓存读取 + 未缓存输入）；没有输入时为 0 */
  hitRate: number
}

const EMPTY: UsageTotals = {
  uncached: 0,
  cacheRead: 0,
  cacheCreate: 0,
  output: 0,
  total: 0,
  hitRate: 0,
}

const toTotals = (usage: MessageUsage): UsageTotals => {
  const uncached = usage.input_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheCreate = usage.cache_creation_input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const inputSide = uncached + cacheRead
  return {
    uncached,
    cacheRead,
    cacheCreate,
    output,
    total: uncached + cacheRead + cacheCreate + output,
    hitRate: inputSide > 0 ? cacheRead / inputSide : 0,
  }
}

/** 当前会话（只看当前选中的分支）累计用量 */
export const sessionUsage = (session: Session | undefined): UsageTotals => {
  if (!session) {
    return EMPTY
  }
  return getVisibleMessages(session).reduce<UsageTotals>((sum, message) => {
    if (message.role !== 'assistant' || !message.usage) {
      return sum
    }
    const next = toTotals(message.usage)
    const cacheRead = sum.cacheRead + next.cacheRead
    const uncached = sum.uncached + next.uncached
    const inputSide = cacheRead + uncached
    return {
      uncached,
      cacheRead,
      cacheCreate: sum.cacheCreate + next.cacheCreate,
      output: sum.output + next.output,
      total: sum.total + next.total,
      hitRate: inputSide > 0 ? cacheRead / inputSide : 0,
    }
  }, EMPTY)
}

/**
 * 当前上下文占用：取最近一次请求的输入总量（未缓存 + 缓存读取 + 缓存写入）。
 * 多轮工具循环时最后一条消息的 usage 就是最后一轮的输入，足以代表此刻的上下文长度。
 */
export const contextTokens = (session: Session | undefined): number => {
  if (!session) {
    return 0
  }
  const messages = getVisibleMessages(session)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'assistant' && message.usage) {
      const usage = message.usage
      return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
    }
  }
  return 0
}

/** 83000 → 83K，1_234_567 → 1.23M，恰好 1000000 → 1M；面板里用短写法，明细用精确值 */
export const formatTokens = (value: number): string => {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    const text = millions >= 10 ? millions.toFixed(1) : millions.toFixed(2)
    return `${text.replace(/\.?0+$/, '')}M`
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}K`
  }
  return String(value)
}

/** 精确到个位，带千分位 */
export const formatTokenCount = (value: number): string => value.toLocaleString('en-US')

/**
 * 由字符数估算 token：中日韩字符约 1 token/字，其余按 4 字符/token。
 * 只用于上下文构成的分项估算（面板里带 ~ 前缀），不参与计费口径。
 */
export const estimateTokens = (text: string): number => {
  if (!text) {
    return 0
  }
  let wide = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      wide += 1
    }
  }
  return Math.round(wide + (text.length - wide) / 4)
}

/** 会话里的一条统计快照 */
export type SessionTiming = {
  /** 用户发了几轮 */
  rounds: number
  /** 步：每条回复算一步，工具回环每轮再加一步 */
  steps: number
  /** 模型用时（总耗时减掉工具调用） */
  modelMs: number
  /** 工具调用用时 */
  toolMs: number
  /** 首 token 平均延迟（毫秒），没有样本时为 null */
  ttftMs: number | null
  /** 输出速度 tok/s，没有可计时的样本时为 null */
  tps: number | null
}

const EMPTY_TIMING: SessionTiming = {
  rounds: 0,
  steps: 0,
  modelMs: 0,
  toolMs: 0,
  ttftMs: null,
  tps: null,
}

/** 当前分支的轮数、耗时与输出速度 */
export const sessionTiming = (session: Session | undefined): SessionTiming => {
  if (!session) {
    return EMPTY_TIMING
  }
  let rounds = 0
  let steps = 0
  let modelMs = 0
  let toolMs = 0
  let ttftSum = 0
  let ttftCount = 0
  let output = 0
  for (const message of getVisibleMessages(session)) {
    if (message.role === 'user') {
      rounds += 1
      continue
    }
    steps += 1 + (message.toolRounds ?? 0)
    output += message.usage?.output_tokens ?? 0
    toolMs += message.toolMs ?? 0
    if (message.elapsedMs && message.elapsedMs > 0) {
      // 模型用时 = 整轮耗时 - 工具调用耗时，避免把等工具的时间算进 TPS
      modelMs += Math.max(0, message.elapsedMs - (message.toolMs ?? 0))
    }
    if (message.firstTokenMs && message.firstTokenMs > 0) {
      ttftSum += message.firstTokenMs
      ttftCount += 1
    }
  }
  return {
    rounds,
    steps,
    modelMs,
    toolMs,
    ttftMs: ttftCount > 0 ? Math.round(ttftSum / ttftCount) : null,
    // 太短的窗口算出来的速度没有意义（例如假接口瞬间返回），宁可不显示
    tps: modelMs >= 500 && output > 0 ? (output / modelMs) * 1000 : null,
  }
}

/** 上下文构成：系统提示词、工具定义按字符数估算，其余归到对话消息 */
export type ContextParts = {
  system: number
  tools: number
  messages: number
}

export const contextParts = (session: Session | undefined): ContextParts => {
  if (!session) {
    return { system: 0, tools: 0, messages: 0 }
  }
  const messages = getVisibleMessages(session)
  let system = 0
  let tools = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'assistant' && message.contextSystem !== undefined) {
      system = message.contextSystem
      tools = message.contextTools ?? 0
      break
    }
  }
  const used = contextTokens(session)
  return { system, tools, messages: Math.max(0, used - system - tools) }
}

