import { loadAllSessions } from './db.js'
import type { Message, Session } from './types.js'

/** 一条搜索命中：标题命中时 snippet 为空，正文命中时给出命中处的上下文 */
export type SessionHit = {
  id: string
  title: string
  updatedAt: number
  snippet?: string
}

const SNIPPET_RADIUS = 26

/** 取消息里可搜索的正文；用户消息是一段文本，助手消息由若干文本块组成 */
const searchableTexts = (message: Message): string[] => {
  if (message.role === 'user') {
    return [message.content]
  }
  return message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
}

const snippetAround = (text: string, index: number, length: number): string => {
  const start = Math.max(0, index - SNIPPET_RADIUS)
  const end = Math.min(text.length, index + length + SNIPPET_RADIUS)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ')}${suffix}`
}

const matchSession = (session: Session, query: string): SessionHit | null => {
  const lowerQuery = query.toLowerCase()
  const titleHit = session.title.toLowerCase().includes(lowerQuery)
  let snippet: string | undefined
  if (!titleHit) {
    for (const message of session.messages) {
      for (const text of searchableTexts(message)) {
        const index = text.toLowerCase().indexOf(lowerQuery)
        if (index >= 0) {
          snippet = snippetAround(text, index, query.length)
          break
        }
      }
      if (snippet !== undefined) {
        break
      }
    }
    if (snippet === undefined) {
      return null
    }
  }
  return { id: session.id, title: session.title, updatedAt: session.updatedAt, snippet }
}

/** 在全库会话里搜标题与正文，按最近更新排序，最多 40 条 */
export const searchSessions = async (query: string): Promise<SessionHit[]> => {
  const trimmed = query.trim()
  if (trimmed.length === 0) {
    return []
  }
  const sessions = await loadAllSessions()
  const hits: SessionHit[] = []
  for (const session of sessions) {
    const hit = matchSession(session, trimmed)
    if (hit) {
      hits.push(hit)
    }
  }
  return hits.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40)
}
