# hivemind

Zettelkasten-style knowledge memory for AI coding assistants. Automatically extracts, deduplicates, and retrieves knowledge from coding sessions.

## Prerequisites

- Node.js >= 18
- `claude` CLI (for LLM features: extraction, query expansion, dedup)
- C/C++ toolchain for `better-sqlite3` native addon:
  - **macOS**: `xcode-select --install`
  - **Ubuntu/Debian**: `apt install python3 make g++`
  - **Alpine**: `apk add python3 make g++ build-base`

## Install

From the ucm monorepo:

```bash
cd ucm
npm link
```

Standalone:

```bash
cd ucm/lib/hivemind
npm install
npm link
```

## Quick Start

```bash
hm init            # interactive config setup
hmd start          # start background daemon
hm search "query"  # search your knowledge base
```

## Commands

### hm — knowledge memory CLI

```
hm init                          Interactive config setup
hm search <query>                Search zettels (with LLM query expansion)
hm add [--title <t>] [--file]   Add fleeting zettel (stdin or --file)
hm show <id>                    Show zettel + boost
hm list [--kind <k>] [--limit N]  List zettels
hm link <id1> <id2>             Add bidirectional link
hm ingest [--adapter <name>]    Manual source processing
hm gc [--dry-run]               Garbage collect
hm reindex                      Rebuild index
hm stats                        Statistics
hm delete <id>                  Delete zettel
hm restore <id>                 Restore from archive
hm context                      Show recent work (for CLAUDE.md)
hm config [validate]            Show or validate config
hm docs add <dir>               Add document directory
hm docs remove <dir>            Remove document directory
hm docs list                    List document directories
```

### hmd — background daemon

```
hmd start [--foreground]   Start daemon
hmd stop                   Stop daemon
hmd status                 Daemon status
hmd log [--lines N]        Show daemon log
```

The daemon periodically scans configured sources (Claude Code sessions, Codex sessions, markdown documents), extracts knowledge via LLM, deduplicates, and runs garbage collection.

## Architecture

```
  Sources              Processing            Storage & Retrieval
 ┌──────────┐
 │ claude   │─┐
 │ codex    │─┤  ┌───────────┐  ┌───────────┐  ┌────────────────┐
 │ document │─┴─▶│  extract  │─▶│   dedup   │─▶│  zettel store  │
 └──────────┘    │  (LLM)    │  │ (heuristic│  │  ~/.hivemind/  │
   adapters      └───────────┘  │  + LLM)   │  │    zettel/     │
                                └───────────┘  └───────┬────────┘
                                                       │
                                               ┌───────▼────────┐
                                               │  SQLite index  │
                                               │  FTS5 + BM25   │
                                               │  keyword index  │
                                               └───────┬────────┘
                                                       │
                                               ┌───────▼────────┐
                                               │    search      │
                                               │  query expand  │
                                               │  RRF fusion    │
                                               │  temporal decay │
                                               └────────────────┘
```

Each zettel is a markdown file with YAML frontmatter containing id, title, keywords (weighted), links, and timestamps. The SQLite index provides FTS5 full-text search and a reverse keyword index. Search combines BM25 and keyword lookup via Reciprocal Rank Fusion, then applies exponential temporal decay.

## Config

Config file: `~/.hivemind/config.json`

| Key | Default | Description |
|-----|---------|-------------|
| `adapters.claude.enabled` | `true` | Scan Claude Code sessions |
| `adapters.codex.enabled` | `true` | Scan Codex sessions |
| `adapters.document.enabled` | `true` | Scan markdown directories |
| `adapters.document.dirs` | `[]` | Directories to scan |
| `models.retrieval` | `claude-haiku-4-5-20251001` | Model for query expansion |
| `models.extraction` | `claude-sonnet-4-6` | Model for knowledge extraction |
| `models.dedup` | `claude-haiku-4-5-20251001` | Model for dedup verification |
| `models.consolidation` | `claude-sonnet-4-6` | Model for note consolidation |
| `decayDays` | `30` | Half-life for temporal decay (days) |
| `decayWeight` | `0.2` | Decay influence on search ranking (0-1) |
| `gcThreshold` | `0.05` | Decay score below which zettels are archived |
| `minKeep` | `50` | Minimum zettels to keep (GC protection) |

## Claude Code Integration

`hm init` registers a `SessionStart` hook in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [{ "type": "command", "command": "hm context --hook" }]
      }
    ]
  }
}
```

This runs `hm context` at session start, injecting recent work as additional context:

```
past work — /recall <query> for details:
[my-project]
- webhook gateway timeout fix (webhook, nginx, gateway)
- vue component flicker resolved (vue, reactivity)
[other]
- docker multi-stage build setup (docker, deploy)
```

The model sees these topics in context and can use `/recall <query>` to retrieve full details when relevant topics come up in conversation.

## Data Directory

```
~/.hivemind/
  config.json          Configuration
  zettel/              Active zettels (markdown + YAML frontmatter)
  archive/             Archived zettels (GC'd or deduped)
  index/               SQLite database
  sources/             Adapter state (processed file tracking)
  daemon/              PID file, socket, log
```
