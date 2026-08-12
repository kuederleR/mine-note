import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { Editor } from './components/Editor'
import { MinePanel } from './components/MinePanel'
import { useAppStore } from './store'
import './App.css'

export default function App() {
  const load = useAppStore((s) => s.load)
  const loading = useAppStore((s) => s.loading)

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="app-shell">
      <div className="atmosphere" aria-hidden />
      {loading ? (
        <div className="boot">
          <div className="brand-name">Mine</div>
          <p>Opening your local library…</p>
        </div>
      ) : (
        <>
          <Sidebar />
          <Editor />
          <MinePanel />
        </>
      )}
    </div>
  )
}
