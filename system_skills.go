package main

import (
	"os"
	"path/filepath"
)

// ensureSystemSkills writes any built-in system skills to the library
// directory if they don't already exist. These skills are marked with
// system: true in their frontmatter and cannot be edited or deleted through
// the UI.
func (a *App) ensureSystemSkills() {
	for _, s := range systemSkills {
		dir := filepath.Join(a.librarySkillsDir(), s.name)
		path := filepath.Join(dir, "SKILL.md")
		if _, err := os.Stat(path); err == nil {
			continue // already exists
		}
		_ = os.MkdirAll(dir, 0755)
		_ = os.WriteFile(path, []byte(s.content), 0644)
	}
}

var systemSkills = []struct {
	name    string
	content string
}{
	{
		name: "create-custom-block",
		content: `---
name: create-custom-block
description: Create a new custom building block for the Skilltree Builder using the data-driven schema
argument-hint: "[description of what the block should do]"
allowed-tools: Bash
system: true
---

# Create Custom Block

You are creating a new **Custom Block** for the Skilltree Builder. Custom blocks
are defined as JSON files stored in ` + "`~/.claude/skilltree/blocks/`" + ` and appear
immediately in the Builder's Custom Blocks palette without any rebuild.

## Your task

Design and register a custom block based on the user's description in $ARGUMENTS.

---

## Schema reference

A block definition has this structure:

` + "```json" + `
{
  "id":          "my-block-id",      // kebab-case, unique
  "name":        "Human Name",       // shown in the palette
  "description": "One-line summary", // tooltip on hover
  "color":       "#6366f1",          // hex accent colour
  "fields": [ ... ],
  "execution": { ... }
}
` + "```" + `

### Field types

| type | Description | Extra properties |
|---|---|---|
| ` + "`text`" + ` | Single-line input | ` + "`placeholder`" + ` |
| ` + "`textarea`" + ` | Multi-line input | ` + "`placeholder`" + ` |
| ` + "`select`" + ` | Dropdown | ` + "`options: [\"a\",\"b\"]`" + `, ` + "`default`" + ` |
| ` + "`number`" + ` | Numeric input | ` + "`default`" + ` |
| ` + "`file`" + ` | File path picker | — |

Every field requires ` + "`key`" + ` (used in templates) and ` + "`label`" + ` (displayed in UI).

### Execution types

**` + "`claude_prompt`" + `** — runs ` + "`claude -p`" + ` with a template
` + "```json" + `
{
  "type": "claude_prompt",
  "promptTemplate": "Analyse {{filePath}} and {{task}}"
}
` + "```" + `

**` + "`shell_script`" + `** — runs a bash script inline or from a field
` + "```json" + `
{ "type": "shell_script", "inlineScript": "echo {{name}}" }
{ "type": "shell_script", "inlineField": "script" }
` + "```" + `

**` + "`http_request`" + `** — makes an HTTP call
` + "```json" + `
{
  "type": "http_request",
  "method": "POST",
  "urlTemplate": "https://api.example.com/{{endpoint}}",
  "bodyTemplate": "{\"input\":\"{{text}}\"}"
}
` + "```" + `

All templates support ` + "`{{fieldKey}}`" + ` substitution.

---

## Saving the block

**Preferred — write the file directly** (always works):

` + "```" + `
Write(~/.claude/skilltree/blocks/<id>.json, <JSON content>)
` + "```" + `

The Skilltree app watches this directory and refreshes the palette within 2 seconds.

**Alternative — MCP tool** (only if ` + "`skilltree-gui`" + ` tools are available in this session):

` + "```" + `
save_custom_block(definition: "<JSON string>")
` + "```" + `

---

## Examples

**Commit summariser:**
` + "```json" + `
{
  "id": "git-summary",
  "name": "Git Summary",
  "color": "#f59e0b",
  "fields": [
    { "key": "depth", "label": "Commits", "type": "number", "default": 10 }
  ],
  "execution": {
    "type": "claude_prompt",
    "promptTemplate": "Run git log --oneline -{{depth}} and write a concise summary of recent changes."
  }
}
` + "```" + `

**Slack notifier:**
` + "```json" + `
{
  "id": "slack-notify",
  "name": "Slack Notify",
  "color": "#4ade80",
  "fields": [
    { "key": "webhook", "label": "Webhook URL", "type": "text" },
    { "key": "message", "label": "Message", "type": "textarea" }
  ],
  "execution": {
    "type": "shell_script",
    "inlineScript": "curl -X POST -H 'Content-type: application/json' --data '{\"text\":\"{{message}}\"}' {{webhook}}"
  }
}
` + "```" + `

---

## Steps

1. Understand what the user wants the block to do from $ARGUMENTS
2. Choose the right execution type
3. Design fields that capture everything the user will need to fill in at flow-build time
4. Pick a descriptive ` + "`id`" + ` (kebab-case), a clear ` + "`name`" + `, and a fitting hex ` + "`color`" + `
5. Build the JSON definition
6. Write the JSON to ` + "`~/.claude/skilltree/blocks/<id>.json`" + ` using the Write tool (preferred), or call ` + "`save_custom_block`" + ` if available
7. Confirm success and describe how to use the new block
`,
	},
}
