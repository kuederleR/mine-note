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

## Install (no admin)

Merges to `main` publish a rolling [Desktop release](https://github.com/kuederleR/mine-note/releases/tag/desktop):

- **Windows (amd64)** — run `Mine-*-windows-amd64.exe`. It installs per-user (no UAC) to `%LOCALAPPDATA%\Programs\Mine` and adds Start Menu / desktop shortcuts. Unsigned builds may hit SmartScreen: **More info → Run anyway**.
- **macOS (Apple Silicon)** — open `Mine-*-macos-arm64.dmg` and drag Mine into Applications or `~/Applications`. The build is ad-hoc signed, not notarized: first launch is **right-click → Open**.

Each workflow run also keeps the same files on the Actions **Artifacts** tab for 30 days.

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
| `npm run docker:build:win` | Windows NSIS installer via Docker (from Mac or Windows) |
| `npm run docker:build:mac` | macOS zip via Docker (unsigned; `.dmg` still needs a Mac) |

## Desktop builds (Docker)

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/), then from the repo root:

```bash
npm run docker:build:win   # → release/*.exe
npm run docker:build:mac   # → release/*-mac.zip
```

Linux `node_modules` stay in Compose volumes, so they will not overwrite a host install. First Windows build on Apple Silicon pulls an amd64 Wine image and runs under emulation — expect it to be slow.

Prefer GitHub Actions for installers. Docker is optional for local packaging: a signed/ad-hoc `.dmg` still needs macOS (`npm run electron:build:mac`) because Docker cannot run `hdiutil` or Apple code signing.
