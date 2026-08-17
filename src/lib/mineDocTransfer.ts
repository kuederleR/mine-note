export const MINE_DOC_INSERT = 'mine-doc-insert'

export type MineDocInsertDetail = {
  markdown: string
  clientY: number
  /** nested = takeNestedDrag + remove source object; block = source LiveMarkdown removes the leaf */
  mode: 'nested' | 'block'
}

export function dispatchMineDocInsert(
  target: HTMLElement,
  detail: MineDocInsertDetail,
) {
  target.dispatchEvent(
    new CustomEvent<MineDocInsertDetail>(MINE_DOC_INSERT, {
      detail,
      bubbles: false,
    }),
  )
}

/**
 * Find a note editor surface under the pointer.
 * Matches the whole note pane (title, body, padding), not only the markdown root,
 * so cross-pane drops feel continuous.
 */
export function findLiveMarkdownAt(
  clientX: number,
  clientY: number,
  exclude?: HTMLElement | null,
): HTMLElement | null {
  const under = document.elementFromPoint(clientX, clientY) as HTMLElement | null
  if (under) {
    const direct = under.closest('[data-live-md]') as HTMLElement | null
    if (direct && direct !== exclude) return direct

    const pane = under.closest('.note-pane') as HTMLElement | null
    if (pane) {
      const md = pane.querySelector('[data-live-md]') as HTMLElement | null
      if (md && md !== exclude) return md
    }
  }

  for (const candidate of document.querySelectorAll('.note-pane')) {
    const pane = candidate as HTMLElement
    const rect = pane.getBoundingClientRect()
    if (
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      continue
    }
    const md = pane.querySelector('[data-live-md]') as HTMLElement | null
    if (md && md !== exclude) return md
  }
  return null
}

export function gapGhostAtY(
  root: HTMLElement,
  clientY: number,
): { x: number; y: number; w: number; h: number; mode: 'gap'; index: number } {
  const leaves = [...root.querySelectorAll('[data-block-index]')] as HTMLElement[]
  for (const el of leaves) {
    const rect = el.getBoundingClientRect()
    const index = Number(el.getAttribute('data-block-index'))
    if (!Number.isFinite(index)) continue
    if (clientY < rect.top + rect.height / 2) {
      return { x: rect.left, y: rect.top - 2, w: rect.width, h: 4, mode: 'gap', index }
    }
  }
  const tail = root.querySelector('.live-md-tail') as HTMLElement | null
  const rect = tail?.getBoundingClientRect()
  return {
    x: rect?.left ?? 0,
    y: rect?.top ?? clientY,
    w: rect?.width ?? 240,
    h: 4,
    mode: 'gap',
    index: leaves.length,
  }
}

export function insertIndexAtY(root: HTMLElement, clientY: number, fallbackLength: number): number {
  return gapGhostAtY(root, clientY).index ?? fallbackLength
}
