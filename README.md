# Mine

**Mine** is a Notion-inspired note app where every AI feature stays local and private.

Notes are markdown with useful special components. On save, each note is split into structural **components** (headings, paragraphs, todos, callouts, toggles, code, wiki links). A local embedding model indexes those components. The **Mine** panel on the right is not a chatty assistant — it is a natural-language search that builds a **connection graph** across your library: a searchable, dynamic mind map.

## Features

- Markdown editor with write / preview modes
- Special blocks: callouts (`> [!NOTE]`), toggles (`:::toggle`), todos, wiki links (`[[Note]]`)
- Local component embeddings (`Xenova/all-MiniLM-L6-v2` via Transformers.js, with hashed fallback)
- SQLite component + embedding store
- Mine search panel with force-directed connection graph
- Fully local — no cloud LLM calls

## Quick start

```bash
npm install
npm run seed    # sample notes + local embeddings
npm run dev     # API on :8787, Vite on :5173
```

Open [http://localhost:5173](http://localhost:5173).

Shortcuts: `⌘/Ctrl+S` save & embed · `⌘/Ctrl+K` open Mine · `Esc` close Mine.

## Architecture

```
note (markdown)
  → parser → components[]
  → local embedder → Float32 vectors
  → SQLite (notes + components + embeddings)
  → Mine search → similarity + wiki/same-note edges → graph
```

## Scripts

| Command | Purpose |
|--------|---------|
| `npm run dev` | Concurrent API + web |
| `npm run seed` | Seed demo library / reindex |
| `npm run build` | Production web build |
| `npm start` | Serve API + built UI |
