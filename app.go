package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"gopkg.in/yaml.v3"
)

type App struct {
	ctx        context.Context
	projectDir string
	boardDirty bool
	mcpPort    int
	term       termState
	runCancel  context.CancelFunc
	runCap     *strings.Builder
	runCapMu   sync.Mutex
	gateCh     chan bool
	settings   AppSettings
}

// GateResponse is called by the frontend when the user approves or aborts a gate.
func (a *App) GateResponse(approved bool) {
	if a.gateCh != nil {
		a.gateCh <- approved
	}
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.settings = loadSettings()
	port, err := startMCPServer(a)
	if err == nil {
		a.mcpPort = port
		// Write port file so the permanent MCP proxy can find the server.
		home, _ := os.UserHomeDir()
		_ = os.WriteFile(
			filepath.Join(home, ".claude", "skilltree-mcp-port"),
			[]byte(fmt.Sprintf("%d", port)),
			0644,
		)
	}
}

func (a *App) shutdown(_ context.Context) {
	a.StopTerminal()
	// Remove port file so the proxy fails gracefully when the app isn't running.
	home, _ := os.UserHomeDir()
	_ = os.Remove(filepath.Join(home, ".claude", "skilltree-mcp-port"))
}


func (a *App) SetBoardDirty(dirty bool) {
	a.boardDirty = dirty
}

func (a *App) OpenURL(url string) {
	runtime.BrowserOpenURL(a.ctx, url)
}

func (a *App) beforeClose(ctx context.Context) bool {
	if !a.boardDirty {
		return false // allow close
	}
	result, err := runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
		Type:          runtime.QuestionDialog,
		Title:         "Unsaved changes",
		Message:       "The node board has unsaved changes. Quit anyway?",
		Buttons:       []string{"Quit", "Cancel"},
		DefaultButton: "Cancel",
		CancelButton:  "Cancel",
	})
	if err != nil {
		return false
	}
	return result != "Quit" // true = cancel the close
}

// --- Data types ---

type Skill struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	ArgumentHint string `json:"argumentHint"`
	AllowedTools string `json:"allowedTools"`
	Body         string `json:"body"`
	Scope        string `json:"scope"` // "global" | "project"
}

type skillFrontmatter struct {
	Name         string      `yaml:"name"`
	Description  string      `yaml:"description"`
	ArgumentHint interface{} `yaml:"argument-hint,omitempty"`
	AllowedTools interface{} `yaml:"allowed-tools,omitempty"`
}

// yamlFieldToString coerces a YAML value to a string. Unquoted bracket
// sequences like [ticket key] are parsed by the YAML library as []interface{},
// so we reconstruct the original bracket notation rather than rejecting the file.
func yamlFieldToString(v interface{}) string {
	switch val := v.(type) {
	case string:
		return val
	case []interface{}:
		parts := make([]string, 0, len(val))
		for _, p := range val {
			parts = append(parts, fmt.Sprint(p))
		}
		return "[" + strings.Join(parts, ", ") + "]"
	case nil:
		return ""
	default:
		return fmt.Sprint(val)
	}
}

type XYPosition struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type FlowNode struct {
	ID       string         `json:"id"`
	Type     string         `json:"type"`
	Position XYPosition     `json:"position"`
	Data     map[string]any `json:"data"`
	Width    float64        `json:"width,omitempty"`
	Height   float64        `json:"height,omitempty"`
}

type FlowEdge struct {
	ID           string `json:"id"`
	Source       string `json:"source"`
	Target       string `json:"target"`
	SourceHandle string `json:"sourceHandle,omitempty"`
	TargetHandle string `json:"targetHandle,omitempty"`
	Animated     bool   `json:"animated"`
}

type FlowAnnotation struct {
	ID       string         `json:"id"`
	Type     string         `json:"type"` // "text" | "sticky" | "drawing"
	Position XYPosition     `json:"position"`
	Data     map[string]any `json:"data"`
	Width    float64        `json:"width,omitempty"`
	Height   float64        `json:"height,omitempty"`
}

type Flow struct {
	ID          string           `json:"id"`
	Name        string           `json:"name"`
	Description string           `json:"description"`
	ContentHash string           `json:"contentHash"`
	Nodes       []FlowNode       `json:"nodes"`
	Edges       []FlowEdge       `json:"edges"`
	Annotations []FlowAnnotation `json:"annotations,omitempty"`
	UpdatedAt   int64            `json:"updatedAt,omitempty"` // Unix ms, populated from file mtime
}

