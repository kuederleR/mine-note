export const MAX_EDITOR_PANES = 4
export const EDITOR_LAYOUT_STORAGE = 'mine.editorLayout'
export const SPLIT_EDGE_RATIO = 0.28
export const SPLIT_EDGE_MIN = 40
export const SPLIT_EDGE_MAX = 88

export type SplitDir = 'row' | 'col'
export type SplitSide = 'left' | 'right' | 'top' | 'bottom'

export type EditorPane = {
  type: 'pane'
  id: string
  tabs: string[]
  activeTabId: string
}

export type SplitGroup = {
  type: 'split'
  id: string
  dir: SplitDir
  children: SplitNode[]
  sizes: number[]
}

export type SplitNode = EditorPane | SplitGroup

export type EditorLayout = {
  root: SplitNode | null
  focusedPaneId: string
}

type LegacyPane = {
  id?: string
  tabs?: string[]
  activeTabId?: string
  size?: number
  type?: string
}

type LegacyLayout = {
  root?: SplitNode | null
  panes?: LegacyPane[]
  focusedPaneId?: string
}

export type WorkspaceDrop =
  | { type: 'empty' }
  | { type: 'split'; paneId: string; side: SplitSide }
  | { type: 'tab'; paneId: string; index?: number }

export function newPaneId(): string {
  return `pane_${Math.random().toString(36).slice(2, 10)}`
}

export function newSplitId(): string {
  return `split_${Math.random().toString(36).slice(2, 10)}`
}

export function emptyLayout(): EditorLayout {
  return { root: null, focusedPaneId: '' }
}

export function layoutWithNote(noteId: string): EditorLayout {
  const id = newPaneId()
  return {
    root: { type: 'pane', id, tabs: [noteId], activeTabId: noteId },
    focusedPaneId: id,
  }
}

export function allPanes(layout: EditorLayout): EditorPane[] {
  return collectPanes(layout.root)
}

function collectPanes(node: SplitNode | null): EditorPane[] {
  if (!node) return []
  if (node.type === 'pane') return [node]
  return node.children.flatMap(collectPanes)
}

export function findPane(layout: EditorLayout, paneId: string): EditorPane | undefined {
  return allPanes(layout).find((pane) => pane.id === paneId)
}

export function focusedNoteId(layout: EditorLayout): string | null {
  return findPane(layout, layout.focusedPaneId)?.activeTabId ?? allPanes(layout)[0]?.activeTabId ?? null
}

export function allTabIds(layout: EditorLayout): string[] {
  return allPanes(layout).flatMap((pane) => pane.tabs)
}

export function findPaneForNote(layout: EditorLayout, noteId: string): EditorPane | undefined {
  return allPanes(layout).find((pane) => pane.tabs.includes(noteId))
}

export function lastPaneIn(node: SplitNode): EditorPane {
  if (node.type === 'pane') return node
  return lastPaneIn(node.children[node.children.length - 1])
}

