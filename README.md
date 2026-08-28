# CBM Search — VS Code Extension

Code search powered by [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) knowledge graph.

## Features

- **Search Graph** — semantic search over functions, classes, routes, variables
- **Search Code** — grep + graph-enriched code search
- **Trace Callers / Callees** — who calls this function, what does it call
- **Get Snippet** — read source for any function/class by qualified name
- **Architecture Overview** — high-level project structure, packages, clusters
- **Cypher Query** — run raw Cypher against the knowledge graph
- **Index / Delete** — manage project indexes from the sidebar

## Setup

1. Build the MCP server: `make -f Makefile.cbm cbm`
2. Open this folder in VS Code
3. Run `npm install && npm run compile`
4. Press F5 to launch the extension host

## Configuration

| Setting | Default | Description |
|---|---|---|
| `cbm.binaryPath` | `""` | Path to `codebase-memory-mcp`. Auto-detected if empty. |
| `cbm.autoIndex` | `true` | Auto-index projects on first open. |

## Keybindings

| Command | Key |
|---|---|
| Search Graph | `Ctrl+Shift+G` / `Cmd+Shift+G` |
| Search Code | `Ctrl+Shift+F` / `Cmd+Shift+F` |

## Commands

| Command | Description |
|---|---|
| `CBM: Index Current Project` | Index the open workspace |
| `CBM: Delete Project Index` | Remove a project from the index |
| `CBM: Search Graph` | Semantic search over code symbols |
| `CBM: Search Code` | Regex code search with graph ranking |
| `CBM: Trace Callers` | Find who calls a function |
| `CBM: Trace Callees` | Find what a function calls |
| `CBM: Get Code Snippet` | Show source for a symbol |
| `CBM: Architecture Overview` | Project structure summary |
| `CBM: Cypher Query` | Run raw Cypher query |
| `CBM: List Projects` | Show indexed projects |
| `CBM: Index Status` | Check indexing status |
| `CBM: Detect Changes` | Show impact of uncommitted changes |
| `CBM: Ingest Traces from File` | Import runtime trace data |
| `CBM: Open Interactive Prompt` | Open cbm-prompt in terminal |

## How it works

The extension spawns `codebase-memory-mcp` as a child process and communicates via JSON-RPC over stdio (MCP protocol). The server builds and queries a knowledge graph of your codebase using tree-sitter parsing and LSP analysis.

## License

The software is provided under the [Boost License](https://www.boost.org/doc/user-guide/bsl.html).

== Author ==

Chris Taylor - Hidden Layer, LLC (copyright 2026)
