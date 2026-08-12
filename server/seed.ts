import { db } from './db.js'
import { createNote, reindexAll } from './notes.js'
import { warmEmbeddings } from './embeddings.js'

const samples = [
  {
    title: 'Product vision — Mine',
    content: `# Why Mine exists

Mine is a private workspace for thinking in public with yourself. Notes stay on your machine. When you save, each structural piece becomes a searchable component with a local embedding.

> [!IDEA]
> AI should help you *find* and *connect* — not write your opinions for you.

The chat panel is really a natural-language lens over your library. Ask a question and Mine draws a connection graph across components.

## Principles

- Local by default
- Components over blobs
- Graphs over chatty answers
- You decide; Mine maps

Related: [[Research inbox]] and [[Weekly review ritual]]
`,
  },
  {
    title: 'Research inbox',
    content: `# Open threads

Things to dig into without losing the thread.

:::toggle Embedding models for notes
Prefer small sentence transformers that run offline.
\`all-MiniLM-L6-v2\` is a good default: fast, 384 dims, strong enough for personal libraries.
:::

> [!NOTE]
> Keep sources next to claims. Mine can resurface both when you search later.

## Reading list

- Local-first software patterns
- Zettelkasten vs hierarchical notebooks
- Graph UIs that stay calm

- [ ] Skim paper on sparse retrieval
- [ ] Try wiki-link conventions across project notes
- [x] Decide on component boundaries (heading, callout, todo, toggle)

See also [[Product vision — Mine]].
`,
  },
  {
    title: 'Weekly review ritual',
    content: `# Friday shutdown

A light ritual so open loops do not vanish.

## Checklist

- [ ] Scan todos across active notes
- [ ] Promote one idea from [[Research inbox]] into a real note
- [ ] Archive or link stray paragraphs
- [ ] Ask Mine: "What did I leave unfinished this week?"

> [!TIP]
> Search for feelings and friction ("stuck", "unclear", "block") — embeddings catch paraphrases.

## Notes from last week

I kept bouncing between architecture diagrams and copy. The connection graph should make that tension visible: product language ↔ implementation components.

\`\`\`ts
// mental model
note -> components[] -> embeddings[] -> graph search
\`\`\`

Link back to [[Product vision — Mine]].
`,
  },
  {
    title: 'Garden design — courtyard',
    content: `# Courtyard planting

Not work — a palette note so Mine can prove cross-domain search.

> [!IDEA]
> Gravel paths, copper troughs, and deep green herbs. Quiet mineral tones.

## Plants

- Rosemary along the warm wall
- Thyme between stones
- One olive in a wide pot

:::toggle Watering
Deep soak twice a week in summer. Less in shoulder seasons.
:::

Random overlap test: "copper" also appears in Mine's UI language — search should bridge metaphor and material.
`,
  },
]

async function main() {
  const existing = db.prepare(`SELECT COUNT(*) as c FROM notes`).get() as { c: number }
  if (existing.c > 0) {
    console.log(`Seed skipped — ${existing.c} notes already present.`)
    console.log('Reindexing all notes…')
    warmEmbeddings()
    const result = await reindexAll()
    console.log(`Reindexed ${result.notes} notes / ${result.components} components.`)
    return
  }

  console.log('Seeding sample notes…')
  warmEmbeddings()
  for (const sample of samples) {
    const note = await createNote(sample)
    console.log(`  + ${note.title} (${note.componentCount} components)`)
  }
  console.log('Done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
