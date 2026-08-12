import { useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import type { GraphEdge, GraphNode } from '../types'

type Props = {
  nodes: GraphNode[]
  edges: GraphEdge[]
  onSelect: (node: GraphNode) => void
}

type FGNode = GraphNode & { x?: number; y?: number }

const TYPE_COLOR: Record<string, string> = {
  query: '#C06A3A',
  note: '#0F3D38',
  heading: '#1F4D45',
  paragraph: '#3A5C68',
  list: '#3A5C68',
  todo: '#8A5A2B',
  code: '#2F3E46',
  callout: '#6B4F2A',
  toggle: '#3D5A4C',
  quote: '#4A5560',
  wikilink: '#A65D3A',
}

export function ConnectionGraph({ nodes, edges, onSelect }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const fgRef = useRef<{
    d3Force: (name: string) => { strength?: (n: number) => void } | undefined
    zoomToFit: (ms: number, pad: number) => void
  } | null>(null)
  const [size, setSize] = useState({ w: 420, h: 280 })

  const data = useMemo(
    () => ({
      nodes: nodes.map((n) => ({ ...n })),
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
      fgRef.current?.d3Force('charge')?.strength?.(-120)
      fgRef.current?.zoomToFit(400, 40)
    }, 160)
    return () => window.clearTimeout(t)
  }, [data, size.w])

  if (!nodes.length) {
    return <div className="graph-empty">Ask Mine a question to grow a connection map.</div>
  }

  return (
    <div className="graph-wrap" ref={wrapRef}>
      <ForceGraph2D
        ref={fgRef as never}
        graphData={data}
        width={size.w}
        height={size.h}
        backgroundColor="rgba(0,0,0,0)"
        nodeRelSize={6}
        linkColor={(link) => {
          const rel = (link as unknown as GraphEdge).relation
          if (rel === 'query_match') return 'rgba(192,106,58,0.55)'
          if (rel === 'wikilink') return 'rgba(15,61,56,0.45)'
          if (rel === 'similar') return 'rgba(58,92,104,0.4)'
          return 'rgba(30,40,45,0.2)'
        }}
        linkWidth={(link) =>
          Math.max(0.6, ((link as unknown as GraphEdge).weight || 0.3) * 2.2)
        }
        linkDirectionalParticles={1}
        linkDirectionalParticleWidth={1.4}
        linkDirectionalParticleSpeed={0.004}
        onNodeClick={(node) => onSelect(node as unknown as GraphNode)}
        nodeCanvasObject={(node, ctx, globalScale) => {
          const n = node as unknown as FGNode
          const label = n.label
          const fontSize = 11 / globalScale
          const r = n.kind === 'query' ? 8 : n.kind === 'note' ? 7 : 5
          ctx.beginPath()
          ctx.arc(n.x || 0, n.y || 0, r, 0, 2 * Math.PI, false)
          ctx.fillStyle = TYPE_COLOR[n.type] || TYPE_COLOR.paragraph
          ctx.fill()
          if (n.kind === 'query') {
            ctx.strokeStyle = '#F4E6D8'
            ctx.lineWidth = 1.5 / globalScale
            ctx.stroke()
          }
          ctx.font = `${fontSize}px Syne, sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'top'
          ctx.fillStyle = 'rgba(21,32,40,0.85)'
          ctx.fillText(label, n.x || 0, (n.y || 0) + r + 2)
        }}
      />
    </div>
  )
}
