# Skilltree

A visual workflow builder and runner for [Claude Code](https://claude.ai/code). Design, run, and export multi-step AI workflows as node-based skilltrees — with live step-by-step execution, a built-in Claude terminal, and full MCP integration.

Built with [Wails](https://wails.io) (Go + React/TypeScript).

---

## What It Does

Skilltree lets you visually compose Claude Code skills into executable workflows. The core loop is:

**Build** → drag skills and building blocks onto a canvas, connect them into a flow  
**Run** → execute the flow step-by-step directly in the app with live terminal output  
**Export** → optionally package the flow as a self-contained `SKILL.md` for use anywhere

---

## Installation

Download the latest release for your platform from the [Releases](https://github.com/christopher-rauch/skilltree/releases) page.

| File | Platform |
|---|---|
| `Skilltree-macOS-AppleSilicon.zip` | macOS (M1 / M2 / M3 / M4) |
| `Skilltree-macOS-Intel.zip` | macOS (Intel) |
| `Skilltree-Windows-x64.zip` | Windows 64-bit |
| `Skilltree-Linux-x64.tar.gz` | Linux 64-bit |

You also need [Claude Code](https://claude.ai/code) installed for execution, the terminal, and description generation:

```bash
npm i -g @anthropic-ai/claude-code
```

### macOS

After unzipping, clear the quarantine flag once:

```bash
xattr -cr /Applications/Skilltree.app
```

Or right-click the app → **Open** → **Open** in the dialog.

### Windows

Unzip and run `skilltree.exe`. Click **More info → Run anyway** if SmartScreen appears.

### Linux

```bash
tar -xzf Skilltree-Linux-x64.tar.gz
./skilltree
```

---

## Features

### Running Flows

Click **Run** on any saved flow to execute it step by step — no export needed:

- Each node runs as a `claude -p` call, streaming output live to the built-in terminal
- **Phase badges** on each node show its position in the flow (`1`, `2a`, `2b`, …)
- Active nodes pulse amber; completed nodes show a green ✓; errors show a red ✗
- **Concurrent phases** run in parallel goroutines, with phase headers in the terminal
- **Stop** cancels in-flight execution at any point
- After the run, the interactive Claude terminal is ready for follow-up without losing context

### Visual Builder

Drag skills and building blocks onto a canvas and connect them into directed workflows:

- **Single-input constraint** — each node has at most one incoming connection; the builder prevents cycles and multi-input connections
- **Concurrent phases** — nodes at the same topological level run in parallel
- **Argument inputs** — skill nodes with `argument-hint` show one labeled input field per argument, pre-filled before running
- **Undo / Redo** (⌘Z / ⌘⇧Z) and **Copy / Paste** (⌘C / ⌘V) for nodes and edges
- **Right-click marquee** selection with multi-node drag
- Right-click context menus on nodes and edges

### Building Blocks

Beyond named skills, the builder provides 11 programmable blocks:

| Block | Purpose |
|---|---|
| **Prompt** | Raw Claude instructions — pass text directly to `claude -p` |
| **Run Command** | Execute a shell script |
| **File Input** | Read a file and pass its content as context |
| **Context Injector** | Append static context to the session for all downstream steps |
| **Variable** | Define `{{name}}` placeholders substituted into downstream content |
| **Output Capture** | Save terminal output to a file or the macOS clipboard |
| **HTTP Request** | Call a REST endpoint; store the response as `{{variable}}` |
| **Approval Gate** | Pause the run and require user confirmation before continuing |
| **MCP Tool** | Directly invoke any configured MCP server tool |
| **Condition** | Branch Yes/No based on Claude's evaluation of a condition |
| **Loop** | Repeat a prompt N times with `{{iteration}}` substitution |

Building blocks can be saved as **Library skills** — they are inlined into exported flows rather than referenced by name, keeping exports fully self-contained.

### Exporting as Skill

Convert any flow into a standalone `SKILL.md` that runs in any Claude Code session:

- Skill nodes invoke by name (`/skill-name`); Library skill bodies are embedded inline
- Building block content is embedded directly — no external dependencies
- Variable substitutions are resolved; HTTP requests and conditions are documented
- Export to Global (`~/.claude/skills/`) or Project (`.claude/skills/`) scope

### Skills Manager

- Browse, create, edit, and delete Claude skills across three scopes:
  - **Global** (`~/.claude/skills/`) — available in all Claude Code sessions
  - **Project** (`.claude/skills/`) — scoped to the open project with collaborator warnings
  - **Library** (`~/.claude/skilltree/skills/`) — private building blocks inlined on export
- **Create skills** via form, raw markdown paste, or **Generate with Claude** (describe what you want; Claude fills all fields)
- Color-coded scope tabs, badges, and buttons; scope-change prompts (Move vs Duplicate)
- Skill search by name or description in the Builder palette
- Right-click any palette skill to preview it on the Skills tab

### Skilltrees Gallery

- Browse all saved flows with auto-generated descriptions, node counts, and phase info
- **Duplicate** any flow with one click
- Recent flows shown on the empty Builder canvas for quick access

### Canvas Markups

Non-destructive annotations that persist with the canvas but are excluded from exports:

- **Text** — click to drop an editable label; double-click to re-edit
- **Sticky Note** — colored card with five color options
- **Pencil** — freehand drawing committed as a resizable node on release

### Built-in Claude Terminal

- Collapsible, resizable terminal panel with a live `claude` CLI session
- Stays populated when collapsed — re-open without losing context
- **Save session** to a file via the download button in the terminal header
- **MCP integration** — Claude can control the GUI (navigate, create/delete skills and flows, open and export skilltrees) from the terminal

### Settings

Configure skill paths via the gear icon in the header:

- Global skills folder (default: `~/.claude/skills`)
- Library skills folder (default: `~/.claude/skilltree/skills`)
- Project skills relative path (default: `.claude/skills`)

---

## Building Blocks — Variable Substitution

Variables defined in a **Variable** block flow through to any downstream:

- Prompt block content
- File Input instructions
- Context Injector content
- HTTP Request URLs, headers, and body
- Skill node argument values

Use `{{variable_name}}` syntax anywhere in those fields.

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

### MCP Integration

When the terminal opens, Skilltree starts a local MCP server and spawns `claude` with it configured. Claude can use the `skilltree-gui` tools:

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
├── app.go          # Skills, flows, file I/O, description generation, settings
├── runner.go       # Flow execution engine — step-by-step claude -p runs
├── mcp_client.go   # MCP client for tool discovery and invocation
├── mcp.go          # MCP HTTP server + GUI tool definitions
├── settings.go     # User-configurable path settings
├── terminal.go     # PTY terminal management and MCP session setup
├── main.go         # Wails app config + stdio MCP proxy mode
├── wails.json      # Wails project config
└── frontend/
    └── src/
        ├── App.tsx                    # Shell, nav, terminal, unsaved-change guards
        ├── store.ts                   # Zustand global state
        ├── types.ts                   # Shared TypeScript types
        └── components/
            ├── SkillManager.tsx       # Skills CRUD view
            ├── SkillEditor.tsx        # Create/edit skill modal (form + markdown + generate)
            ├── NodeBoard.tsx          # Builder canvas (React Flow)
            ├── SkillNode.tsx          # Custom skill node with argument inputs
            ├── AnnotationNodes.tsx    # Text, sticky, and drawing markup nodes
            ├── BuildingBlockNodes.tsx # All 11 building block node types
            ├── SkillTrees.tsx         # Skilltrees gallery page
            ├── Settings.tsx           # Path configuration modal
            ├── Terminal.tsx           # xterm.js terminal component
            └── ...
```

---

## License

[MIT](LICENSE) — © 2026 Chris Rauch
