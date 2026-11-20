/**
 * 设置里的「扩展」分组：技能与 MCP 服务器。
 *
 * 两者都是「导入一个文件就生效」——技能收 .md / .json，MCP 收 mcpServers 配置；
 * 配置同时写进 localStorage 与原生私有目录，清掉 WebView 数据也还能恢复。
 */

import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Button } from '../base/Button.js'
import { IconTrashOutline16, IconUploadOutline14 } from '../base/icons.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { showToast } from '../base/toastState.js'
import {
  createSkill,
  loadSkills,
  parseSkillFile,
  saveSkills,
  skillsStorageDir,
  type Skill,
} from '../../services/skills.js'
import {
  createMcpServer,
  loadMcpServers,
  parseMcpConfig,
  saveMcpServers,
  testMcpServer,
  type McpServer,
} from '../../services/mcp.js'
import styles from './Extensions.module.css'

export const ExtensionsPanel = () => (
  <div className={styles.panel}>
    <SkillsSection />
    <McpSection />
  </div>
)

// ------------------------------------------------------------------ 技能

type SkillDraft = { id: string | null; name: string; description: string; instructions: string }

const emptyDraft: SkillDraft = { id: null, name: '', description: '', instructions: '' }

const SkillsSection = () => {
  const t = useTranslate()
  const [skills, setSkills] = useState<Skill[]>(() => loadSkills())
  const [draft, setDraft] = useState<SkillDraft | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const storageDir = skillsStorageDir()

  const persist = (next: Skill[]) => {
    setSkills(next)
    saveSkills(next)
  }

  const toggle = (id: string) => {
    persist(skills.map((skill) => (skill.id === id ? { ...skill, enabled: !skill.enabled } : skill)))
  }

  const remove = (id: string) => {
    persist(skills.filter((skill) => skill.id !== id))
  }

  const commit = () => {
    if (!draft) {
      return
    }
    const instructions = draft.instructions.trim()
    if (!instructions) {
      setDraft(null)
      return
    }
    if (draft.id) {
      persist(
        skills.map((skill) =>
          skill.id === draft.id
            ? {
                ...skill,
                name: draft.name.trim() || skill.name,
                description: draft.description.trim(),
                instructions: instructions.slice(0, 8000),
              }
            : skill
        )
      )
    } else {
      persist([
        ...skills,
        createSkill({
          name: draft.name,
          description: draft.description,
          instructions,
        }),
      ])
    }
    setDraft(null)
  }

  const onImport = async (file: File) => {
    const text = await file.text()
    const imported = parseSkillFile(file.name, text)
    if (imported.length === 0) {
      showToast({ key: 'skillImportFailed', type: 'error' })
      return
    }
    const known = new Set(skills.map((skill) => skill.id))
    persist([...skills, ...imported.filter((skill) => !known.has(skill.id))])
    showToast({ key: 'skillImported', params: { name: imported[0].name } })
  }

  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <div>
          <h3 className={styles.sectionTitle}>{t('skillsTitle')}</h3>
          <p className={styles.sectionHint}>{t('skillsDescription')}</p>
        </div>
        <div className={styles.actions}>
          <Button variant="outlined" size="m" onClick={() => inputRef.current?.click()}>
            <IconUploadOutline14 />
            {t('skillImport')}
          </Button>
          <Button variant="outlined" size="m" onClick={() => setDraft(emptyDraft)}>
            {t('skillCreate')}
          </Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".md,.markdown,.txt,.json,text/markdown,application/json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) {
              void onImport(file)
            }
          }}
        />
      </header>

      {skills.length === 0 ? <p className={styles.empty}>{t('skillsEmpty')}</p> : null}

      <ul className={styles.list}>
        {skills.map((skill) => (
          <li key={skill.id} className={styles.item}>
            <button
              type="button"
              role="switch"
              aria-checked={skill.enabled}
              aria-label={skill.name}
              className={clsx(styles.switch, skill.enabled && styles.switchOn)}
              onClick={() => toggle(skill.id)}
            >
              <span className={styles.knob} />
            </button>
            <div className={styles.itemText}>
              <div className={styles.itemTitle}>
                {skill.name}
                {skill.builtin ? <span className={styles.badge}>{t('skillBuiltin')}</span> : null}
              </div>
              {skill.description ? (
                <div className={styles.itemDesc}>{skill.description}</div>
              ) : null}
            </div>
            <div className={styles.itemActions}>
              <button
                type="button"
                className={styles.linkButton}
                onClick={() =>
                  setDraft({
                    id: skill.id,
                    name: skill.name,
                    description: skill.description,
                    instructions: skill.instructions,
                  })
                }
              >
                {t('edit')}
              </button>
              {skill.builtin ? null : (
                <button
                  type="button"
                  aria-label={t('delete')}
                  className={styles.iconButton}
                  onClick={() => remove(skill.id)}
                >
                  <IconTrashOutline16 />
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {draft ? (
        <div className={styles.form}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('skillNameLabel')}</span>
            <input
              className={styles.input}
              value={draft.name}
              placeholder="例如：周报生成"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('skillDescriptionLabel')}</span>
            <input
              className={styles.input}
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('skillInstructionsLabel')}</span>
            <textarea
              className={clsx(styles.input, styles.textarea)}
              rows={8}
              value={draft.instructions}
              placeholder={t('skillInstructionsPlaceholder')}
              onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
            />
          </label>
          <div className={styles.formActions}>
            <Button variant="outlined" size="m" onClick={() => setDraft(null)}>
              {t('cancel')}
            </Button>
            <Button variant="primary" size="m" onClick={commit}>
              {t('confirm')}
            </Button>
          </div>
        </div>
      ) : null}

      {storageDir ? (
        <p className={styles.pathHint}>{t('storageDir', { path: storageDir })}</p>
      ) : null}
    </section>
  )
}

