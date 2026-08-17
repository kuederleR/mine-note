import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { Editor } from './components/Editor'
import { MinePanel } from './components/MinePanel'
import { Settings } from './components/Settings'
import { useAppStore } from './store'
import { applyTheme } from './lib/theme'
import './App.css'

export default function App() {
  const load = useAppStore((s) => s.load)
  const loading = useAppStore((s) => s.loading)
  const flushSave = useAppStore((s) => s.flushSave)
  const undo = useAppStore((s) => s.undo)
  const redo = useAppStore((s) => s.redo)
  const theme = useAppStore((s) => s.workspaceSettings.theme)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    applyTheme(theme || 'system')
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  useEffect(() => {
    const shouldHandleHistory = (target: EventTarget | null) => {
      const el = target as HTMLElement | null
      if (!el) return true
      if (el.closest('.settings-backdrop, .mine-panel, .sidebar')) return false
      return true
    }

    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (!shouldHandleHistory(e.target)) return
      const key = e.key.toLowerCase()
      if (key === 'z' && e.shiftKey) {
        e.preventDefault()
        redo()
        return
      }
      if (key === 'z') {
        e.preventDefault()
        undo()
        return
      }
      if (key === 'y' && !e.shiftKey && e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        redo()
      }
    }

    const flush = () => {
      void flushSave({ keepalive: true })
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush()
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', flush)

    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', flush)
    }
  }, [flushSave, undo, redo])

  return (
    <div className="app-shell">
      {loading ? (
        <div className="boot">
          <div className="brand-name">Mine</div>
          <p>Opening your workspace…</p>
        </div>
      ) : (
        <>
          <Sidebar />
          <Editor />
          <MinePanel />
          <Settings />
        </>
      )}
    </div>
  )
}
