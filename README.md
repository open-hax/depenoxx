# depenoxx

A generic, workspace-agnostic dependency graph generator and visualizer for any monorepo or multi-repo workspace.

Scans your workspace for `package.json` files, builds internal dependency graphs (both package-level and repo-level), renders them with Graphviz, and serves an interactive web UI with pan/zoom/search.

## Features

- **Repo dependency graph** — git roots connected by internal package.json dependency edges
- **Package dependency graph** — individual packages connected by internal deps
- **Isolate detection** — find repos/packages with no internal connections
- **Component analysis** — discover disconnected subgraphs
- **Interactive viewer** — pan, zoom, and search-highlight nodes
- **Configurable** — works with any workspace root via `WORKSPACE_ROOT` env var

## Run (local)

```bash
cd orgs/open-hax/depenoxx
WORKSPACE_ROOT=/path/to/your/workspace pnpm dev
# http://127.0.0.1:8798
```

Generate graphs:

```bash
# via CLI
WORKSPACE_ROOT=/path/to/your/workspace pnpm generate

# via HTTP
curl -X POST 'http://127.0.0.1:8798/api/generate'
```

## Docker Compose

```bash
cd orgs/open-hax/depenoxx
docker compose up -d --build
```

Then open:
- http://127.0.0.1:8798/
- http://127.0.0.1:8798/report.html

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `WORKSPACE_ROOT` | parent of this package | Root directory to scan for repos/packages |
| `HOST` | `127.0.0.1` | Server bind address |
| `PORT` | `8798` | Server port |
| `PROJECT_NAME` | Workspace root basename | Display name in UI |

## Outputs

Generated files are written into `dist/` (gitignored):
- `dist/graphs/<project>/` — DOT, SVG, PNG files
- `dist/reports/` — report.json, report.md
- `dist/manifest.json` — project manifest for the UI
