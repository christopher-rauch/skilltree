package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// ── Schema ────────────────────────────────────────────────────────────────────

type FieldType string

const (
	FieldTypeText     FieldType = "text"
	FieldTypeTextarea FieldType = "textarea"
	FieldTypeSelect   FieldType = "select"
	FieldTypeNumber   FieldType = "number"
	FieldTypeFile     FieldType = "file"
)

type BlockField struct {
	Key         string    `json:"key"`
	Label       string    `json:"label"`
	Type        FieldType `json:"type"`
	Placeholder string    `json:"placeholder,omitempty"`
	Default     any       `json:"default,omitempty"`
	Options     []string  `json:"options,omitempty"` // for select
}

type BlockExecType string

const (
	BlockExecClaudePrompt BlockExecType = "claude_prompt"
	BlockExecShellScript  BlockExecType = "shell_script"
	BlockExecHTTPRequest  BlockExecType = "http_request"
)

type BlockExecution struct {
	Type        BlockExecType `json:"type"`
	// claude_prompt: template with {{fieldKey}} substitution
	PromptTemplate string `json:"promptTemplate,omitempty"`
	// shell_script: inline script string (may use {{fieldKey}}) or field key
	InlineScript string `json:"inlineScript,omitempty"`
	InlineField  string `json:"inlineField,omitempty"` // field key whose value is the script
	// http_request
	Method      string `json:"method,omitempty"`
	URLTemplate string `json:"urlTemplate,omitempty"`
	BodyTemplate string `json:"bodyTemplate,omitempty"`
}

type CustomBlockDef struct {
	ID          string       `json:"id"`
	Name        string       `json:"name"`
	Description string       `json:"description,omitempty"`
	Icon        string       `json:"icon,omitempty"`  // lucide icon name
	Color       string       `json:"color,omitempty"` // CSS colour
	Fields      []BlockField `json:"fields"`
	Execution   BlockExecution `json:"execution"`
}

// ── Storage ───────────────────────────────────────────────────────────────────

func customBlocksDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "skilltree", "blocks")
}

func (a *App) GetCustomBlocks() ([]CustomBlockDef, error) {
	dir := customBlocksDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []CustomBlockDef{}, nil
		}
		return nil, err
	}
	var blocks []CustomBlockDef
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var def CustomBlockDef
		if err := json.Unmarshal(data, &def); err != nil {
			continue
		}
		blocks = append(blocks, def)
	}
	return blocks, nil
}

func (a *App) SaveCustomBlock(def CustomBlockDef) error {
	if def.ID == "" {
		return fmt.Errorf("block ID is required")
	}
	if def.Name == "" {
		return fmt.Errorf("block name is required")
	}
	dir := customBlocksDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(def, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(dir, def.ID+".json")
	if err := os.WriteFile(path, data, 0644); err != nil {
		return err
	}
	runtime.EventsEmit(a.ctx, "blocks:updated")
	return nil
}

func (a *App) DeleteCustomBlock(id string) error {
	path := filepath.Join(customBlocksDir(), id+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	runtime.EventsEmit(a.ctx, "blocks:updated")
	return nil
}
