/**
 * 技能（Skill）：一段 Markdown 指令 + 一句说明。
 *
 * 开启的技能会被拼进 system prompt，让模型按固定套路做事（办公文档、表格、
 * 翻译润色等）。导入方式有两种：
 *   1. 设置里选择 .md / .json 文件，按 DSH 的 SKILL.md 约定解析 front matter；
 *   2. 直接把 skills.json 放进应用私有目录（原生侧 DSK.storage() 给的路径），
 *      下次启动时自动读入。
 */

import { nativeStorage, readNativeFile, writeNativeFile } from '../app/native.js'

export type Skill = {
  id: string
  name: string
  description: string
  instructions: string
  enabled: boolean
  builtin: boolean
  createdAt: number
}

const STORAGE_KEY = 'chat-demo:skills'
const STORE_FILE = 'skills.json'

/** 单个技能注入的上限，防止一份超长文档吃光上下文 */
const MAX_INSTRUCTIONS = 8000
/** 所有技能合计上限 */
const MAX_TOTAL = 24000

const BUILTIN: Omit<Skill, 'createdAt'>[] = [
  {
    id: 'builtin-office',
    name: '办公文档',
    description: '写 Word 稿、PPT 大纲、会议纪要与合同清单，按可直接落地的结构输出',
    enabled: false,
    builtin: true,
    instructions: [
      '你是一位中文办公文档专家。用户要做文档类任务时，遵守：',
      '1. 先给一句结论式摘要，再给正文；不要写「好的，我来帮你」这类客套话。',
      '2. 正式文档用 Markdown 组织：标题分级不超过三级，正文段落不超过 5 行。',
      '3. 需要交付文件时，输出一个完整的 Markdown 代码块，并在代码块前一行写建议文件名（如 report.md）。',
      '4. 涉及 PPT 时，按「每页：标题 / 3-5 条要点 / 讲稿一句」的格式逐页给出，页数按用户要求，不擅自扩写。',
      '5. 表格类内容一律用 Markdown 表格，列不空、单位写清。',
      '6. 不确定的事实标注「待确认」，不要编造人名、金额、日期。',
    ].join('\n'),
  },
  {
    id: 'builtin-sheet',
    name: '数据与表格',
    description: '把数据整理成 CSV / 表格，做口径说明、异常值排查与结论',
    enabled: false,
    builtin: true,
    instructions: [
      '你是一位数据分析助理。处理表格与数据类任务时遵守：',
      '1. 先声明口径：每列的含义、单位、统计区间。',
      '2. 交付 CSV 时用 ```csv 代码块，第一行是表头，不加解释性文字。',
      '3. 计算类结论必须给出算式或中间数，便于复核；无法复核时明确说明是估算。',
      '4. 发现缺失值、重复、量纲不一致时先列出来，再给处理建议。',
      '5. 结论分「数据支持」与「推测」两部分，不把推测写成事实。',
    ].join('\n'),
  },
  {
    id: 'builtin-polish',
    name: '中文润色',
    description: '去 AI 味、收紧句子、保持术语与事实不变的中文改写',
    enabled: false,
    builtin: true,
    instructions: [
      '你是一位中文编辑。改写用户文本时遵守：',
      '1. 只改写法，不改事实、数字、专有名词与引用。',
      '2. 去掉模板化表达（首先/其次/综上所述/值得注意的是/在当今时代）。',
      '3. 长句拆短，一句只说一件事；能删的形容词都删。',
      '4. 保留原文的专业术语；口语化只用于明显非正式语境。',
      '5. 输出「改写后」与「改动说明」两部分，改动说明不超过 5 条。',
    ].join('\n'),
  },
]

const readLocal = (): Skill[] | null => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return null
    }
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isSkill) : null
  } catch {
    return null
  }
}

const isSkill = (value: unknown): value is Skill => {
  if (!value || typeof value !== 'object') {
    return false
  }
  const skill = value as Partial<Skill>
  return (
    typeof skill.id === 'string' &&
    typeof skill.name === 'string' &&
    typeof skill.instructions === 'string' &&
    typeof skill.enabled === 'boolean'
  )
}

const cloneBuiltin = (): Skill[] =>
  BUILTIN.map((skill) => ({ ...skill, createdAt: 0 }))

/**
 * 宽松解析一条导入的技能：只要有指令文本就行，其余字段能省则省。
 * 这样 [{"name":"周报","instructions":"..."}]、[{ "name": ..., "body": ... }]、
 * DSH 导出的对象都能直接吃下去。
 */