function unique(ids: string[]): string[] {
  const seen = new Set<string>()
  return ids.filter((id) => {
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function asLayout(input: EditorLayout | LegacyLayout): EditorLayout {
  if (input && 'root' in input) {
    return { root: input.root ?? null, focusedPaneId: input.focusedPaneId || '' }
  }
  const panes = input.panes
  if (!Array.isArray(panes) || !panes.length) return emptyLayout()
  const leaves: EditorPane[] = panes.map((pane) => ({
    type: 'pane',
    id: pane.id || newPaneId(),
    tabs: pane.tabs || [],
    activeTabId: pane.activeTabId || pane.tabs?.[0] || '',
  }))
  const focusedPaneId = input.focusedPaneId || leaves[0].id
  if (leaves.length === 1) return { root: leaves[0], focusedPaneId }
  return {
    root: {
      type: 'split',
      id: newSplitId(),
      dir: 'row',
      children: leaves,
      sizes: panes.map((pane) => (pane.size && pane.size > 0 ? pane.size : 1)),
    },
    focusedPaneId,
  }
}

function normalizeNode(
  node: SplitNode | null,
  validIds: Set<string> | undefined,
  claimed: Set<string>,
): SplitNode | null {
  if (!node) return null
  if (node.type !== 'split') {
    const tabs = unique(
      (node.tabs || []).filter((id) => (!validIds || validIds.has(id)) && !claimed.has(id)),
    )
    for (const id of tabs) claimed.add(id)
    if (!tabs.length) return null
    return {
      type: 'pane',
      id: node.id || newPaneId(),
      tabs,
      activeTabId: tabs.includes(node.activeTabId) ? node.activeTabId : tabs[0],
    }
  }
  const children: SplitNode[] = []
  const sizes: number[] = []
  node.children.forEach((child, i) => {
    const next = normalizeNode(child, validIds, claimed)
    if (!next) return
    const parentSize = node.sizes?.[i] > 0 ? node.sizes[i] : 1
    if (next.type === 'split' && next.dir === node.dir) {
      const total = next.sizes.reduce((sum, size) => sum + size, 0) || next.children.length
      next.children.forEach((grand, gi) => {
        children.push(grand)
        sizes.push(parentSize * ((next.sizes[gi] ?? 1) / total))
      })
      return
    }
    children.push(next)
    sizes.push(parentSize)
  })
  if (!children.length) return null
  if (children.length === 1) return children[0]
  return {
    type: 'split',
    id: node.id || newSplitId(),
    dir: node.dir === 'col' ? 'col' : 'row',
    children,
    sizes,
  }
}

export function normalizeLayout(
  layout: EditorLayout | LegacyLayout,
  validIds?: Set<string>,
): EditorLayout {
  const next = asLayout(layout)
  const root = normalizeNode(next.root, validIds, new Set())
  const panes = collectPanes(root)
  return {
    root,
    focusedPaneId: panes.some((pane) => pane.id === next.focusedPaneId)
      ? next.focusedPaneId
      : panes[0]?.id ?? '',
  }
}

function mapPanes(node: SplitNode | null, fn: (pane: EditorPane) => EditorPane): SplitNode | null {
  if (!node) return null
  if (node.type === 'pane') return fn(node)
  return { ...node, children: node.children.map((child) => mapPanes(child, fn)!) }
}

export function focusNote(layout: EditorLayout, noteId: string): EditorLayout {
  const pane = findPaneForNote(layout, noteId)
  if (!pane) return layout
  return normalizeLayout({
    focusedPaneId: pane.id,
    root: mapPanes(layout.root, (item) =>
      item.id === pane.id ? { ...item, activeTabId: noteId } : item,
    ),
  })
}

export function setActiveTab(layout: EditorLayout, paneId: string, noteId: string): EditorLayout {
  const pane = findPane(layout, paneId)
  if (!pane || !pane.tabs.includes(noteId)) return layout
  return normalizeLayout({
    focusedPaneId: paneId,
    root: mapPanes(layout.root, (item) =>
      item.id === paneId ? { ...item, activeTabId: noteId } : item,
    ),
  })
}

export function setFocusedPane(layout: EditorLayout, paneId: string): EditorLayout {
  if (!findPane(layout, paneId)) return layout
  return { ...layout, focusedPaneId: paneId }
}

export function setSplitSizes(layout: EditorLayout, groupId: string, sizes: number[]): EditorLayout {
  const walk = (node: SplitNode | null): SplitNode | null => {
    if (!node || node.type === 'pane') return node
    if (node.id === groupId) {
      return {
        ...node,
        sizes: node.children.map((_, i) => Math.max(0.15, sizes[i] ?? node.sizes[i] ?? 1)),
      }
    }
    return { ...node, children: node.children.map((child) => walk(child)!) }
  }
  return { ...layout, root: walk(layout.root) }
}

function removeNote(layout: EditorLayout, noteId: string): EditorLayout {
  return normalizeLayout({
    ...layout,
    root: mapPanes(layout.root, (pane) => ({
      ...pane,
      tabs: pane.tabs.filter((id) => id !== noteId),
    })),
  })
}

export function openInPane(
  layout: EditorLayout,
  paneId: string,
  noteId: string,
  index?: number,
): EditorLayout {
  if (!layout.root) return layoutWithNote(noteId)
  const next = removeNote(layout, noteId)
  if (!next.root) return layoutWithNote(noteId)
  const pane =
    findPane(next, paneId) || findPane(next, next.focusedPaneId) || allPanes(next)[0]
  if (!pane) return layoutWithNote(noteId)
  const tabs = [...pane.tabs]
  const at = index == null ? tabs.length : Math.max(0, Math.min(index, tabs.length))
  tabs.splice(at, 0, noteId)
  return normalizeLayout({
    focusedPaneId: pane.id,
    root: mapPanes(next.root, (item) =>
      item.id === pane.id ? { ...item, tabs, activeTabId: noteId } : item,
    ),
  })
}

function dirFor(side: SplitSide): SplitDir {
  return side === 'left' || side === 'right' ? 'row' : 'col'
}

function insertBefore(side: SplitSide): boolean {
  return side === 'left' || side === 'top'
}

function insertSplit(
  node: SplitNode | null,
  paneId: string,
  fresh: EditorPane,
  dir: SplitDir,
  before: boolean,
): SplitNode | null {
  if (!node) return fresh
  if (node.type === 'pane') {
    if (node.id !== paneId) return node
    return {
      type: 'split',
      id: newSplitId(),
      dir,
      children: before ? [fresh, node] : [node, fresh],
      sizes: [1, 1],
    }
  }
  const idx = node.children.findIndex((child) => child.type === 'pane' && child.id === paneId)
  if (idx >= 0) {
    if (node.dir === dir) {
      const children = [...node.children]
      const sizes = [...node.sizes]
      const hostSize = sizes[idx] ?? 1
      const at = before ? idx : idx + 1
      children.splice(at, 0, fresh)
      sizes.splice(at, 0, hostSize)
      return { ...node, children, sizes }
    }
    const wrapped: SplitGroup = {
      type: 'split',
      id: newSplitId(),
      dir,
      children: before ? [fresh, node.children[idx]] : [node.children[idx], fresh],
      sizes: [1, 1],
    }
    const children = [...node.children]
    children[idx] = wrapped
    return { ...node, children }
  }
  return {
    ...node,
    children: node.children.map((child) => insertSplit(child, paneId, fresh, dir, before)!),
  }
}

export function splitPane(
  layout: EditorLayout,
  paneId: string,
  side: SplitSide,
  noteId: string,
): EditorLayout {
  if (!layout.root) return layoutWithNote(noteId)
  const home = findPaneForNote(layout, noteId)
  if (home && home.tabs.length === 1 && home.tabs[0] === noteId && home.id === paneId) {
    return focusNote(layout, noteId)
  }

  const next = removeNote(layout, noteId)
  if (!findPane(next, paneId)) {
    return openInPane(next.root ? next : layout, paneId, noteId)
  }
  if (allPanes(next).length >= MAX_EDITOR_PANES) {
    return openInPane(next, paneId, noteId)
  }

  const fresh: EditorPane = {
    type: 'pane',
    id: newPaneId(),
    tabs: [noteId],
    activeTabId: noteId,
  }
  return normalizeLayout({
    root: insertSplit(next.root, paneId, fresh, dirFor(side), insertBefore(side)),
    focusedPaneId: fresh.id,
  })
}

export function closeTab(layout: EditorLayout, paneId: string, noteId: string): EditorLayout {
  const pane = findPane(layout, paneId)
  if (!pane || !pane.tabs.includes(noteId)) return removeNote(layout, noteId)
  const index = pane.tabs.indexOf(noteId)
  const tabs = pane.tabs.filter((id) => id !== noteId)
  const activeTabId = tabs.includes(pane.activeTabId)
    ? pane.activeTabId
    : tabs[Math.min(index, tabs.length - 1)] || ''
  return normalizeLayout({
    ...layout,
    root: mapPanes(layout.root, (item) =>
      item.id === paneId ? { ...item, tabs, activeTabId } : item,
    ),
  })
}

export function applyWorkspaceDrop(
  layout: EditorLayout,
  noteId: string,
  drop: WorkspaceDrop,
): EditorLayout {
  if (drop.type === 'empty') return layoutWithNote(noteId)
  if (drop.type === 'split') return splitPane(layout, drop.paneId, drop.side, noteId)
  return openInPane(layout, drop.paneId, noteId, drop.index)
}

export function splitEdgePx(size: number): number {
  return Math.min(SPLIT_EDGE_MAX, Math.max(SPLIT_EDGE_MIN, size * SPLIT_EDGE_RATIO))
}

export function hitTestSplitSide(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number; right: number; bottom: number },
  canSplit: boolean,
): SplitSide | 'center' {
  if (!canSplit) return 'center'
  const edgeX = splitEdgePx(rect.width)
  const edgeY = splitEdgePx(rect.height)
  const left = clientX <= rect.left + edgeX ? rect.left + edgeX - clientX : 0
  const right = clientX >= rect.right - edgeX ? clientX - (rect.right - edgeX) : 0
  const top = clientY <= rect.top + edgeY ? rect.top + edgeY - clientY : 0
  const bottom = clientY >= rect.bottom - edgeY ? clientY - (rect.bottom - edgeY) : 0
  const best = Math.max(left, right, top, bottom)
  if (best <= 0) return 'center'
  if (best === left) return 'left'
  if (best === right) return 'right'
  if (best === top) return 'top'
  return 'bottom'
}

export function tabInsertIndex(
  tabs: { id: string; left: number; width: number }[],
  clientX: number,
  draggingId?: string,
): number {
  let index = 0
  for (const tab of tabs) {
    if (tab.id === draggingId) continue
    if (clientX < tab.left + tab.width / 2) return index
    index += 1
  }
  return index
}

export function panesAfterExtract(layout: EditorLayout, noteId: string, paneId?: string): number {
  const home = paneId ? findPane(layout, paneId) : findPaneForNote(layout, noteId)
  const count = allPanes(layout).length
  if (home && home.tabs.length === 1 && home.tabs[0] === noteId) return count - 1
  return count
}

export function readStoredLayout(): EditorLayout | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(EDITOR_LAYOUT_STORAGE)
    if (!raw) return null
    const parsed = JSON.parse(raw) as LegacyLayout
    if (!parsed || (parsed.root === undefined && !Array.isArray(parsed.panes))) return null
    return asLayout(parsed)
  } catch {
    return null
  }
}

export function writeStoredLayout(layout: EditorLayout): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(EDITOR_LAYOUT_STORAGE, JSON.stringify(layout))
  } catch {
    /* ignore quota */
  }
}