// flowContentHash hashes skill names + edge topology (ignores node positions).
func flowContentHash(flow Flow) string {
	type edge struct{ S, T string }
	var names []string
	nameOf := map[string]string{}
	for _, n := range flow.Nodes {
		s, _ := n.Data["skillName"].(string)
		nameOf[n.ID] = s
		names = append(names, s)
	}
	sort.Strings(names)

	var edges []edge
	for _, e := range flow.Edges {
		edges = append(edges, edge{nameOf[e.Source], nameOf[e.Target]})
	}
	sort.Slice(edges, func(i, j int) bool {
		if edges[i].S != edges[j].S {
			return edges[i].S < edges[j].S
		}
		return edges[i].T < edges[j].T
	})

	data, _ := json.Marshal(map[string]any{"nodes": names, "edges": edges})
	sum := sha256.Sum256(data)
	return fmt.Sprintf("%x", sum[:8])
}

// --- Path helpers ---

func (a *App) globalSkillsDir() string {
	if a.settings.GlobalSkillsDir != "" {
		return a.settings.GlobalSkillsDir
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "skills")
}

func (a *App) librarySkillsDir() string {
	if a.settings.LibrarySkillsDir != "" {
		return a.settings.LibrarySkillsDir
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "skilltree", "skills")
}

func (a *App) projectSkillsDir() string {
	if a.projectDir == "" {
		return ""
	}
	rel := a.settings.ProjectSkillsRelPath
	if rel == "" {
		rel = filepath.Join(".claude", "skills")
	}
	return filepath.Join(a.projectDir, rel)
}

func flowsDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "skilltree", "flows")
}

// --- Skill file I/O ---

func parseSkillFile(path string, scope string) (Skill, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Skill{}, err
	}

	content := string(data)
	var fm skillFrontmatter
	var body string

	if strings.HasPrefix(content, "---") {
		rest := content[3:]
		if fmContent, remainder, ok := strings.Cut(rest, "\n---"); ok {
			if err := yaml.Unmarshal([]byte(fmContent), &fm); err != nil {
				return Skill{}, fmt.Errorf("parse frontmatter: %w", err)
			}
			body = strings.TrimSpace(remainder)
		} else {
			body = strings.TrimSpace(content)
		}
	} else {
		body = strings.TrimSpace(content)
	}

	return Skill{
		Name:         fm.Name,
		Description:  fm.Description,
		ArgumentHint: yamlFieldToString(fm.ArgumentHint),
		AllowedTools: yamlFieldToString(fm.AllowedTools),
		Body:         body,
		Scope:        scope,
	}, nil
}

func loadSkillsFromDir(dir string, scope string) ([]Skill, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []Skill{}, nil
		}
		return nil, err
	}

	var skills []Skill
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		skillPath := filepath.Join(dir, entry.Name(), "SKILL.md")
		skill, err := parseSkillFile(skillPath, scope)
		if err != nil {
			continue
		}
		skills = append(skills, skill)
	}

	sort.Slice(skills, func(i, j int) bool {
		return skills[i].Name < skills[j].Name
	})

	return skills, nil
}

func writeSkillFile(dir string, skill Skill) error {
	skillDir := filepath.Join(dir, skill.Name)
	if err := os.MkdirAll(skillDir, 0755); err != nil {
		return err
	}

	fm := skillFrontmatter{
		Name:        skill.Name,
		Description: skill.Description,
	}
	if skill.ArgumentHint != "" {
		fm.ArgumentHint = skill.ArgumentHint
	}
	if skill.AllowedTools != "" {
		fm.AllowedTools = skill.AllowedTools
	}

	fmBytes, err := yaml.Marshal(fm)
	if err != nil {
		return err
	}

	content := fmt.Sprintf("---\n%s---\n\n%s\n", string(fmBytes), skill.Body)
	return os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(content), 0644)
}

// --- Exported skill methods ---

func (a *App) GetGlobalSkills() ([]Skill, error) {
	return loadSkillsFromDir(a.globalSkillsDir(), "global")
}

func (a *App) GetProjectSkills() ([]Skill, error) {
	dir := a.projectSkillsDir()
	if dir == "" {
		return []Skill{}, nil
	}
	return loadSkillsFromDir(dir, "project")
}

func (a *App) GetProjectDir() string {
	return a.projectDir
}

func (a *App) ClearProjectDir() {
	a.projectDir = ""
}

func (a *App) OpenProjectDirectory() (string, error) {
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select Project Directory",
	})
	if err != nil {
		return "", err
	}
	if dir != "" {
		a.projectDir = dir
	}
	return dir, nil
}

