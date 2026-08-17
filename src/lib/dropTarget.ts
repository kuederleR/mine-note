import { findLiveMarkdownAt } from './mineDocTransfer'

/** Shared hit-testing + hover feedback for dropping objects into slots/cells. */

let hoverSlot: HTMLElement | null = null

function cellPrimarySlot(cell: HTMLElement): HTMLElement | null {
  return cell.querySelector(':scope > [data-object-slot]') as HTMLElement | null
}

function isExcluded(slot: HTMLElement, exclude: HTMLElement | null | undefined): boolean {
  if (!exclude) return false
  if (exclude === slot || exclude.contains(slot) || slot.contains(exclude)) return true
  return false
}

/**
 * Pick the best object slot under (or near) a point.
 * Table cells use the full cell rect so drops are easy even on borders/padding.
 * Scoped to the note pane under the pointer so cross-note drags don't hit the source.
 */
export function findObjectSlotAt(
  clientX: number,
  clientY: number,
  exclude?: HTMLElement | null,
): HTMLElement | null {
  const host = findLiveMarkdownAt(clientX, clientY)
  const under = document.elementFromPoint(clientX, clientY) as HTMLElement | null

  if (under) {
    const direct = under.closest('[data-object-slot]') as HTMLElement | null
    if (direct && !isExcluded(direct, exclude) && (!host || host.contains(direct))) return direct

    const cell = under.closest('td, th') as HTMLElement | null
    if (cell && (!host || host.contains(cell))) {
      const slot = cellPrimarySlot(cell)
      if (slot && !isExcluded(slot, exclude)) return slot
    }
  }

  return nearestTableCellSlot(clientX, clientY, exclude, host)
}

function nearestTableCellSlot(
  clientX: number,
  clientY: number,
  exclude?: HTMLElement | null,
  scope?: HTMLElement | null,
): HTMLElement | null {
  let best: { el: HTMLElement; dist: number } | null = null
  const tables = scope
    ? scope.querySelectorAll('.note-table')
    : document.querySelectorAll('.note-table')

  for (const table of tables) {
    const tableRect = table.getBoundingClientRect()
    const pad = 20
    if (
      clientX < tableRect.left - pad ||
      clientX > tableRect.right + pad ||
      clientY < tableRect.top - pad ||
      clientY > tableRect.bottom + pad
    ) {
      continue
    }

    for (const cell of table.querySelectorAll('td, th')) {
      const el = cell as HTMLElement
      const slot = cellPrimarySlot(el)
      if (!slot || isExcluded(slot, exclude)) continue
      const rect = el.getBoundingClientRect()
      if (rect.width < 4 || rect.height < 4) continue
      const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0
      const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0
      const dist = Math.hypot(dx, dy)
      const score = dist === 0 ? -rect.width * rect.height : dist
      if (!best || score < best.dist) best = { el: slot, dist: score }
    }
  }

  if (!best) return null
  if (best.dist > 0 && best.dist > 18) return null
  return best.el
}

export function setDropHover(slot: HTMLElement | null) {
  if (hoverSlot === slot) return
  if (hoverSlot) {
    delete hoverSlot.dataset.dropHover
    hoverSlot.closest('td, th')?.classList.remove('is-drop-target')
  }
  hoverSlot = slot
  if (slot) {
    slot.dataset.dropHover = '1'
    slot.closest('td, th')?.classList.add('is-drop-target')
  }
}

export function clearDropHover() {
  setDropHover(null)
}

export function setObjectDragging(active: boolean) {
  document.body.classList.toggle('is-object-dragging', active)
  if (!active) clearDropHover()
}
