/**
 * MCP（Model Context Protocol）客户端：把远端 MCP 服务器提供的工具接进对话。
 *
 * 只用 streamable HTTP 传输（POST JSON-RPC，响应可能是 JSON 也可能是 SSE），
 * 不做 stdio（网页里没有子进程）。流程与官方一致：
 *   initialize → notifications/initialized → tools/list → tools/call。
 *
 * 工具最终以「客户端工具」的形式声明给模型，模型发起调用后由浏览器执行，
 * 结果作为 tool_result 回传，形成工具循环。
 */

import type { ClientTool } from './api/types.js'
import { readNativeFile, writeNativeFile } from '../app/native.js'

export type McpServer = {
  id: string
  name: string
  url: string
  /** 每行一个请求头，形如 Authorization: Bearer xxx */
  headers: string
  enabled: boolean
}

export type McpToolInfo = { name: string; description?: string; inputSchema?: unknown }

const STORAGE_KEY = 'chat-demo:mcp-servers'
const STORE_FILE = 'mcp.json'
const PROTOCOL_VERSION = '2024-11-05'
const TIMEOUT_MS = 20000
/** 工具清单缓存时间：避免每条消息都去握手 */
const TOOLS_TTL_MS = 5 * 60 * 1000
/** 一次请求最多带多少个 MCP 工具，防止请求体过大、模型选择困难 */
const MAX_TOOLS = 64

type Route = { server: McpServer; remoteName: string }
/** 全名（前缀化后）→ 服务器与远端工具名 */
const routes = new Map<string, Route>()
type Cache = { at: number; tools: McpToolInfo[]; sessionId: string | null }
const cache = new Map<string, Cache>()

const isServer = (value: unknown): value is McpServer => {
  if (!value || typeof value !== 'object') {
    return false
  }
  const server = value as Partial<McpServer>
  return (
    typeof server.id === 'string' &&
    typeof server.name === 'string' &&
    typeof server.url === 'string' &&
    typeof server.enabled === 'boolean'
  )
}

export const loadMcpServers = (): McpServer[] => {
  const read = (raw: string | null): McpServer[] => {
    if (!raw) {
      return []
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed)
        ? parsed.filter(isServer).map((server) => ({ ...server, headers: server.headers ?? '' }))
        : []
    } catch {
      return []
    }
  }
  const local = read(window.localStorage.getItem(STORAGE_KEY))
  if (local.length > 0) {
    return local
  }
  // localStorage 被清过时，从应用私有目录的镜像恢复
  return read(readNativeFile(STORE_FILE))
}

export const saveMcpServers = (servers: McpServer[]) => {
  const text = JSON.stringify(servers)
  try {
    window.localStorage.setItem(STORAGE_KEY, text)
  } catch {
    // 存不下时不影响本次使用
  }
  // 原生外壳里再镜像一份到应用私有目录，清理 WebView 数据也不会丢配置
  writeNativeFile(STORE_FILE, text)
}