func (a *App) SaveSkill(skill Skill, originalName string) error {
	var dir string
	switch skill.Scope {
	case "global":
		dir = a.globalSkillsDir()
	case "library":
		dir = a.librarySkillsDir()
	default:
		dir = a.projectSkillsDir()
		if dir == "" {
			return fmt.Errorf("no project directory set — open a project first")
		}
	}

	// If renaming, remove the old directory
	if originalName != "" && originalName != skill.Name {
		_ = os.RemoveAll(filepath.Join(dir, originalName))
	}

	return writeSkillFile(dir, skill)
}

func (a *App) DeleteSkill(name string, scope string) error {
	var dir string
	switch scope {
	case "global":
		dir = a.globalSkillsDir()
	case "library":
		dir = a.librarySkillsDir()
	default:
		dir = a.projectSkillsDir()
		if dir == "" {
			return fmt.Errorf("no project directory set")
		}
	}
	return os.RemoveAll(filepath.Join(dir, name))
}

func (a *App) GetLibrarySkills() ([]Skill, error) {
	return loadSkillsFromDir(a.librarySkillsDir(), "library")
}

// --- Exported flow methods ---

func (a *App) GetFlows() ([]Flow, error) {
	dir := flowsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []Flow{}, nil
		}
		return nil, err
	}

	var flows []Flow
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue
		}
		var flow Flow
		if err := json.Unmarshal(data, &flow); err != nil {
			continue
		}
		if info, err := entry.Info(); err == nil {
			flow.UpdatedAt = info.ModTime().UnixMilli()
		}
		flows = append(flows, flow)
	}

	sort.Slice(flows, func(i, j int) bool {
		return flows[i].Name < flows[j].Name
	})

	return flows, nil
}

func (a *App) SaveFlow(flow Flow) error {
	dir := flowsDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	// Recompute content hash; clear description if content changed
	newHash := flowContentHash(flow)
	if newHash != flow.ContentHash {
		flow.ContentHash = newHash
		flow.Description = "" // will be regenerated
	}

	data, err := json.MarshalIndent(flow, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, flow.ID+".json"), data, 0644)
}

func (a *App) DeleteFlow(id string) error {
	return os.Remove(filepath.Join(flowsDir(), id+".json"))
}

func (a *App) NewFlowID() string {
	return fmt.Sprintf("flow-%d", time.Now().UnixMilli())
}

// ClaudeAvailable returns true if the claude CLI is reachable.
func (a *App) ClaudeAvailable() bool {
	_, err := shellWhich("claude")
	return err == nil
}

var ansiRE = regexp.MustCompile(`\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])`)

// GenerateFlowDescriptions generates missing descriptions for all flows that
// have no description, using claude -p in non-interactive mode. Runs the
// generations concurrently and emits "flow:description_updated" events.
func (a *App) GenerateFlowDescriptions() {
	if !a.ClaudeAvailable() {
		return
	}
	flows, err := a.GetFlows()
	if err != nil {
		return
	}
	for _, f := range flows {
		if f.Description != "" || len(f.Nodes) == 0 {
			continue
		}
		go func(flow Flow) {
			desc, err := generateDescription(flow)
			if err != nil || desc == "" {
				return
			}
			flow.Description = desc
			// Persist without clearing description (hash unchanged)
			dir := flowsDir()
			data, err := json.MarshalIndent(flow, "", "  ")
			if err != nil {
				return
			}
			_ = os.WriteFile(filepath.Join(dir, flow.ID+".json"), data, 0644)
			runtime.EventsEmit(a.ctx, "flow:description_updated", map[string]string{
				"id": flow.ID, "description": desc,
			})
		}(f)
	}
}

// DuplicateFlow creates a copy of the given flow with " (copy)" appended to the name.
func (a *App) DuplicateFlow(flowID string) (Flow, error) {
	flows, err := a.GetFlows()
	if err != nil {
		return Flow{}, err
	}
	var src *Flow
	for i := range flows {
		if flows[i].ID == flowID {
			src = &flows[i]
			break
		}
	}
	if src == nil {
		return Flow{}, fmt.Errorf("flow %q not found", flowID)
	}
	newID := a.NewFlowID()
	dup := *src
	dup.ID = newID
	dup.Name = src.Name + " (copy)"
	dup.ContentHash = ""
	dup.Description = src.Description
	dup.UpdatedAt = 0
	data, err := json.MarshalIndent(dup, "", "  ")
	if err != nil {
		return Flow{}, err
	}
	if err := os.WriteFile(filepath.Join(flowsDir(), newID+".json"), data, 0644); err != nil {
		return Flow{}, err
	}
	return dup, nil
}

