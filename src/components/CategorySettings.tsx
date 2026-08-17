import { useEffect, useRef, useState } from 'react'
import type { Category, CategoryDraft } from '../types'
import { CATEGORY_COLORS, LUCIDE_ICON_NAMES } from '../lib/categoryIcons'
import {
  CATEGORY_AUTO_KEYS,
  draftFromCategory,
  emptyCategoryDraft,
} from '../lib/categoryDraft'
import { CatIcon } from './CatIcon'
import { useAppStore } from '../store'
import { isReservedShortcut } from '../lib/shortcuts'

type Props = {
  category: Category | null
  onCreated: (id: string) => void
}

function lockExisting(draft: CategoryDraft): Set<string> {
  const locked = new Set<string>()
  for (const key of CATEGORY_AUTO_KEYS) {
    const value = draft[key].trim()
    if (!value) continue
    if (key === 'icon' && value === 'Folder') continue
    if (key === 'template' && /^# \{\{title\}\}\s*$/.test(value)) continue
    locked.add(key)
  }
  return locked
}

export function CategoryEditor({ category, onCreated }: Props) {
  const createCategory = useAppStore((s) => s.createCategory)
  const updateCategory = useAppStore((s) => s.updateCategory)
  const deleteCategory = useAppStore((s) => s.deleteCategory)
  const startCategoryBuild = useAppStore((s) => s.startCategoryBuild)
  const patchAgentDraft = useAppStore((s) => s.patchAgentDraft)
  const retargetAgentView = useAppStore((s) => s.retargetAgentView)
  const dismissAgent = useAppStore((s) => s.dismissAgent)
  const generator = useAppStore((s) => s.health?.generator)
  const workspaceSettings = useAppStore((s) => s.workspaceSettings)
  const categoryId = category?.id || 'new'
  const agent = useAppStore((s) =>
    s.agents.find(
      (item) =>
        item.kind === 'category-build' &&
        item.view.kind === 'settings' &&
        item.view.categoryId === categoryId,
    ),
  )
  const [form, setForm] = useState<CategoryDraft>(
    agent?.draft || (category ? draftFromCategory(category) : emptyCategoryDraft()),
  )
  const [saving, setSaving] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [error, setError] = useState<string | null>(agent?.error || null)
  const lockedRef = useRef(new Set(agent?.lockedKeys || []))

  useEffect(() => {
    const current = useAppStore.getState().agents.find(
      (item) =>
        item.kind === 'category-build' &&
        item.view.kind === 'settings' &&
        item.view.categoryId === categoryId,
    )
    if (current?.draft) {
      lockedRef.current = new Set(current.lockedKeys || [])
      setForm(current.draft)
      setError(current.error || null)
      return
    }
    const next = category ? draftFromCategory(category) : emptyCategoryDraft()
    lockedRef.current = category ? lockExisting(next) : new Set()
    setForm(next)
    setError(null)
    setAdvanced(false)
  }, [categoryId])

  useEffect(() => {
    if (!agent) return
    if (agent.lockedKeys) lockedRef.current = new Set(agent.lockedKeys)
    if (agent.draft) setForm(agent.draft)
    setError(agent.error || null)
  }, [agent])

  const generating = agent?.status === 'running'
  const progress = agent?.progress ?? 0
  const status = agent?.message ?? ''

  const syncAgent = (next: CategoryDraft) => {
    if (!agent) return
    patchAgentDraft(agent.id, next, [...lockedRef.current])
  }

  const patch = (next: Partial<CategoryDraft>) => {
    for (const key of CATEGORY_AUTO_KEYS) {
      if (key in next) lockedRef.current.add(key)
    }
    setForm((current) => {
      const updated = { ...current, ...next }
      syncAgent(updated)
      return updated
    })
  }

  const build = () => {
    const name = form.name.trim()
    if (name.length < 2) {
      setError('Type a category name first.')
      return
    }
    setError(null)
    startCategoryBuild({
      categoryId,
      form,
      lockedKeys: [...lockedRef.current],
    })
  }

  const save = async () => {
    if (!form.name.trim()) {
      setError('Name is required')
      return
    }
    if (form.tag && isReservedShortcut(form.tag, workspaceSettings)) {
      setError(`:${form.tag} is reserved. Pick another shortcut.`)
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (category) {
        await updateCategory(category.id, form)
      } else {
        const created = await createCategory(form)
        if (agent) {
          retargetAgentView(agent.id, {
            kind: 'settings',
            section: 'categories',
            categoryId: created.id,
          })
        }
        onCreated(created.id)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="cat-editor">
      <header className="cat-editor-head">
        <h3>{category ? category.name : 'New category'}</h3>
        <p>Type a name, then build. Gemma fills in what belongs here and how pages should be indexed.</p>
      </header>

      <div className="field">
        <span>Name</span>
        <div className="cat-name-row">
          <input
            value={form.name}
            onChange={(e) => {
              const name = e.target.value
              setForm((current) => {
                const updated = { ...current, name }
                syncAgent(updated)
                return updated
              })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                build()
              }
            }}
            placeholder="People"
            disabled={generating}
          />
          <button
            type="button"
            className="btn primary"
            disabled={generating || form.name.trim().length < 2}
            onClick={build}
          >
            {generating ? 'Building…' : 'Build'}
          </button>
        </div>
      </div>

      <div className="field">
        <span>Tag shortcut</span>
        <div className="cat-tag-row">
          <span className="cat-tag-prefix">:</span>
          <input
            value={form.tag}
            onChange={(e) => patch({ tag: e.target.value.replace(/[:\[\]\s]/g, '').slice(0, 8) })}
            placeholder="@"
            maxLength={8}
            aria-label="Tag shortcut"
          />
        </div>
        <em>
          Type <code>:{form.tag || '@'}</code> in a page to link a note in this category.
          Reserved: {workspaceSettings.reservedShortcuts.map((item) => `:${item}`).join(', ')}.
        </em>
        {form.tag && isReservedShortcut(form.tag, workspaceSettings) ? (
          <p className="cat-error">:{form.tag} is reserved for AI or other workspace shortcuts.</p>
        ) : null}
      </div>

      {(generating || status) && (
        <div className="cat-build" aria-live="polite">
          <div
            className="cat-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <div className="cat-progress-bar" style={{ width: `${Math.max(4, Math.round(progress * 100))}%` }} />
          </div>
          <div className="cat-build-status">
            <span>{status || 'Starting build…'}</span>
            <span>{Math.round(progress * 100)}%</span>
          </div>
        </div>
      )}

      {!generating && !status && (
        <p className="field">
          <em>
            {generator?.ready
              ? 'Uses Gemma 4 E2B locally'
              : generator?.pulling
                ? 'Downloading Gemma 4 E2B…'
                : generator?.error || 'Start Ollama for Gemma 4 E2B'}
          </em>
        </p>
      )}

      <label className="field">
        <span>What belongs here</span>
        <textarea
          value={form.description}
          onChange={(e) => patch({ description: e.target.value })}
          rows={2}
          placeholder="People I work with, including collaborators and mentors."
        />
      </label>

      <div className="field">
        <span>Icon</span>
        <div className="icon-picker">
          {LUCIDE_ICON_NAMES.map((name) => (
            <button
              key={name}
              type="button"
              className={`icon-pick ${form.icon === name ? 'active' : ''}`}
              title={name}
              onClick={() => patch({ icon: name })}
            >
              <CatIcon name={name} size={16} />
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span>Color</span>
        <div className="color-row">
          {CATEGORY_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`color-dot ${form.color === c ? 'active' : ''}`}
              style={{ background: c }}
              onClick={() => patch({ color: c })}
              aria-label={c}
            />
          ))}
        </div>
      </div>

      <details className="cat-advanced" open={advanced} onToggle={(e) => setAdvanced(e.currentTarget.open)}>
        <summary>Advanced</summary>
        <label className="field">
          <span>Embedding instruction</span>
          <textarea
            value={form.embedInstruction}
            onChange={(e) => patch({ embedInstruction: e.target.value })}
            rows={3}
            placeholder="How Mine should represent notes in this category."
          />
          <em>Prepended when Mine indexes pages in this category, so they connect to the right questions.</em>
        </label>
        <label className="field">
          <span>Query hints</span>
          <input
            value={form.queryHints}
            onChange={(e) => patch({ queryHints: e.target.value })}
            placeholder="who, person, people"
          />
        </label>
        <label className="field">
          <span>New page template</span>
          <textarea
            className="mono"
            value={form.template}
            onChange={(e) => patch({ template: e.target.value })}
            rows={4}
            placeholder="# {{title}}"
          />
          <em>Use {'{{title}}'} for the page name.</em>
        </label>
      </details>

      {error && (
        <p className="cat-error">
          {error}
          {agent?.status === 'error' ? (
            <>
              {' '}
              <button type="button" className="btn ghost" onClick={() => dismissAgent(agent.id)}>
                Dismiss
              </button>
            </>
          ) : null}
        </p>
      )}

      <footer className="cat-modal-foot">
        {category ? (
          <button
            type="button"
            className="btn ghost danger"
            onClick={() => {
              if (window.confirm(`Delete ${category.name}? Pages stay, without a category.`)) {
                void deleteCategory(category.id)
              }
            }}
          >
            Delete
          </button>
        ) : (
          <span />
        )}
        <div className="cat-modal-actions">
          <button type="button" className="btn primary" disabled={saving || generating} onClick={() => void save()}>
            {saving ? 'Saving…' : category ? 'Save' : 'Create category'}
          </button>
        </div>
      </footer>
    </div>
  )
}
