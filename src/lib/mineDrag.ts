export const MINE_DRAG_MIME = 'application/x-mine-drag'

export type MineDragPayload =
  | { kind: 'note'; id: string; paneId?: string }
  | { kind: 'folder'; id: string }

let current: MineDragPayload | null = null
let clearDrag: (() => void) | null = null

export function peekMineDrag(): MineDragPayload | null {
  return current
}

export function writeMineDrag(
  e: { dataTransfer: DataTransfer | null },
  payload: MineDragPayload,
) {
  clearDrag?.()
  current = payload
  const dt = e.dataTransfer
  if (dt) {
    const raw = JSON.stringify(payload)
    dt.setData(MINE_DRAG_MIME, raw)
    dt.setData('text/plain', raw)
    dt.effectAllowed = 'move'
  }
  const clear = () => {
    if (current === payload) current = null
    window.removeEventListener('dragend', clear)
    if (clearDrag === clear) clearDrag = null
  }
  clearDrag = clear
  window.addEventListener('dragend', clear)
}

export function readMineDrag(e: { dataTransfer: DataTransfer | null }): MineDragPayload | null {
  const dt = e.dataTransfer
  if (!dt) return current
  try {
    const raw = dt.getData(MINE_DRAG_MIME) || dt.getData('text/plain')
    if (!raw) return current
    return JSON.parse(raw) as MineDragPayload
  } catch {
    return current
  }
}
