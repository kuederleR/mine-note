import { useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import type { GraphEdge, GraphNode } from '../types'
import { useAppStore } from '../store'

type Props = {
  nodes: GraphNode[]
  edges: GraphEdge[]
  onSelect: (node: GraphNode) => void
  variant?: 'panel' | 'backdrop'
  interactive?: boolean
}

type FGNode = GraphNode & { x?: number; y?: number }

function graphPalette(theme: string | undefined) {
  const dark = theme === 'dark' || document.documentElement.dataset.theme === 'dark'
  if (dark) {
    return {
      accent: '#d47848',
      text: '#cccccc',
      muted: 'rgba(204, 204, 204, 0.46)',
      contrast: '#fff7f2',
    }
  }
  return {
    accent: '#c06a3a',
    text: '#0f3d38',
    muted: 'rgba(15, 61, 56, 0.42)',
    contrast: '#fff7f2',
  }
}

function typeColor(accent: string, text: string, muted: string): Record<string, string> {
  return {
    query: accent,
    note: text,
    heading: accent,
    paragraph: muted,
    list: muted,
    todo: accent,
    code: '#8b6bb0',
    callout: '#2a8f80',
    toggle: accent,
    quote: muted,
    wikilink: accent,
    entity: '#8b6bb0',
    chunk: muted,
  }
}

export function ConnectionGraph({
  nodes,
  edges,
  onSelect,
  variant = 'panel',
  interactive = true,
}: Props) {
  const theme = useAppStore((s) => s.workspaceSettings.theme)
  const wrapRef = useRef<HTMLDivElement>(null)
  const fgRef = useRef<{
    d3Force: (name: string) => { strength?: (n: number) => void } | undefined
    zoomToFit: (ms: number, pad: number) => void
  } | null>(null)
  const posRef = useRef(new Map<string, { x: number; y: number }>())
  const [size, setSize] = useState({ w: 420, h: variant === 'backdrop' ? 420 : 280 })
  const [resolved, setResolved] = useState(() => document.documentElement.dataset.theme || 'light')
  const colors = useMemo(() => graphPalette(resolved), [resolved])
  const typeColors = useMemo(
    () => typeColor(colors.accent, colors.text, colors.muted),
    [colors],
  )

  useEffect(() => {
    const sync = () => setResolved(document.documentElement.dataset.theme || 'light')
    sync()
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', sync)
    const obs = new MutationObserver(sync)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      mq.removeEventListener('change', sync)
      obs.disconnect()
    }
  }, [theme])

  const data = useMemo(
    () => ({
      nodes: nodes.map((n) => {
        const pos = posRef.current.get(n.id)
        return pos ? { ...n, x: pos.x, y: pos.y } : { ...n }
      }),
      links: edges.map((e) => ({
        ...e,
        source: e.source,
        target: e.target,
      })),
    }),
    [nodes, edges],
  )

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => {
      setSize({ w: el.clientWidth || 420, h: el.clientHeight || 280 })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const t = window.setTimeout(() => {
      fgRef.current?.d3Force('charge')?.strength?.(variant === 'backdrop' ? -160 : -120)
      fgRef.current?.zoomToFit(variant === 'backdrop' ? 280 : 400, variant === 'backdrop' ? 28 : 40)
    }, 160)
    return () => window.clearTimeout(t)
  }, [data, size.w, variant])

  if (!nodes.length) {
    return variant === 'backdrop' ? null : (
      <div className="graph-empty">Ask Mine a question to grow a connection map.</div>
    )
  }

  return (
    <div className={`graph-wrap ${variant === 'backdrop' ? 'backdrop' : ''}`} ref={wrapRef}>
      <ForceGraph2D
        ref={fgRef as never}
        graphData={data}
        width={size.w}
        height={size.h}
        backgroundColor="rgba(0,0,0,0)"
        nodeRelSize={6}
        enableNodeDrag={interactive}
        enableZoomInteraction={interactive}
        enablePanInteraction={interactive}
        cooldownTicks={variant === 'backdrop' ? 48 : 80}
        d3AlphaDecay={variant === 'backdrop' ? 0.05 : 0.0228}
        onEngineTick={() => {
          for (const node of data.nodes) {
            const n = node as FGNode
            if (typeof n.x === 'number' && typeof n.y === 'number') {
              posRef.current.set(n.id, { x: n.x, y: n.y })
            }
          }
        }}
        linkColor={(link) => {
          const rel = (link as unknown as GraphEdge).relation
          if (rel === 'query_match') return colors.accent
          if (rel === 'thread' || rel === 'wikilink' || rel === 'mention') return colors.accent
          return colors.muted
        }}
        linkWidth={(link) =>
          Math.max(0.6, ((link as unknown as GraphEdge).weight || 0.3) * 2.2)
        }
        linkDirectionalParticles={variant === 'backdrop' ? 2 : 1}
        linkDirectionalParticleWidth={variant === 'backdrop' ? 2 : 1.4}
        linkDirectionalParticleSpeed={variant === 'backdrop' ? 0.008 : 0.004}
        onNodeClick={(node) => {
          if (interactive) onSelect(node as unknown as GraphNode)
        }}
        nodeCanvasObject={(node, ctx, globalScale) => {
          const n = node as unknown as FGNode
          const label = n.label
          const fontSize = 11 / globalScale
          const r = n.kind === 'query' ? 8 : n.kind === 'note' ? 7 : 5
          ctx.beginPath()
          ctx.arc(n.x || 0, n.y || 0, r, 0, 2 * Math.PI, false)
          ctx.fillStyle =
            n.categoryColor && n.kind === 'note'
              ? n.categoryColor
              : typeColors[n.type] || typeColors.paragraph
          ctx.fill()
          if (n.kind === 'query') {
            ctx.strokeStyle = colors.contrast
            ctx.lineWidth = 1.5 / globalScale
            ctx.stroke()
          }
          ctx.font = `${fontSize}px ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'top'
          ctx.fillStyle = colors.text
          ctx.fillText(label, n.x || 0, (n.y || 0) + r + 2)
        }}
      />
    </div>
  )
}
