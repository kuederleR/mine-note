import { useEffect, useState } from 'react'
import { Bot, Bell, Plus, X, FolderOpen, GitBranch, RefreshCw, ClipboardPaste, Monitor, Sun, Moon } from 'lucide-react'
import { useAppStore } from '../store'
import { CategoryEditor } from './CategorySettings'
import { CatIcon } from './CatIcon'
import { DEFAULT_REMINDER_COLUMNS, normalizeShortcut } from '../lib/shortcuts'
import { applyTheme } from '../lib/theme'
import type { ObjectPasteMode, ReminderColumn, ThemeMode } from '../types'

export function Settings() {
  const open = useAppStore((s) => s.settingsOpen)
  const closeSettings = useAppStore((s) => s.closeSettings)
  const openSettings = useAppStore((s) => s.openSettings)
  const categories = useAppStore((s) => s.categories)
  const settingsCategoryId = useAppStore((s) => s.settingsCategoryId)
  const health = useAppStore((s) => s.health)
  const section = useAppStore((s) => s.settingsSection)
  const setSettingsSection = useAppStore((s) => s.setSettingsSection)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, closeSettings])

  if (!open) return null

  const selected =
    settingsCategoryId && settingsCategoryId !== 'new'
      ? categories.find((c) => c.id === settingsCategoryId) || null
      : null

  return (
    <div className="settings-backdrop" onClick={closeSettings}>
      <div className="settings-page" role="dialog" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <div>
            <div className="mine-kicker">Workspace</div>
            <h2 id="settings-title">Settings</h2>
          </div>
          <button type="button" className="icon-btn" onClick={closeSettings} aria-label="Close settings">
            ✕
          </button>
        </header>

        <div className="settings-body">
          <nav className="settings-nav">
            <button
              type="button"
              className={section === 'appearance' ? 'active' : ''}
              onClick={() => setSettingsSection('appearance')}
            >
              Appearance
            </button>
            <button
              type="button"
              className={section === 'categories' ? 'active' : ''}
              onClick={() => setSettingsSection('categories')}
            >
              Categories
            </button>
            <button
              type="button"
              className={section === 'models' ? 'active' : ''}
              onClick={() => setSettingsSection('models')}
            >
              Models
            </button>
            <button
              type="button"
              className={section === 'shortcuts' ? 'active' : ''}
              onClick={() => setSettingsSection('shortcuts')}
            >
              Shortcuts
            </button>
            <button
              type="button"
              className={section === 'reminders' ? 'active' : ''}
              onClick={() => setSettingsSection('reminders')}
            >
              Reminders
            </button>
            <button
              type="button"
              className={section === 'storage' ? 'active' : ''}
              onClick={() => setSettingsSection('storage')}
            >
              Storage
            </button>
          </nav>

          {section === 'appearance' ? (
            <AppearanceSettings />
          ) : section === 'categories' ? (
            <div className="settings-split">
              <div className="settings-list">
                <button
                  type="button"
                  className={`settings-item ${settingsCategoryId === 'new' || !settingsCategoryId ? 'active' : ''}`}
                  onClick={() => openSettings('new')}
                >
                  New category
                </button>
                {categories.map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    className={`settings-item ${selected?.id === category.id ? 'active' : ''}`}
                    onClick={() => openSettings(category.id)}
                  >
                    <CatIcon name={category.icon} color={category.color} size={16} />
                    <span>{category.name}</span>
                    {category.tag ? <span className="muted tiny">:{category.tag}</span> : null}
                    <span className="muted tiny">{category.noteCount}</span>
                  </button>
                ))}
              </div>
              <CategoryEditor
                key={selected?.id || 'new'}
                category={selected}
                onCreated={(id) => openSettings(id)}
              />
            </div>
          ) : section === 'shortcuts' ? (
            <ShortcutsSettings />
          ) : section === 'reminders' ? (
            <RemindersSettings />
          ) : section === 'storage' ? (
            <StorageSettingsPanel />
          ) : (
            <div className="settings-models">
              <ModelCard
                title="Embeddings"
                model={health?.embeddings.model || 'MiniLM'}
                ready={Boolean(health?.embeddings.ready)}
                warming={Boolean(health?.embeddings.warming)}
                error={health?.embeddings.error}
                detail="Used to search notes and match categories."
              />
              <ModelCard
                title="Generator"
                model={health?.generator?.model || 'gemma4:e2b'}
                ready={Boolean(health?.generator?.ready)}
                warming={Boolean(health?.generator?.warming || health?.generator?.pulling)}
                error={health?.generator?.error}
                detail="Gemma via Ollama writes Mine Objects and category drafts. Tokens stream live while creating. Override with GEMMA_MODEL if you want a smaller/faster tag."
              />
              {health?.generator?.error && (
                <p className="muted">
                  Install <a href="https://ollama.com">Ollama</a>, then run <code>ollama pull gemma4:e2b</code>.
                  Keep Ollama running so the model stays warm in memory.
                </p>
              )}
              {!health?.generator?.error && (
                <p className="muted">
                  Speed tips: leave Ollama open (model stays loaded), prefer Apple Silicon Metal, or set{' '}
                  <code>GEMMA_MODEL</code> to a smaller tag if you want snappier drafts.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function AppearanceSettings() {
  const theme = useAppStore((s) => s.workspaceSettings.theme) || 'system'
  const save = useAppStore((s) => s.saveWorkspaceSettings)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setTheme = async (next: ThemeMode) => {
    setSaving(true)
    setError(null)
    applyTheme(next)
    try {
      await save({ theme: next })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save appearance')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-models shortcuts-settings">
      <article className="model-card">
        <header>
          <h3>Theme</h3>
        </header>
        <p>Clay buttons and the teal mark stay; dark mode uses a VS Code–style gray workspace. System tracks your OS appearance.</p>
        <div className="theme-mode-list" role="radiogroup" aria-label="Color theme">
          {(
            [
              ['system', 'System', 'Match the operating system', Monitor],
              ['light', 'Light', 'Mist pages with clay buttons', Sun],
              ['dark', 'Dark', 'Gray workspace, same clay accents', Moon],
            ] as Array<[ThemeMode, string, string, typeof Monitor]>
          ).map(([value, label, hint, Icon]) => (
            <label key={value} className={`paste-mode-option ${theme === value ? 'active' : ''}`}>
              <input
                type="radio"
                name="theme-mode"
                value={value}
                checked={theme === value}
                disabled={saving}
                onChange={() => void setTheme(value)}
              />
              <Icon size={16} />
              <span>
                <strong>{label}</strong>
                <em>{hint}</em>
              </span>
            </label>
          ))}
        </div>
        {error ? <p className="cat-error">{error}</p> : null}
      </article>
    </div>
  )
}

function ModelCard({
  title,
  model,
  ready,
  warming,
  error,
  detail,
}: {
  title: string
  model: string
  ready: boolean
  warming: boolean
  error?: string | null
  detail: string
}) {
  const status = ready ? 'Ready' : error ? 'Unavailable' : warming ? 'Warming…' : 'Idle'
  return (
    <article className="model-card">
      <header>
        <h3>{title}</h3>
        <span className={`pill-status ${ready ? 'on' : ''}`}>
          <span className={`dot ${ready ? 'on' : error ? '' : 'warm'}`} />
          {status}
        </span>
      </header>
      <code>{model}</code>
      <p>{detail}</p>
      {error ? <p className="cat-error">{error}</p> : null}
    </article>
  )
}

function ShortcutsSettings() {
  const settings = useAppStore((s) => s.workspaceSettings)
  const save = useAppStore((s) => s.saveWorkspaceSettings)
  const [aiShortcut, setAiShortcut] = useState(settings.aiShortcut)
  const [reminderShortcut, setReminderShortcut] = useState(settings.reminderShortcut)
  const [extra, setExtra] = useState(
    settings.reservedShortcuts.filter(
      (item) => item !== settings.aiShortcut && item !== settings.reminderShortcut,
    ),
  )
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setAiShortcut(settings.aiShortcut)
    setReminderShortcut(settings.reminderShortcut)
    setExtra(
      settings.reservedShortcuts.filter(
        (item) => item !== settings.aiShortcut && item !== settings.reminderShortcut,
      ),
    )
  }, [settings])

  const persist = async (nextAi: string, nextReminder: string, nextExtra: string[]) => {
    const ai = normalizeShortcut(nextAi) || '>'
    const reminder = normalizeShortcut(nextReminder) || '!'
    const reserved = [...new Set([ai, reminder, ...nextExtra.map(normalizeShortcut).filter(Boolean)])]
    setSaving(true)
    setError(null)
    try {
      await save({ aiShortcut: ai, reminderShortcut: reminder, reservedShortcuts: reserved })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save shortcuts')
    } finally {
      setSaving(false)
    }
  }

  const addExtra = () => {
    const tag = normalizeShortcut(draft)
    if (!tag || tag === normalizeShortcut(aiShortcut) || tag === normalizeShortcut(reminderShortcut) || extra.includes(tag)) {
      setDraft('')
      return
    }
    const next = [...extra, tag]
    setExtra(next)
    setDraft('')
    void persist(aiShortcut, reminderShortcut, next)
  }

  return (
    <div className="settings-models shortcuts-settings">
      <article className="model-card">
        <header>
          <h3>AI shortcut</h3>
          <Bot size={16} />
        </header>
        <p>Type this after a colon to insert an inline AI block in a note.</p>
        <div className="cat-tag-row shortcut-row">
          <span className="cat-tag-prefix">:</span>
          <input
            value={aiShortcut}
            maxLength={8}
            aria-label="AI shortcut"
            onChange={(e) => setAiShortcut(normalizeShortcut(e.target.value))}
            onBlur={() => void persist(aiShortcut, reminderShortcut, extra)}
          />
        </div>
        <em>
          Typing <code>:{aiShortcut || '>'}</code> opens Explore / Create in the page.
        </em>
      </article>

      <article className="model-card">
        <header>
          <h3>Reminder shortcut</h3>
          <Bell size={16} />
        </header>
        <p>Type this after a colon to insert a reminder object in a note.</p>
        <div className="cat-tag-row shortcut-row">
          <span className="cat-tag-prefix">:</span>
          <input
            value={reminderShortcut}
            maxLength={8}
            aria-label="Reminder shortcut"
            onChange={(e) => setReminderShortcut(normalizeShortcut(e.target.value))}
            onBlur={() => void persist(aiShortcut, reminderShortcut, extra)}
          />
        </div>
        <em>
          Typing <code>:{reminderShortcut || '!'}</code> drops a reminder into the page.
        </em>
      </article>

      <article className="model-card">
        <header>
          <h3>Object paste</h3>
          <ClipboardPaste size={16} />
        </header>
        <p>
          After you copy an object, Ctrl/Cmd+V uses this action. Right-click still offers paste content, paste
          link, and embed.
        </p>
        <div className="paste-mode-list" role="radiogroup" aria-label="Default object paste">
          {(
            [
              ['link', 'Paste link', 'Insert a chip that opens the original object.'],
              ['content', 'Paste content', 'Insert an independent copy with a new id.'],
              ['embed', 'Embed object', 'Live copy. Editing updates every note that embeds it.'],
            ] as Array<[ObjectPasteMode, string, string]>
          ).map(([value, label, hint]) => (
            <label key={value} className={`paste-mode-option ${settings.objectPasteMode === value ? 'active' : ''}`}>
              <input
                type="radio"
                name="object-paste-mode"
                value={value}
                checked={(settings.objectPasteMode || 'link') === value}
                disabled={saving}
                onChange={() => {
                  void save({ objectPasteMode: value }).catch((e) => {
                    setError(e instanceof Error ? e.message : 'Could not save paste setting')
                  })
                }}
              />
              <span>
                <strong>{label}</strong>
                <em>{hint}</em>
              </span>
            </label>
          ))}
        </div>
      </article>

      <article className="model-card">
        <header>
          <h3>Reserved shortcuts</h3>
        </header>
        <p>Category mentions cannot use these. AI and reminder shortcuts are always reserved.</p>
        <ul className="shortcut-list">
          <li>
            <code>:{aiShortcut || '>'}</code>
            <span className="muted tiny">AI</span>
          </li>
          <li>
            <code>:{reminderShortcut || '!'}</code>
            <span className="muted tiny">Reminder</span>
          </li>
          {extra.map((item) => (
            <li key={item}>
              <code>:{item}</code>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Allow :${item} for categories`}
                disabled={saving}
                onClick={() => {
                  const next = extra.filter((row) => row !== item)
                  setExtra(next)
                  void persist(aiShortcut, reminderShortcut, next)
                }}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
        <form
          className="shortcut-add"
          onSubmit={(e) => {
            e.preventDefault()
            addExtra()
          }}
        >
          <div className="cat-tag-row shortcut-row">
            <span className="cat-tag-prefix">:</span>
            <input
              value={draft}
              maxLength={8}
              placeholder="%"
              aria-label="Add reserved shortcut"
              onChange={(e) => setDraft(normalizeShortcut(e.target.value))}
            />
          </div>
          <button type="submit" className="btn ghost" disabled={!draft.trim() || saving}>
            Reserve
          </button>
        </form>
        {error ? <p className="cat-error">{error}</p> : null}
      </article>
    </div>
  )
}

function RemindersSettings() {
  const settings = useAppStore((s) => s.workspaceSettings)
  const save = useAppStore((s) => s.saveWorkspaceSettings)
  const [columns, setColumns] = useState<ReminderColumn[]>(
    settings.reminderColumns?.length ? settings.reminderColumns : DEFAULT_REMINDER_COLUMNS,
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setColumns(settings.reminderColumns?.length ? settings.reminderColumns : DEFAULT_REMINDER_COLUMNS)
  }, [settings.reminderColumns])

  const persist = async (next: ReminderColumn[]) => {
    setSaving(true)
    setError(null)
    try {
      await save({ reminderColumns: next })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save columns')
    } finally {
      setSaving(false)
    }
  }

  const update = (index: number, patch: Partial<ReminderColumn>) => {
    const next = columns.map((col, i) => (i === index ? { ...col, ...patch } : { ...col }))
    if (patch.done) {
      next.forEach((col, i) => {
        if (i !== index) col.done = false
      })
    }
    setColumns(next)
    void persist(next)
  }

  return (
    <div className="settings-models shortcuts-settings">
      <article className="model-card">
        <header>
          <h3>Kanban columns</h3>
        </header>
        <p>These columns appear on the Reminders board. Reminders in notes use the same statuses.</p>
        <ul className="kanban-settings">
          {columns.map((col, index) => (
            <li key={col.id}>
              <input
                value={col.label}
                aria-label="Column name"
                onChange={(e) => {
                  const next = columns.map((item, i) =>
                    i === index ? { ...item, label: e.target.value } : item,
                  )
                  setColumns(next)
                }}
                onBlur={() => void persist(columns)}
              />
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(col.done)}
                  onChange={(e) => update(index, { done: e.target.checked })}
                />
                Completed
              </label>
              <button
                type="button"
                className="icon-btn"
                aria-label="Move up"
                disabled={index === 0 || saving}
                onClick={() => {
                  const next = [...columns]
                  const [item] = next.splice(index, 1)
                  next.splice(index - 1, 0, item)
                  setColumns(next)
                  void persist(next)
                }}
              >
                ↑
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="Move down"
                disabled={index === columns.length - 1 || saving}
                onClick={() => {
                  const next = [...columns]
                  const [item] = next.splice(index, 1)
                  next.splice(index + 1, 0, item)
                  setColumns(next)
                  void persist(next)
                }}
              >
                ↓
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="Remove column"
                disabled={columns.length < 2 || saving}
                onClick={() => {
                  const next = columns.filter((_, i) => i !== index)
                  if (!next.some((item) => item.done) && next.length) next[next.length - 1].done = true
                  setColumns(next)
                  void persist(next)
                }}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="btn ghost"
          disabled={saving}
          onClick={() => {
            const next = [
              ...columns,
              { id: `col_${Math.random().toString(36).slice(2, 8)}`, label: 'New column' },
            ]
            setColumns(next)
            void persist(next)
          }}
        >
          <Plus size={14} /> Add column
        </button>
        {error ? <p className="cat-error">{error}</p> : null}
      </article>
    </div>
  )
}

function StorageSettingsPanel() {
  const storage = useAppStore((s) => s.storageSettings)
  const gitStatus = useAppStore((s) => s.gitStatus)
  const loadStorageSettings = useAppStore((s) => s.loadStorageSettings)
  const saveStorageSettings = useAppStore((s) => s.saveStorageSettings)
  const refreshGitStatus = useAppStore((s) => s.refreshGitStatus)
  const initGitRepo = useAppStore((s) => s.initGitRepo)
  const syncGitRepo = useAppStore((s) => s.syncGitRepo)
  const [notesDir, setNotesDir] = useState(storage?.notesDir || '')
  const [gitEnabled, setGitEnabled] = useState(Boolean(storage?.gitEnabled))
  const [copyExisting, setCopyExisting] = useState(true)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void loadStorageSettings()
  }, [loadStorageSettings])

  useEffect(() => {
    if (!storage) return
    setNotesDir(storage.notesDir)
    setGitEnabled(storage.gitEnabled)
  }, [storage])

  const persist = async () => {
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      const pathChanged = Boolean(storage && notesDir.trim() && notesDir.trim() !== storage.notesDir)
      await saveStorageSettings({
        notesDir: notesDir.trim() || undefined,
        gitEnabled,
        copyExisting: pathChanged ? copyExisting : false,
      })
      setMessage(pathChanged ? 'Notes folder updated.' : 'Storage settings saved.')
      if (gitEnabled) await refreshGitStatus()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save storage settings')
    } finally {
      setSaving(false)
    }
  }

  const onSync = async () => {
    setSyncing(true)
    setError(null)
    setMessage(null)
    try {
      const result = await syncGitRepo()
      if (result.ok) setMessage(result.message)
      else setError(result.message)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="settings-models shortcuts-settings">
      <article className="model-card">
        <header>
          <h3>Notes folder</h3>
          <FolderOpen size={16} />
        </header>
        <p>
          Mine stores your database (<code>mine.db</code>) and note workspace files in this folder.
          Use an absolute path, or <code>~/Notes/Mine</code>.
        </p>
        <label className="storage-label" htmlFor="notes-dir">
          Folder path
        </label>
        <input
          id="notes-dir"
          className="storage-path"
          value={notesDir}
          placeholder={storage?.defaultNotesDir || '~/Documents/Mine'}
          onChange={(e) => setNotesDir(e.target.value)}
        />
        {storage ? (
          <p className="muted tiny storage-meta">
            Database: <code>{storage.dbPath}</code>
            {storage.configPath ? (
              <>
                <br />
                App config: <code>{storage.configPath}</code>
              </>
            ) : null}
          </p>
        ) : null}
        {storage && notesDir.trim() && notesDir.trim() !== storage.notesDir ? (
          <label className="reminders-hide storage-check">
            <input
              type="checkbox"
              checked={copyExisting}
              onChange={(e) => setCopyExisting(e.target.checked)}
            />
            Copy current database into the new folder
          </label>
        ) : null}
        <button type="button" className="btn primary" disabled={saving} onClick={() => void persist()}>
          {saving ? 'Saving…' : 'Save storage'}
        </button>
      </article>

      <article className="model-card">
        <header>
          <h3>Git</h3>
          <GitBranch size={16} />
        </header>
        <p>
          Treat the notes folder as a git repository and sync with a remote (usually{' '}
          <code>origin</code>).
        </p>
        <label className="reminders-hide storage-check">
          <input
            type="checkbox"
            checked={gitEnabled}
            onChange={(e) => setGitEnabled(e.target.checked)}
          />
          Notes folder is a git repository
        </label>
        <div className="storage-actions">
          <button type="button" className="btn ghost" disabled={saving} onClick={() => void persist()}>
            Save git preference
          </button>
          {gitEnabled ? (
            <>
              <button
                type="button"
                className="btn ghost"
                disabled={syncing}
                onClick={() => void initGitRepo().then(() => refreshGitStatus())}
              >
                Init repo
              </button>
              <button type="button" className="btn primary" disabled={syncing} onClick={() => void onSync()}>
                <RefreshCw size={14} />
                {syncing ? 'Syncing…' : 'Sync'}
              </button>
              <button
                type="button"
                className="btn ghost"
                disabled={syncing}
                onClick={() => void refreshGitStatus()}
              >
                Refresh status
              </button>
            </>
          ) : null}
        </div>
        {gitEnabled && gitStatus ? (
          <div className="git-status">
            {gitStatus.error ? <p className="cat-error">{gitStatus.error}</p> : null}
            <p className="muted">
              {gitStatus.isRepo ? (
                <>
                  Branch <code>{gitStatus.branch || '—'}</code>
                  {gitStatus.remote ? (
                    <>
                      {' '}
                      · remote <code>{gitStatus.remote}</code>
                    </>
                  ) : (
                    ' · no origin remote'
                  )}
                  <br />
                  {gitStatus.dirty ? 'Uncommitted changes' : 'Clean working tree'}
                  {gitStatus.ahead || gitStatus.behind ? ` · ↑${gitStatus.ahead} ↓${gitStatus.behind}` : null}
                  {gitStatus.lastMessage ? (
                    <>
                      <br />
                      Last commit: {gitStatus.lastMessage}
                    </>
                  ) : null}
                </>
              ) : (
                'Not a git repository yet — click Init repo, then add an origin remote in the terminal.'
              )}
            </p>
          </div>
        ) : null}
      </article>

      {message ? <p className="muted">{message}</p> : null}
      {error ? <p className="cat-error">{error}</p> : null}
    </div>
  )
}
