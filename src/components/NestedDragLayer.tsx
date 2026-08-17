import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { getNestedDrag, subscribeNestedDrag } from '../lib/nestedDrag'

export function NestedDragLayer() {
  const [drag, setDrag] = useState(getNestedDrag)
  useEffect(() => subscribeNestedDrag(() => setDrag(getNestedDrag())), [])
  if (!drag) return null
  return createPortal(
    <div
      className={`live-drag-card nested-drag-card ${drag.settling ? 'settling' : ''}`}
      style={{
        left: drag.x,
        top: drag.y,
        width: drag.width,
        minHeight: drag.height,
      }}
    >
      <div
        className="live-block-html prose"
        dangerouslySetInnerHTML={{ __html: drag.previewHtml || '<p></p>' }}
      />
    </div>,
    document.body,
  )
}
