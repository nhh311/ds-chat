import { streamMessage } from '../api/client.js'
import type { CreateMessageRequest } from '../api/types.js'

/**
 * 语音转写后的「整理」：把 ASR 原文交给模型过一遍。
 *
 * 为什么需要：ASR 只做声学转写，输出普遍带口头语、重复、缺标点、同音错字；
 * 直接发出去既难读也会让模型误解题意。
 *
 * 但要区分场景：随口聊天（「嗯」「好的」「哈哈这个挺好」）整理反而破坏语感，
 * 所以让模型先判断属于哪一种，只有工作/信息类内容才真的改写。
 *
 * 整理固定用 flash、不思考、不带工具：一次几十 token，快且便宜，失败就退回原文。
 */

/** 整理请求固定用最便宜的模型：这是纯改写任务，不需要强模型 */
const POLISH_MODEL = 'deepseek-flash' as const

/** 太短的转写没有整理价值，直接原样使用（省一次请求） */
const MIN_LENGTH = 5

/** 一次整理最多等这么久，超时就退回原文，别让用户盯着转圈 */
const TIMEOUT_MS = 15_000

const SYSTEM_PROMPT = `你是语音输入的后处理器，只做一件事：判断这段语音要不要整理。

输入是一段语音识别原文，可能带口头语、重复、同音错字、缺标点。

判断标准：
- casual = true（不整理）：随口聊天。寒暄、情绪、短句点评、"嗯/对/好的/哈哈"、闲聊、只为应答的一两个词、没有具体任务或信息量。
- casual = false（整理）：有明确工作或信息含量。交代任务、写代码或写作需求、总结整理、数据分析、日程安排、对外沟通、需要准确传达的句子。

整理规则（只在 casual = false 时执行）：
1. 去掉口头语、语气词、重复与自我打断（"那个""就是说""嗯""然后然后"）。
2. 补全标点，整理成通顺的一句话或一段话，必要时断句分成多句。
3. 修正明显的同音/近音错字，尤其是结合上下文的人名、产品名、专业术语。
4. 保留原意与全部信息：不总结、不删减事实、不扩写、不回答这段内容、不改变语气与人称、不加敬语。
5. 原文本来就只有一句通顺的话时，只做错字与标点修正，不要重写句式。

输出格式：只输出一行 JSON，不要代码块、不要解释、不要多余文字：
{"casual":true,"text":"<原文原样>"}
或
{"casual":false,"text":"<整理后的文本>"}`

export type PolishContext = {
  /** 上一轮对话的片段，用来纠正人名、术语与话题（可为空） */
  previous?: string
  /** 输入框里已有的文字，接在后面说的时候有用（可为空） */
  draft?: string
}

const buildPrompt = (raw: string, context: PolishContext): string => {
  const lines: string[] = []
  const previous = (context.previous ?? '').trim()
  if (previous) {
    lines.push(`【上一轮对话片段】\n${previous.slice(0, 600)}`)
  }
  const draft = (context.draft ?? '').trim()
  if (draft) {
    lines.push(`【输入框里已有的文字】\n${draft.slice(0, 300)}`)
  }
  lines.push(`【语音识别原文】\n${raw}`)
  return lines.join('\n\n')
}

/** 从模型回复里取出 JSON：允许被包在代码块或带前后缀空白 */
const parseDecision = (text: string): { casual: boolean; text: string } | null => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) {
    return null
  }
  const body = text.slice(start, end + 1)
  try {
    const parsed = JSON.parse(body) as { casual?: unknown; text?: unknown }
    if (typeof parsed.text !== 'string') {
      return null
    }
    return { casual: parsed.casual === true, text: parsed.text }
  } catch {
    return null
  }
}

/**
 * 整理一段语音转写。
 * @returns 整理后的文本；返回 null 表示「不用改」（闲聊、太短、模型说要保留、或整理失败）
 */
export const polishTranscript = async (
  apiKey: string,
  raw: string,
  context: PolishContext,
  signal: AbortSignal,
): Promise<string | null> => {
  const trimmed = raw.trim()
  if (trimmed.length < MIN_LENGTH) {
    return null
  }
  const request: CreateMessageRequest = {
    model: POLISH_MODEL,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildPrompt(trimmed, context) }],
    thinking: { type: 'disabled' },
    tools: [],
    safety_check: { level: 'high' },
  }

  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort)
  const timer = setTimeout(abort, TIMEOUT_MS)

  let answer = ''
  try {
    for await (const event of streamMessage(apiKey, request, controller.signal)) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        answer += event.delta.text
      }
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }

  const decision = parseDecision(answer)
  if (!decision || decision.casual) {
    return null
  }
  const polished = decision.text.trim()
  // 模型原样返回或改空了，都按「不用改」处理
  if (!polished || polished === trimmed) {
    return null
  }
  return polished
}