const toImportedSkill = (value: unknown): Skill | null => {
  if (!value || typeof value !== 'object') {
    return null
  }
  const item = value as {
    id?: unknown
    name?: unknown
    description?: unknown
    instructions?: unknown
    body?: unknown
    content?: unknown
    prompt?: unknown
    enabled?: unknown
  }
  const candidates = [item.instructions, item.body, item.content, item.prompt]
  const raw = candidates.find((candidate) => typeof candidate === 'string' && candidate.trim())
  if (typeof raw !== 'string') {
    return null
  }
  const instructions = raw.trim().slice(0, MAX_INSTRUCTIONS)
  const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '导入的技能'
  let description = typeof item.description === 'string' ? item.description.trim() : ''
  if (!description) {
    const firstLine = instructions
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .find((line) => line.length > 0 && !line.startsWith('```'))
    description = (firstLine ?? '').slice(0, 120)
  }
  return {
    id:
      typeof item.id === 'string' && item.id
        ? item.id
        : `skill_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    description,
    instructions,
    enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
    builtin: false,
    createdAt: Date.now(),
  }
}

/** 读取技能：优先本地存储，没有时用内置技能；原生外壳里再尝试私有目录的文件 */
export const loadSkills = (): Skill[] => {
  const local = readLocal()
  if (local && local.length > 0) {
    return local
  }
  const file = readNativeFile(STORE_FILE)
  if (file) {
    try {
      const parsed: unknown = JSON.parse(file)
      if (Array.isArray(parsed)) {
        const skills = parsed.filter(isSkill)
        if (skills.length > 0) {
          saveSkills(skills)
          return skills
        }
      }
    } catch {
      // 文件坏了就忽略，用内置技能
    }
  }
  const builtin = cloneBuiltin()
  saveSkills(builtin)
  return builtin
}

export const saveSkills = (skills: Skill[]) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(skills))
  } catch {
    // 存不下时不影响本次使用
  }
  // 同步一份到应用私有目录，方便用 adb 推文件或用文件管理器替换
  writeNativeFile(STORE_FILE, JSON.stringify(skills, null, 2))
}

/** 应用私有目录路径（原生外壳里才有），用来告诉用户把文件放哪 */
export const skillsStorageDir = (): string | null => nativeStorage()?.path ?? null

export const createSkill = (input: {
  name: string
  description?: string
  instructions: string
  builtin?: boolean
}): Skill => ({
  id: `skill_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
  name: input.name.trim() || '未命名技能',
  description: (input.description ?? '').trim(),
  instructions: input.instructions.trim().slice(0, MAX_INSTRUCTIONS),
  enabled: true,
  builtin: input.builtin ?? false,
  createdAt: Date.now(),
})

/**
 * 解析导入的技能文件。
 * 支持 DSH 的 SKILL.md 约定（--- name: / description: --- 的 front matter），
 * 也支持纯 Markdown（用文件名当技能名），以及 {"skills": [...]} / [...] 形式的 JSON。
 */
export const parseSkillFile = (fileName: string, text: string): Skill[] => {
  const trimmed = text.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const list = Array.isArray(parsed)
        ? parsed
        : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { skills?: unknown }).skills)
          ? (parsed as { skills: unknown[] }).skills
          : typeof parsed === 'object' && parsed !== null
            ? [parsed]
            : []
      const skills = list
        .map(toImportedSkill)
        .filter((skill): skill is Skill => skill !== null)
      if (skills.length > 0) {
        return skills
      }
    } catch {
      // 不是 JSON，继续按 Markdown 解析
    }
  }
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(trimmed)
  let name = fileName.replace(/\.(md|markdown|txt)$/i, '')
  let description = ''
  let body = trimmed
  if (front) {
    body = trimmed.slice(front[0].length).trim()
    front[1].split(/\r?\n/).forEach((line) => {
      const match = /^([A-Za-z_-]+)\s*:\s*(.+)$/.exec(line.trim())
      if (!match) {
        return
      }
      const key = match[1].toLowerCase()
      const value = match[2].replace(/^["']|["']$/g, '').trim()
      if (key === 'name') {
        name = value || name
      } else if (key === 'description') {
        description = value
      }
    })
  }
  if (!body) {
    return []
  }
  if (!description) {
    const firstLine = body
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .find((line) => line.length > 0 && !line.startsWith('```'))
    description = (firstLine ?? '').slice(0, 120)
  }
  return [createSkill({ name, description, instructions: body })]
}

/**
 * 把开启的技能拼成 system prompt 的附加段；没有开启的技能时返回空串。
 */
export const skillsPrompt = (skills: Skill[] = loadSkills()): string => {
  const enabled = skills.filter((skill) => skill.enabled && skill.instructions.trim())
  if (enabled.length === 0) {
    return ''
  }
  const parts: string[] = []
  let total = 0
  enabled.forEach((skill) => {
    if (total >= MAX_TOTAL) {
      return
    }
    const body = skill.instructions.slice(0, Math.min(MAX_INSTRUCTIONS, MAX_TOTAL - total))
    total += body.length
    parts.push(`## 技能：${skill.name}\n${body}`)
  })
  return `\n\n# 已启用的技能\n按下面的技能约定工作；与用户当前要求冲突时，以用户要求为准。\n\n${parts.join('\n\n')}`
}