// RegenerateFlowDescription forces a fresh description for the given flow ID,
// even if one already exists, and emits "flow:description_updated" when done.
func (a *App) RegenerateFlowDescription(flowID string) {
	if !a.ClaudeAvailable() {
		return
	}
	flows, err := a.GetFlows()
	if err != nil {
		return
	}
	var target *Flow
	for i := range flows {
		if flows[i].ID == flowID {
			target = &flows[i]
			break
		}
	}
	if target == nil || len(target.Nodes) == 0 {
		return
	}
	go func(flow Flow) {
		desc, err := generateDescription(flow)
		if err != nil || desc == "" {
			return
		}
		flow.Description = desc
		flow.ContentHash = "" // reset so next auto-run picks it up cleanly
		dir := flowsDir()
		data, err := json.MarshalIndent(flow, "", "  ")
		if err != nil {
			return
		}
		_ = os.WriteFile(filepath.Join(dir, flow.ID+".json"), data, 0644)
		runtime.EventsEmit(a.ctx, "flow:description_updated", map[string]string{
			"id": flow.ID, "description": desc,
		})
	}(*target)
}

func truncate(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}

func generateDescription(flow Flow) (string, error) {
	// Build a rich summary of every node so Claude can describe real behaviour.
	var steps []string
	for _, n := range flow.Nodes {
		label, _ := n.Data["label"].(string)
		switch n.Type {
		case "skill":
			name, _ := n.Data["skillName"].(string)
			desc, _ := n.Data["description"].(string)
			if name == "" {
				continue
			}
			entry := "skill:" + name
			if desc != "" {
				entry += " (" + truncate(desc, 60) + ")"
			}
			steps = append(steps, entry)
		case "block-text":
			content, _ := n.Data["content"].(string)
			if content == "" {
				continue
			}
			if label == "" {
				label = "prompt"
			}
			steps = append(steps, label+": "+truncate(content, 80))
		case "block-command":
			path, _ := n.Data["scriptPath"].(string)
			steps = append(steps, "run script: "+filepath.Base(path))
		case "block-file":
			path, _ := n.Data["filePath"].(string)
			instr, _ := n.Data["instruction"].(string)
			entry := "file input: " + filepath.Base(path)
			if instr != "" {
				entry += " — " + truncate(instr, 50)
			}
			steps = append(steps, entry)
		case "block-context":
			content, _ := n.Data["content"].(string)
			steps = append(steps, "context: "+truncate(content, 60))
		case "block-condition":
			cond, _ := n.Data["condition"].(string)
			steps = append(steps, "condition: "+truncate(cond, 60))
		case "block-loop":
			loopPrompt, _ := n.Data["prompt"].(string)
			countRaw, _ := n.Data["count"].(float64)
			steps = append(steps, fmt.Sprintf("loop ×%.0f: %s", countRaw, truncate(loopPrompt, 50)))
		case "block-http":
			method, _ := n.Data["method"].(string)
			url, _ := n.Data["url"].(string)
			steps = append(steps, method+" "+truncate(url, 60))
		case "block-mcp":
			server, _ := n.Data["serverName"].(string)
			tool, _ := n.Data["toolName"].(string)
			steps = append(steps, "mcp:"+server+"/"+tool)
		case "block-gate":
			msg, _ := n.Data["message"].(string)
			steps = append(steps, "approval gate: "+truncate(msg, 50))
		case "block-output":
			steps = append(steps, "capture output")
		case "block-variable":
			steps = append(steps, "set variables")
		}
	}

	var stepsStr string
	if len(steps) > 0 {
		stepsStr = strings.Join(steps, " → ")
	} else {
		stepsStr = "(no steps defined)"
	}

	prompt := fmt.Sprintf(
		"In one sentence (max 100 characters), describe what this workflow accomplishes "+
			"based on its name and steps. Be specific about what it actually does. "+
			"Reply with ONLY the description — no quotes, no period at the end.\n\n"+
			"Workflow name: %s\nSteps: %s\nConnections: %d",
		flow.Name, stepsStr, len(flow.Edges),
	)

	claudePath, err := shellWhich("claude")
	if err != nil {
		return "", err
	}
	out, err := exec.Command(claudePath, "-p", prompt).Output()
	if err != nil {
		return "", err
	}
	clean := ansiRE.ReplaceAllString(strings.TrimSpace(string(out)), "")
	// Take only the first line in case claude outputs extra lines
	if idx := strings.Index(clean, "\n"); idx >= 0 {
		clean = clean[:idx]
	}
	return strings.TrimSpace(clean), nil
}