// ------------------------------------------------------------- MCP 服务器

type McpDraft = { id: string | null; name: string; url: string; headers: string }

const emptyServerDraft: McpDraft = { id: null, name: '', url: '', headers: '' }

type TestState = {
  key: TranslationKey
  params?: Record<string, string | number>
  error?: boolean
}

const McpSection = () => {
  const t = useTranslate()
  const [servers, setServers] = useState<McpServer[]>(() => loadMcpServers())
  const [draft, setDraft] = useState<McpDraft | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, TestState>>({})
  const inputRef = useRef<HTMLInputElement>(null)

  const persist = (next: McpServer[]) => {
    setServers(next)
    saveMcpServers(next)
  }

  const toggle = (id: string) => {
    persist(
      servers.map((server) => (server.id === id ? { ...server, enabled: !server.enabled } : server))
    )
  }

  const remove = (id: string) => {
    persist(servers.filter((server) => server.id !== id))
    setResults((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
  }

  const commit = () => {
    if (!draft) {
      return
    }
    const url = draft.url.trim()
    if (!url) {
      return
    }
    if (draft.id) {
      persist(
        servers.map((server) =>
          server.id === draft.id
            ? {
                ...server,
                name: draft.name.trim() || url,
                url,
                headers: draft.headers.trim(),
              }
            : server
        )
      )
    } else {
      persist([...servers, createMcpServer({ name: draft.name, url, headers: draft.headers })])
    }
    setDraft(null)
  }

  const test = async (server: McpServer) => {
    setTesting(server.id)
    setResults((current) => ({ ...current, [server.id]: { key: 'mcpTesting' } }))
    const outcome = await testMcpServer(server)
    const next: TestState = outcome.error
      ? { key: 'mcpTestFailed', params: { message: outcome.error }, error: true }
      : { key: 'mcpTestOk', params: { count: outcome.count } }
    setResults((current) => ({ ...current, [server.id]: next }))
    setTesting(null)
  }

  const onImport = async (file: File) => {
    const imported = parseMcpConfig(await file.text())
    if (imported.length === 0) {
      showToast({ key: 'mcpImportFailed', type: 'error' })
      return
    }
    const known = new Set(servers.map((server) => server.url))
    const fresh = imported.filter((server) => !known.has(server.url))
    persist([...servers, ...fresh])
    showToast({ key: 'mcpImported', params: { count: fresh.length } })
  }

  // 首次进入时如果本地一个都没有，提示可以直接导入（不自动创建）
  useEffect(() => {
    setServers(loadMcpServers())
  }, [])

  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <div>
          <h3 className={styles.sectionTitle}>{t('mcpTitle')}</h3>
          <p className={styles.sectionHint}>{t('mcpDescription')}</p>
        </div>
        <div className={styles.actions}>
          <Button variant="outlined" size="m" onClick={() => inputRef.current?.click()}>
            <IconUploadOutline14 />
            {t('mcpImport')}
          </Button>
          <Button variant="outlined" size="m" onClick={() => setDraft(emptyServerDraft)}>
            {t('mcpAdd')}
          </Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) {
              void onImport(file)
            }
          }}
        />
      </header>

      {servers.length === 0 ? <p className={styles.empty}>{t('mcpEmpty')}</p> : null}

      <ul className={styles.list}>
        {servers.map((server) => {
          const outcome = results[server.id]
          return (
            <li key={server.id} className={styles.item}>
              <button
                type="button"
                role="switch"
                aria-checked={server.enabled}
                aria-label={server.name}
                className={clsx(styles.switch, server.enabled && styles.switchOn)}
                onClick={() => toggle(server.id)}
              >
                <span className={styles.knob} />
              </button>
              <div className={styles.itemText}>
                <div className={styles.itemTitle}>{server.name}</div>
                <div className={styles.itemDesc}>{server.url}</div>
                {outcome ? (
                  <div className={clsx(styles.itemStatus, outcome.error && styles.itemStatusError)}>
                    {t(outcome.key, outcome.params)}
                  </div>
                ) : null}
              </div>
              <div className={styles.itemActions}>
                <button
                  type="button"
                  className={styles.linkButton}
                  disabled={testing === server.id}
                  onClick={() => void test(server)}
                >
                  {testing === server.id ? t('mcpTesting') : t('mcpTest')}
                </button>
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() =>
                    setDraft({
                      id: server.id,
                      name: server.name,
                      url: server.url,
                      headers: server.headers,
                    })
                  }
                >
                  {t('edit')}
                </button>
                <button
                  type="button"
                  aria-label={t('delete')}
                  className={styles.iconButton}
                  onClick={() => remove(server.id)}
                >
                  <IconTrashOutline16 />
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      {draft ? (
        <div className={styles.form}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('mcpNameLabel')}</span>
            <input
              className={styles.input}
              value={draft.name}
              placeholder="例如：公司知识库"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('mcpUrlLabel')}</span>
            <input
              className={styles.input}
              type="url"
              inputMode="url"
              spellCheck={false}
              value={draft.url}
              placeholder="https://example.com/mcp"
              onChange={(event) => setDraft({ ...draft, url: event.target.value })}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('mcpHeadersLabel')}</span>
            <textarea
              className={clsx(styles.input, styles.textarea)}
              rows={3}
              spellCheck={false}
              value={draft.headers}
              placeholder={t('mcpHeadersPlaceholder')}
              onChange={(event) => setDraft({ ...draft, headers: event.target.value })}
            />
          </label>
          <div className={styles.formActions}>
            <Button variant="outlined" size="m" onClick={() => setDraft(null)}>
              {t('cancel')}
            </Button>
            <Button variant="primary" size="m" onClick={commit}>
              {t('confirm')}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