export const createMcpServer = (input: {
  name: string
  url: string
  headers?: string
  enabled?: boolean
}): McpServer => ({
  id: `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
  name: input.name.trim() || input.url.trim(),
  url: input.url.trim(),
  headers: input.headers?.trim() ?? '',
  enabled: input.enabled ?? true,
})

/** "K: V" 每行一个 → 请求头对象 */
export const parseHeaders = (text: string): Record<string, string> => {
  const headers: Record<string, string> = {}
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const at = line.indexOf(':')
      if (at > 0) {
        headers[line.slice(0, at).trim()] = line.slice(at + 1).trim()
      }
    })
  return headers
}

type RpcBody = { jsonrpc: '2.0'; id?: number; method: string; params?: unknown }

let rpcId = 0

/** 每次请求都要带的头：会话 id 与协议版本（服务端按版本决定返回格式） */
const requestHeaders = (server: McpServer, sessionId: string | null): Record<string, string> => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  ...(sessionId ? { 'mcp-session-id': sessionId, 'mcp-protocol-version': PROTOCOL_VERSION } : {}),
  ...parseHeaders(server.headers),
})

/** 单次 JSON-RPC 调用；返回 result，失败抛错 */
const rpc = async (
  server: McpServer,
  method: string,
  params: unknown,
  sessionId: string | null
): Promise<{ result: unknown; sessionId: string | null }> => {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS)
  const id = ++rpcId
  const body: RpcBody = { jsonrpc: '2.0', id, method, params }
  try {
    const response = await fetch(server.url, {
      method: 'POST',
      headers: requestHeaders(server, sessionId),
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const nextSession = response.headers.get('mcp-session-id') ?? sessionId
    if (!response.ok) {
      throw new Error(`${server.name} 返回 HTTP ${response.status}`)
    }
    const payload = await readResponse(response, id)
    if (payload && typeof payload === 'object' && 'error' in payload) {
      const error = (payload as { error?: { message?: string } }).error
      throw new Error(error?.message ?? `${server.name} 调用 ${method} 失败`)
    }
    const result =
      payload && typeof payload === 'object' && 'result' in payload
        ? (payload as { result: unknown }).result
        : null
    return { result, sessionId: nextSession }
  } finally {
    window.clearTimeout(timer)
  }
}

/**
 * 通知：JSON-RPC 里没有 id 的调用，服务端通常回 202 且没有 body。
 * 协议要求 initialize 之后发 notifications/initialized，带 id 会被当成错误请求。
 */
const notify = async (
  server: McpServer,
  method: string,
  params: unknown,
  sessionId: string | null
): Promise<void> => {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    await fetch(server.url, {
      method: 'POST',
      headers: requestHeaders(server, sessionId),
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      signal: controller.signal,
    })
  } catch {
    // 通知失败不影响后续请求
  } finally {
    window.clearTimeout(timer)
  }
}

/**
 * 读一次响应：普通 JSON 一次读完；SSE 边读边找 id 匹配的响应，
 * 找到就主动断开——否则服务器保持长连接时会一直等到超时。
 */
const readResponse = async (response: Response, id: number): Promise<unknown> => {
  const type = response.headers.get('content-type') ?? ''
  if (!type.includes('text/event-stream') || !response.body) {
    return readPayload(await response.text(), id)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const payload = readPayload(buffer, id)
      if (payload !== null) {
        return payload
      }
      // 防御性上限：2MB 还没等到结果就放弃，避免无限缓冲
      if (buffer.length > 2_000_000) {
        break
      }
    }
    return readPayload(buffer, id)
  } finally {
    try {
      await reader.cancel()
    } catch {
      // 连接已经关闭
    }
  }
}

/** 响应可能是纯 JSON，也可能是 SSE；取 id 匹配的那条 */
const readPayload = (text: string, id: number): unknown => {
  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      // 流式读取时 JSON 还没收全，继续等
      return null
    }
  }
  let last: unknown = null
  trimmed.split(/\r?\n/).forEach((line) => {
    const data = line.startsWith('data:') ? line.slice(5).trim() : ''
    if (!data || data === '[DONE]') {
      return
    }
    try {
      const parsed = JSON.parse(data) as { id?: number }
      if (parsed && (parsed.id === id || parsed.id === undefined)) {
        last = parsed
      }
    } catch {
      // 跳过无法解析的行（多半是还没收全）
    }
  })
  return last
}

/** 握手 + 取工具清单 */
export const mcpListTools = async (server: McpServer): Promise<McpToolInfo[]> => {
  const hit = cache.get(server.id)
  if (hit && Date.now() - hit.at < TOOLS_TTL_MS) {
    return hit.tools
  }
  const init = await rpc(
    server,
    'initialize',
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'DS Chat', version: '0.3.0' },
    },
    null
  )
  const sessionId = init.sessionId
  // 协议要求握手后发一个无 id 的通知；失败也不影响 tools/list
  await notify(server, 'notifications/initialized', {}, sessionId)
  const listed = await rpc(server, 'tools/list', {}, sessionId)
  const tools = readToolList(listed.result)
  cache.set(server.id, { at: Date.now(), tools, sessionId })
  return tools
}

const readToolList = (result: unknown): McpToolInfo[] => {
  const list =
    result && typeof result === 'object' && Array.isArray((result as { tools?: unknown }).tools)
      ? ((result as { tools: unknown[] }).tools as unknown[])
      : []
  return list.flatMap((item): McpToolInfo[] => {
    if (!item || typeof item !== 'object') {
      return []
    }
    const tool = item as { name?: unknown; description?: unknown; inputSchema?: unknown }
    return typeof tool.name === 'string'
      ? [
          {
            name: tool.name,
            description: typeof tool.description === 'string' ? tool.description : undefined,
            inputSchema: tool.inputSchema,
          },
        ]
      : []
  })
}

/** 工具全名：服务器名前缀 + 工具名，只保留 API 允许的字符，最长 64 */
const toolName = (server: McpServer, remote: string) => {
  const prefix = server.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 16)
  const body = remote.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 46)
  return `${prefix || 'mcp'}__${body}`.slice(0, 64)
}

const toClientTool = (server: McpServer, tool: McpToolInfo): ClientTool => {
  const schema =
    tool.inputSchema && typeof tool.inputSchema === 'object'
      ? (tool.inputSchema as { type?: string; properties?: unknown; required?: unknown })
      : null
  const properties =
    schema && schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, unknown>)
      : {}
  const required = Array.isArray(schema?.required)
    ? (schema.required as unknown[]).filter((item): item is string => typeof item === 'string')
    : []
  return {
    name: toolName(server, tool.name),
    description: (tool.description ?? `MCP 工具：${tool.name}（${server.name}）`).slice(0, 1024),
    input_schema: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
  }
}

/**
 * 汇总所有启用服务器的工具声明，并登记全名到服务器的路由。
 * 服务器连不上就跳过——不能让一个坏配置阻断整轮对话。
 */
export const loadClientTools = async (
  servers: McpServer[] = loadMcpServers()
): Promise<ClientTool[]> => {
  const enabled = servers.filter((server) => server.enabled && server.url)
  const lists = await Promise.all(
    enabled.map(async (server) => {
      try {
        return { server, tools: await mcpListTools(server) }
      } catch {
        return { server, tools: [] as McpToolInfo[] }
      }
    })
  )
  // 等所有服务器都回来之后再一次性替换路由表：
  // 期间正在执行的工具调用还能读到旧表，不会突然「工具不存在」
  const nextRoutes = new Map<string, Route>()
  const tools: ClientTool[] = []
  lists.forEach(({ server, tools: remoteTools }) => {
    remoteTools.forEach((tool) => {
      // 工具太多会把请求体撑爆，也给模型造成选择困难，留一个上限
      if (tools.length >= MAX_TOOLS) {
        return
      }
      const clientTool = toClientTool(server, tool)
      if (nextRoutes.has(clientTool.name)) {
        return
      }
      nextRoutes.set(clientTool.name, { server, remoteName: tool.name })
      tools.push(clientTool)
    })
  })
  routes.clear()
  nextRoutes.forEach((route, name) => routes.set(name, route))
  return tools
}

export type ToolOutcome = { text: string; isError: boolean }

/** 执行一次工具调用；未登记的（比如配置刚改过）直接报错给模型 */
export const runClientTool = async (name: string, input: unknown): Promise<ToolOutcome> => {
  const route = routes.get(name)
  if (!route) {
    return { text: `工具 ${name} 不存在或服务器已断开`, isError: true }
  }
  try {
    // 冷启动（没有会话）或缓存过期时先握手，否则服务器会拒绝 tools/call
    const hit = cache.get(route.server.id)
    if (!hit || !hit.sessionId) {
      await mcpListTools(route.server)
    }
    const sessionId = cache.get(route.server.id)?.sessionId ?? null
    const { result } = await rpc(
      route.server,
      'tools/call',
      { name: route.remoteName, arguments: input ?? {} },
      sessionId
    )
    return { text: flattenResult(result), isError: readIsError(result) }
  } catch (error) {
    return {
      text: error instanceof Error ? error.message : String(error),
      isError: true,
    }
  }
}

const readIsError = (result: unknown) =>
  Boolean(result && typeof result === 'object' && (result as { isError?: boolean }).isError)

/** MCP 的 content 是内容块数组，这里压平成纯文本 */
const flattenResult = (result: unknown): string => {
  if (!result || typeof result !== 'object') {
    return result === undefined || result === null ? '（无返回内容）' : String(result)
  }
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) {
    return JSON.stringify(result).slice(0, 4000)
  }
  const text = content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return ''
      }
      const block = item as { type?: string; text?: string; data?: string; mimeType?: string }
      if (block.type === 'text') {
        return block.text ?? ''
      }
      if (block.type === 'image') {
        return `[图片 ${block.mimeType ?? ''}，${block.data ? '已省略' : '空'}]`
      }
      return block.type ? `[${block.type}]` : ''
    })
    .filter(Boolean)
    .join('\n')
  return (text || '（无返回内容）').slice(0, 8000)
}

/**
 * 解析导入的 MCP 配置文件。认得三种写法：
 *   1. {"mcpServers": {"名字": {"url": "...", "headers": {...}}}}  —— 与 DSH / Claude 桌面端一致
 *   2. {"servers": [...]} 或 [...]  —— 自带 name/url 的数组
 *   3. {"名字": {"url": "..."}}  —— 省略外层 key
 * 只收流式 HTTP 的（有 url）；stdio 服务器（command）在网页里无法启动，跳过。
 */
export const parseMcpConfig = (text: string): McpServer[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return []
  }
  const fromEntry = (name: string, value: unknown): McpServer | null => {
    if (!value || typeof value !== 'object') {
      return null
    }
    const entry = value as { url?: unknown; endpoint?: unknown; headers?: unknown }
    const url = typeof entry.url === 'string' ? entry.url : entry.endpoint
    if (typeof url !== 'string' || !url) {
      return null
    }
    const headers =
      entry.headers && typeof entry.headers === 'object'
        ? Object.entries(entry.headers as Record<string, unknown>)
            .filter(([, headerValue]) => typeof headerValue === 'string')
            .map(([key, headerValue]) => `${key}: ${String(headerValue)}`)
            .join('\n')
        : ''
    return createMcpServer({ name, url, headers })
  }
  const out: McpServer[] = []
  const collect = (record: unknown) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return
    }
    Object.entries(record as Record<string, unknown>).forEach(([name, value]) => {
      const server = fromEntry(name, value)
      if (server) {
        out.push(server)
      }
    })
  }
  if (Array.isArray(parsed)) {
    parsed.forEach((item) => {
      if (item && typeof item === 'object') {
        const entry = item as { name?: unknown; url?: unknown; headers?: unknown }
        if (typeof entry.name === 'string' && typeof entry.url === 'string') {
          const headers = Array.isArray(entry.headers)
            ? entry.headers.filter((line): line is string => typeof line === 'string').join('\n')
            : typeof entry.headers === 'string'
              ? entry.headers
              : ''
          out.push(createMcpServer({ name: entry.name, url: entry.url, headers }))
        }
      }
    })
    return out
  }
  if (parsed && typeof parsed === 'object') {
    const root = parsed as { mcpServers?: unknown; servers?: unknown }
    if (root.mcpServers) {
      collect(root.mcpServers)
    } else if (root.servers) {
      if (Array.isArray(root.servers)) {
        return parseMcpConfig(JSON.stringify(root.servers))
      }
      // {"servers": {"名字": {"url": ...}}} 也要认
      collect(root.servers)
    } else {
      collect(parsed)
    }
  }
  return out
}

/** 连接测试：拿工具清单，返回数量或错误文案 */export const testMcpServer = async (server: McpServer): Promise<{ count: number; error?: string }> => {
  cache.delete(server.id)
  try {
    const tools = await mcpListTools(server)
    return { count: tools.length }
  } catch (error) {
    return { count: 0, error: error instanceof Error ? error.message : String(error) }
  }
}
