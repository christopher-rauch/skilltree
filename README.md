# Skilltree

A visual skill and workflow manager for [Claude Code](https://claude.ai/code). Build, connect, and export Claude skills as node-based skilltrees — with a built-in Claude terminal and full MCP integration.

Built with [Wails](https://wails.io) (Go + React/TypeScript).

---

## Features

### Skills Manager
- Browse, create, edit, and delete Claude skills (`SKILL.md` files)
- Three scopes with color-coded tabs and badges:
  - **Global** (`~/.claude/skills/`) — available in all Claude Code sessions
  - **Project** (`.claude/skills/`) — scoped to the open project; collaborator warnings on create, edit, and delete
  - **Library** (`~/.claude/skilltree/skills/`) — private building blocks used inside skilltrees; inlined into exported skill files rather than invoked by name, so exports are fully self-contained
- Changing a skill's scope prompts **Move** or **Duplicate** — no silent copies
- Full frontmatter editing: name, description, argument hints, allowed tools, and body

### Skilltrees (Builder)
- Drag skills from the palette onto a canvas and connect them into directed workflows
- **Single-input constraint**: each node may have at most one incoming connection; the UI blocks multi-input connections and disables "Reverse direction" when it would violate this
- **Concurrent phases**: nodes at the same topological level are grouped as parallel steps
- **Cycle prevention**: connecting nodes that would form a loop is blocked
- **Phase badges**: circular number badges on each connected node show its position in the flow (`1`, `2a`, `2b`, …); letters follow branch lineage consistently down the tree; free-floating nodes show no badge
- Resize nodes by dragging corner handles; sizes persist on save
- Right-click any node or connection for a context menu (delete, duplicate, reverse direction)
- **Right-click marquee selection**: hold right-click and drag on the canvas to rubber-band select multiple nodes; drag selected nodes together
- Unsaved-change guards on navigation and skilltree switching
- Gap detection: a warning indicator flags unconnected skill nodes or disconnected subgraphs

### Canvas Annotation Tools
Three non-destructive tools in the Builder palette that persist with the canvas but are invisible to the export and flow logic:
- **Text** — click the canvas to drop an editable text label; double-click to re-edit
- **Sticky Note** — same as text but with a colored card; five color swatches to choose from; double-click to edit
- **Pencil** — hold left-click and drag to draw freehand strokes; stroke is committed as a resizable drawing node on release

### Export as Skill
- Converts a skilltree into a new `SKILL.md` that sequences all connected skills
- **Library skills are inlined**: their body is embedded directly rather than referenced by name, making the exported file fully self-contained and runnable in any Claude Code session without extra configuration
- Sequential steps use phase ordering; concurrent nodes within the same phase are explicitly grouped
- Export to global or project scope

### Built-in Claude Terminal
- Collapsible, resizable terminal panel running a live `claude` CLI instance
- Claude is given a `CLAUDE.md` context file describing the app and all available actions
- **MCP integration**: a local MCP server exposes GUI control tools so Claude can navigate views, create/delete skills and flows, open skilltrees, and export — all from the terminal

### Auto-Descriptions
- When a valid `claude` CLI is available, missing skilltree descriptions are generated automatically using `claude -p` in non-interactive mode
- Descriptions are cached by content hash and only regenerate when the skilltree's structure changes

---

## Installation

Download the latest release for your platform from the [Releases](https://github.com/christopher-rauch/skilltree/releases) page.

| File | Platform |
|---|---|
| `Skilltree-macOS-AppleSilicon.zip` | macOS (M1 / M2 / M3 / M4) |
| `Skilltree-macOS-Intel.zip` | macOS (Intel) |
| `Skilltree-Windows-x64.zip` | Windows 64-bit |
| `Skilltree-Linux-x64.tar.gz` | Linux 64-bit |

You also need [Claude Code](https://claude.ai/code) installed for the terminal and auto-descriptions:

```bash
npm i -g @anthropic-ai/claude-code
```

### macOS

Skilltree is not notarized, so macOS will block it on first launch. After unzipping, run this command once to clear the quarantine flag:

```bash
xattr -cr /Applications/Skilltree.app
```

Then double-click to open normally. If you placed the app somewhere other than `/Applications`, adjust the path accordingly.

> Alternatively: right-click the app → **Open** → **Open** in the dialog that appears. This works as a one-time override without using the terminal.

### Windows

Unzip the archive and run `skilltree.exe`. Windows SmartScreen may show a warning on first launch — click **More info → Run anyway**.

### Linux

Extract the archive and run the `skilltree` binary:

```bash
tar -xzf Skilltree-Linux-x64.tar.gz
./skilltree
```

---

## Building from Source

### Requirements

- [Go](https://golang.org) 1.21+
- [Node.js](https://nodejs.org) 18+
- [Wails CLI](https://wails.io/docs/gettingstarted/installation) v2

```bash
# Install Wails CLI
go install github.com/wailsapp/wails/v2/cmd/wails@latest

# Clone and enter the project
git clone https://github.com/christopher-rauch/skilltree
cd skilltree

# Install frontend dependencies
cd frontend && npm install && cd ..

# Run in development mode (hot-reload)
wails dev

# Build a production .app bundle
wails build
# Output: build/bin/Skilltree.app
```

---

## How It Works

### Skills

Skills are Claude Code slash commands stored as `SKILL.md` files:

```
~/.claude/skills/my-skill/SKILL.md                    ← global
<project>/.claude/skills/my-skill/SKILL.md            ← project-scoped
~/.claude/skilltree/skills/my-skill/SKILL.md          ← library
```

Each file has YAML frontmatter and a markdown body:

```markdown
---
name: my-skill
description: What this skill does and when to invoke it
argument-hint: [optional arg]
allowed-tools: Read, Write, Bash
---

# My Skill

Instructions for Claude...
```

### Skilltrees

Skilltrees are JSON files stored in `~/.claude/skilltree/flows/`. Each file records node positions, sizes, edge connections, and canvas annotations. Exporting generates a new `SKILL.md` with phase-ordered instructions. Library skills are inlined; global/project skills are invoked by name:

```markdown
# Workflow: My Workflow

Execute the phases below in order. Within each phase, all listed skills
can be run concurrently...

## Phase 1
### setup (library skill — inlined)
[body of the library skill embedded here]

## Phase 2 *(concurrent)*
### skill-b
Invoke `/skill-b`.
### skill-c
Invoke `/skill-c`.
```

### MCP Integration

When the terminal opens, Skilltree:

1. Starts a local HTTP MCP server on a random port
2. Creates a temp session directory with a `CLAUDE.md` context file and a `.claude/settings.json` pointing to the server via a Node.js stdio proxy
3. Spawns `claude` in that directory

Claude can then use the `skilltree-gui` MCP tools:

| Tool | Description |
|---|---|
| `navigate` | Switch between Skills, Skilltrees, and Builder views |
| `list_skills` | List all skills (global or project scope) |
| `create_skill` | Create or update a skill file |
| `delete_skill` | Delete a skill |
| `list_flows` | List all saved skilltrees |
| `create_flow` | Create a new empty skilltree |
| `delete_flow` | Delete a skilltree |
| `open_flow` | Open a skilltree in the Builder |
| `export_flow_as_skill` | Export a skilltree as a Claude skill |

---

## Project Structure

```
skilltree/
├── app.go          # Core Go backend — skills, flows, file I/O, description generation
├── terminal.go     # PTY terminal management and MCP session setup
├── mcp.go          # MCP HTTP server + tool definitions
├── main.go         # Wails app config + stdio MCP proxy mode
├── wails.json      # Wails project config
└── frontend/
    └── src/
        ├── App.tsx                    # Shell, nav, unsaved-change guards
        ├── store.ts                   # Zustand global state
        ├── types.ts                   # Shared TypeScript types
        └── components/
            ├── SkillManager.tsx       # Skills CRUD view
            ├── SkillEditor.tsx        # Create/edit skill modal
            ├── NodeBoard.tsx          # Builder canvas (React Flow)
            ├── SkillNode.tsx          # Custom React Flow node
            ├── AnnotationNodes.tsx    # Text, sticky, and drawing annotation nodes
            ├── SkillTrees.tsx         # Skilltrees gallery page
            ├── Terminal.tsx           # xterm.js terminal component
            ├── ProjectScopeInfo.tsx   # Shared project scope UI
            └── GithubButton.tsx       # GitHub link button
```

---

## License

[MIT](LICENSE) — © 2026 Chris Rauch