// GenerateFlowSkill converts a flow into a new SKILL.md.
// Nodes at the same topological level (all parents completed) are emitted as
// a concurrent phase; nodes that must wait for prior work run sequentially.
func (a *App) GenerateFlowSkill(flow Flow, skillName string, scope string) error {
	// Build a lookup of library skills so their bodies can be inlined on export.
	libraryIndex := map[string]Skill{}
	if libSkills, err := a.GetLibrarySkills(); err == nil {
		for _, s := range libSkills {
			libraryIndex[s.Name] = s
		}
	}

	nodeMap := make(map[string]FlowNode)
	inDegree := make(map[string]int)
	adj := make(map[string][]string)   // source → targets
	parents := make(map[string][]string) // target → sources

	for _, node := range flow.Nodes {
		nodeMap[node.ID] = node
		inDegree[node.ID] = 0
	}
	for _, edge := range flow.Edges {
		adj[edge.Source] = append(adj[edge.Source], edge.Target)
		parents[edge.Target] = append(parents[edge.Target], edge.Source)
		inDegree[edge.Target]++
	}

	// Assign each node the deepest level it can be placed at:
	// level[n] = max(level[parent] for all parents) + 1
	level := make(map[string]int)
	queue := []string{}
	for nodeID, deg := range inDegree {
		if deg == 0 {
			queue = append(queue, nodeID)
			level[nodeID] = 0
		}
	}
	sort.Strings(queue)

	maxLevel := 0
	remaining := maps.Clone(inDegree)

	for len(queue) > 0 {
		curr := queue[0]
		queue = queue[1:]
		if level[curr] > maxLevel {
			maxLevel = level[curr]
		}
		next := append([]string{}, adj[curr]...)
		sort.Strings(next)
		for _, nxt := range next {
			if level[curr]+1 > level[nxt] {
				level[nxt] = level[curr] + 1
			}
			remaining[nxt]--
			if remaining[nxt] == 0 {
				queue = append(queue, nxt)
			}
		}
	}

	// Group nodes by level
	phases := make([][]FlowNode, maxLevel+1)
	for _, node := range flow.Nodes {
		l := level[node.ID]
		phases[l] = append(phases[l], node)
	}
	// Sort nodes within each phase for determinism
	for i := range phases {
		sort.Slice(phases[i], func(a, b int) bool {
			la, _ := phases[i][a].Data["label"].(string)
			lb, _ := phases[i][b].Data["label"].(string)
			if la == "" {
				la, _ = phases[i][a].Data["skillName"].(string)
			}
			if lb == "" {
				lb, _ = phases[i][b].Data["skillName"].(string)
			}
			return la < lb
		})
	}

	// exportVars accumulates Variable node values for inline substitution.
	exportVars := map[string]string{}

	totalNodes := len(flow.Nodes)
	var sb strings.Builder
	fmt.Fprintf(&sb, "# Workflow: %s\n\n", flow.Name)
	sb.WriteString("Execute the phases below in order. Within each phase, all listed skills ")
	sb.WriteString("can be run **concurrently** — start them in parallel and wait for all ")
	sb.WriteString("to finish before advancing to the next phase.\n\n")
	sb.WriteString("Pass all relevant context and outputs forward at each phase boundary.\n\n")

	phaseNum := 1
	for _, nodes := range phases {
		if len(nodes) == 0 {
			continue
		}

		// Collect the names of all phases that feed into this one
		depPhaseNums := map[int]struct{}{}
		for _, node := range nodes {
			for _, parentID := range parents[node.ID] {
				depPhaseNums[level[parentID]+1] = struct{}{}
			}
		}

		fmt.Fprintf(&sb, "---\n\n## Phase %d", phaseNum)
		if len(nodes) > 1 {
			sb.WriteString(" *(concurrent)*")
		}
		sb.WriteString("\n\n")

		if len(depPhaseNums) > 0 {
			nums := []int{}
			for n := range depPhaseNums {
				nums = append(nums, n)
			}
			sort.Ints(nums)
			parts := make([]string, len(nums))
			for i, n := range nums {
				parts[i] = fmt.Sprintf("Phase %d", n)
			}
			fmt.Fprintf(&sb, "_Requires: %s to be complete._\n\n", strings.Join(parts, ", "))
		}

		for _, node := range nodes {
			label, _ := node.Data["label"].(string)

			switch node.Type {
			case "block-condition":
				condition, _ := node.Data["condition"].(string)
				condition = applyExportVars(condition, exportVars)
				if label == "" {
					label = "Condition"
				}
				fmt.Fprintf(&sb, "### %s *(condition)*\n\n", label)
				fmt.Fprintf(&sb, "Evaluate: **\"%s\"**\n\n", condition)
				sb.WriteString("- If **yes**: continue along the Yes path\n")
				sb.WriteString("- If **no**: continue along the No path\n\n")

			case "block-loop":
				loopPrompt, _ := node.Data["prompt"].(string)
				loopPrompt = applyExportVars(loopPrompt, exportVars)
				countRaw, _ := node.Data["count"].(float64)
				count := int(countRaw)
				if count < 1 {
					count = 1
				}
				if label == "" {
					label = "Loop"
				}
				fmt.Fprintf(&sb, "### %s *(loop × %d)*\n\n", label, count)
				fmt.Fprintf(&sb, "Repeat the following %d time(s), substituting `{{iteration}}` with the current count:\n\n", count)
				sb.WriteString(strings.TrimSpace(loopPrompt))
				sb.WriteString("\n\n")

			case "block-mcp":
				serverName, _ := node.Data["serverName"].(string)
				toolName, _ := node.Data["toolName"].(string)
				responseVar, _ := node.Data["responseVar"].(string)
				if responseVar == "" {
					responseVar = "mcp_response"
				}
				if label == "" {
					label = "MCP Tool"
				}
				fmt.Fprintf(&sb, "### %s\n\n", label)
				fmt.Fprintf(&sb, "Invoke MCP tool `%s` on server `%s`", toolName, serverName)
				if argList, ok := node.Data["args"].([]interface{}); ok && len(argList) > 0 {
					sb.WriteString(" with arguments:\n\n")
					for _, item := range argList {
						if entry, ok := item.(map[string]interface{}); ok {
							name, _ := entry["name"].(string)
							value, _ := entry["value"].(string)
							if name != "" {
								fmt.Fprintf(&sb, "- `%s`: `%s`\n", name, applyExportVars(value, exportVars))
							}
						}
					}
					sb.WriteString("\n")
				} else {
					sb.WriteString(".\n\n")
				}
				fmt.Fprintf(&sb, "Store the response in `{{%s}}`.\n\n", responseVar)

			case "custom-block":
				blockID, _ := node.Data["blockDefinitionId"].(string)
				if label == "" {
					label = "Custom Block"
				}
				fmt.Fprintf(&sb, "### %s\n\n", label)
				// Embed the block definition inline so the export is self-contained
				blocks, _ := a.GetCustomBlocks()
				for _, def := range blocks {
					if def.ID != blockID {
						continue
					}
					if def.Description != "" {
						fmt.Fprintf(&sb, "> %s\n\n", def.Description)
					}
					rawValues, _ := node.Data["fieldValues"].(map[string]interface{})
					switch def.Execution.Type {
					case BlockExecClaudePrompt:
						prompt := def.Execution.PromptTemplate
						for _, f := range def.Fields {
							val := fmt.Sprint(rawValues[f.Key])
							prompt = strings.ReplaceAll(prompt, "{{"+f.Key+"}}", applyExportVars(val, exportVars))
						}
						sb.WriteString(strings.TrimSpace(prompt))
						sb.WriteString("\n\n")
					case BlockExecShellScript:
						script := def.Execution.InlineScript
						if def.Execution.InlineField != "" {
							if v, ok := rawValues[def.Execution.InlineField]; ok {
								script = fmt.Sprint(v)
							}
						}
						if script != "" {
							fmt.Fprintf(&sb, "Run the following script:\n\n```bash\n%s\n```\n\n", strings.TrimSpace(script))
						}
					case BlockExecHTTPRequest:
						method := def.Execution.Method
						if method == "" {
							method = "GET"
						}
						fmt.Fprintf(&sb, "```http\n%s %s\n```\n\n", method, def.Execution.URLTemplate)
					}
					break
				}

			case "block-gate":
				message, _ := node.Data["message"].(string)
				if label == "" {
					label = "Approval Gate"
				}
				if message == "" {
					message = "Continue with the flow?"
				}
				fmt.Fprintf(&sb, "### %s *(approval gate)*\n\n", label)
				fmt.Fprintf(&sb, "Pause and ask the user: **\"%s\"**\n\n", message)
				sb.WriteString("Proceed only if the user approves. Abort the run if they decline.\n\n")

			case "block-http":
				method, _ := node.Data["method"].(string)
				if method == "" {
					method = "GET"
				}
				rawURL, _ := node.Data["url"].(string)
				rawURL = applyExportVars(rawURL, exportVars)
				// Append query params to URL for export display
				if qpList, ok := node.Data["queryParams"].([]interface{}); ok && len(qpList) > 0 {
					sep := "?"
					if strings.Contains(rawURL, "?") {
						sep = "&"
					}
					for _, item := range qpList {
						if entry, ok := item.(map[string]interface{}); ok {
							name, _ := entry["name"].(string)
							value, _ := entry["value"].(string)
							if name != "" {
								rawURL += sep + applyExportVars(name, exportVars) + "=" + applyExportVars(value, exportVars)
								sep = "&"
							}
						}
					}
				}
				responseVar, _ := node.Data["responseVar"].(string)
				if responseVar == "" {
					responseVar = "http_response"
				}
				if label == "" {
					label = "HTTP Request"
				}
				fmt.Fprintf(&sb, "### %s\n\n", label)
				fmt.Fprintf(&sb, "```http\n%s %s\n", method, rawURL)
				if headerList, ok := node.Data["headers"].([]interface{}); ok {
					for _, item := range headerList {
						if entry, ok := item.(map[string]interface{}); ok {
							name, _ := entry["name"].(string)
							value, _ := entry["value"].(string)
							if name != "" {
								fmt.Fprintf(&sb, "%s: %s\n", name, applyExportVars(value, exportVars))
							}
						}
					}
				}
				if body, _ := node.Data["body"].(string); body != "" {
					fmt.Fprintf(&sb, "\n%s\n", applyExportVars(body, exportVars))
				}
				sb.WriteString("```\n\n")
				fmt.Fprintf(&sb, "Store the response body in `{{%s}}`.\n\n", responseVar)

			case "block-output":
				destination, _ := node.Data["destination"].(string)
				filePath, _ := node.Data["filePath"].(string)
				if label == "" {
					label = "Output Capture"
				}
				fmt.Fprintf(&sb, "### %s *(output capture)*\n\n", label)
				if destination == "clipboard" {
					sb.WriteString("Save all output produced so far to the clipboard.\n\n")
				} else if filePath != "" {
					fmt.Fprintf(&sb, "Save all output produced so far to `%s`.\n\n", filePath)
				} else {
					sb.WriteString("Save all output produced so far to a file.\n\n")
				}

			case "block-variable":
				if varsList, ok := node.Data["variables"].([]interface{}); ok {
					for _, item := range varsList {
						if entry, ok := item.(map[string]interface{}); ok {
							name, _ := entry["name"].(string)
							value, _ := entry["value"].(string)
							if strings.TrimSpace(name) != "" {
								exportVars[name] = value
							}
						}
					}
				}
				if label == "" {
					label = "Variables"
				}
				fmt.Fprintf(&sb, "### %s *(variables)*\n\n", label)
				if varsList, ok := node.Data["variables"].([]interface{}); ok {
					for _, item := range varsList {
						if entry, ok := item.(map[string]interface{}); ok {
							name, _ := entry["name"].(string)
							value, _ := entry["value"].(string)
							if name != "" {
								fmt.Fprintf(&sb, "- `%s` = `%s`\n", name, value)
							}
						}
					}
				}
				sb.WriteString("\n")

			case "block-context":
				content, _ := node.Data["content"].(string)
				content = applyExportVars(content, exportVars)
				if label == "" {
					label = "Context"
				}
				fmt.Fprintf(&sb, "### %s *(context)*\n\n", label)
				if strings.TrimSpace(content) != "" {
					sb.WriteString("> The following context applies to all subsequent steps:\n\n")
					sb.WriteString(strings.TrimSpace(content))
					sb.WriteString("\n\n")
				}

			case "block-file":
				filePath, _ := node.Data["filePath"].(string)
				instruction, _ := node.Data["instruction"].(string)
				if label == "" {
					label = "File Input"
				}
				if instruction == "" {
					instruction = "Use the following file content as context for subsequent steps."
				}
				fmt.Fprintf(&sb, "### %s\n\n", label)
				sb.WriteString(instruction + "\n\n")
				if filePath != "" {
					fname := filepath.Base(filePath)
					if fileBytes, err := os.ReadFile(filePath); err == nil {
						fmt.Fprintf(&sb, "File: `%s`\n\n```\n%s\n```\n\n", fname, strings.TrimSpace(string(fileBytes)))
					} else {
						fmt.Fprintf(&sb, "File: `%s` _(could not read at export time)_\n\n", filePath)
					}
				}

			case "block-text":
				content, _ := node.Data["content"].(string)
				content = applyExportVars(content, exportVars)
				if label == "" {
					label = "Text Block"
				}
				fmt.Fprintf(&sb, "### %s\n\n", label)
				if strings.TrimSpace(content) != "" {
					sb.WriteString(strings.TrimSpace(content))
					sb.WriteString("\n\n")
				}

			case "block-command":
				scriptPath, _ := node.Data["scriptPath"].(string)
				if label == "" {
					label = "Run Command"
				}
				fmt.Fprintf(&sb, "### %s\n\n", label)
				if scriptPath != "" {
					if scriptBytes, err := os.ReadFile(scriptPath); err == nil {
						fmt.Fprintf(&sb, "Run the following shell script:\n\n```bash\n%s\n```\n\n", strings.TrimSpace(string(scriptBytes)))
					} else {
						fmt.Fprintf(&sb, "Run script: `%s`\n\n", scriptPath)
					}
				}

			default: // "skill" node
				sName, _ := node.Data["skillName"].(string)
				desc, _ := node.Data["description"].(string)
				argVal, _ := node.Data["argumentValue"].(string)
				argVal = applyExportVars(argVal, exportVars)
				if label == "" {
					label = sName
				}
				fmt.Fprintf(&sb, "### %s\n\n", label)
				if desc != "" {
					fmt.Fprintf(&sb, "> %s\n\n", desc)
				}
				if libSkill, ok := libraryIndex[sName]; ok {
					body := applyExportVars(libSkill.Body, exportVars)
					sb.WriteString(strings.TrimSpace(body))
					sb.WriteString("\n\n")
				} else if argVal != "" {
					fmt.Fprintf(&sb, "Invoke `/%s %s`.\n\n", sName, argVal)
				} else {
					fmt.Fprintf(&sb, "Invoke `/%s`.\n\n", sName)
				}
			}
		}

		phaseNum++
	}

	generated := Skill{
		Name:        skillName,
		Description: fmt.Sprintf("Workflow: %s (%d nodes, %d phases)", flow.Name, totalNodes, phaseNum-1),
		Body:        sb.String(),
		Scope:       scope,
	}

	return a.SaveSkill(generated, "")
}

// applyExportVars substitutes {{name}} placeholders for export.
func applyExportVars(s string, vars map[string]string) string {
	for name, value := range vars {
		s = strings.ReplaceAll(s, "{{"+name+"}}", value)
	}
	return s
}

// SaveTerminalToFile opens a native save dialog and writes the terminal content.
func (a *App) SaveTerminalToFile(content string) error {
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Save Terminal Session",
		DefaultFilename: "terminal-session.txt",
		Filters: []runtime.FileFilter{
			{DisplayName: "Text Files (*.txt)", Pattern: "*.txt"},
			{DisplayName: "All Files (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil || path == "" {
		return err
	}
	return os.WriteFile(path, []byte(content), 0644)
}

// GenerateSkillContent uses claude -p to generate a full SKILL.md for the
// given natural-language description. Returns the raw markdown string.
func (a *App) GenerateSkillContent(description string) (string, error) {
	claudePath, err := shellWhich("claude")
	if err != nil {
		return "", fmt.Errorf("claude CLI not found")
	}
	prompt := "Generate a Claude Code skill in SKILL.md format.\n\n" +
		"The skill should: " + description + "\n\n" +
		"Requirements:\n" +
		"- YAML frontmatter with name (kebab-case), description (one line), " +
		"allowed-tools (comma-separated), argument-hint only if the skill takes a runtime argument\n" +
		"- Body: clear numbered markdown steps Claude will follow when the skill is invoked\n" +
		"- Return ONLY the raw SKILL.md content — no explanation, no code fences, nothing else"
	out, err := exec.Command(claudePath, "-p", prompt).Output()
	if err != nil {
		return "", err
	}
	result := strings.TrimSpace(string(out))
	// Strip any accidental code fences
	result = regexp.MustCompile("(?s)^```[a-z]*\n(.+)\n```$").ReplaceAllString(result, "$1")
	return strings.TrimSpace(result), nil
}

// SelectAnyFile opens a native file dialog with no type filter.
func (a *App) SelectAnyFile() (string, error) {
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select File",
	})
}

// SelectScriptFile opens a native file dialog and returns the chosen path.
func (a *App) SelectScriptFile() (string, error) {
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select Shell Script",
		Filters: []runtime.FileFilter{
			{DisplayName: "Shell Scripts (*.sh, *.bash, *.zsh)", Pattern: "*.sh;*.bash;*.zsh"},
			{DisplayName: "All Files (*.*)", Pattern: "*.*"},
		},
	})
}

// SaveBlockAsLibrarySkill writes a building-block node's content to the library
// skills directory so it can be reused across flows.
func (a *App) SaveBlockAsLibrarySkill(name, content, blockType string) error {
	var body string
	switch blockType {
	case "command":
		scriptBytes, err := os.ReadFile(content) // content = scriptPath for command blocks
		if err != nil {
			return fmt.Errorf("could not read script file: %w", err)
		}
		body = fmt.Sprintf("Run the following shell script:\n\n```bash\n%s\n```", strings.TrimSpace(string(scriptBytes)))
	default: // "text"
		body = content
	}
	skill := Skill{Name: name, Body: body, Scope: "library"}
	if err := a.SaveSkill(skill, ""); err != nil {
		return err
	}
	runtime.EventsEmit(a.ctx, "mcp:refresh")
	return nil
}
