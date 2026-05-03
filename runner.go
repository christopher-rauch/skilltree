package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// computeFlowPhases returns skill nodes grouped into ordered execution phases
// via topological sort. Isolated (unconnected) nodes are omitted.
func computeFlowPhases(flow Flow) [][]FlowNode {
	inDegree := make(map[string]int)
	adj := make(map[string][]string)
	for _, n := range flow.Nodes {
		inDegree[n.ID] = 0
	}
	for _, e := range flow.Edges {
		adj[e.Source] = append(adj[e.Source], e.Target)
		inDegree[e.Target]++
	}

	level := make(map[string]int)
	remaining := maps.Clone(inDegree)
	var queue []string
	for id, deg := range inDegree {
		if deg == 0 {
			queue = append(queue, id)
			level[id] = 0
		}
	}
	sort.Strings(queue)

	maxLevel := 0
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if level[cur] > maxLevel {
			maxLevel = level[cur]
		}
		next := append([]string{}, adj[cur]...)
		sort.Strings(next)
		for _, nxt := range next {
			if level[cur]+1 > level[nxt] {
				level[nxt] = level[cur] + 1
			}
			remaining[nxt]--
			if remaining[nxt] == 0 {
				queue = append(queue, nxt)
			}
		}
	}

	nodeByID := make(map[string]FlowNode)
	for _, n := range flow.Nodes {
		nodeByID[n.ID] = n
	}

	phases := make([][]FlowNode, maxLevel+1)
	for id, lv := range level {
		n := nodeByID[id]
		phases[lv] = append(phases[lv], n)
	}
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

	var result [][]FlowNode
	for _, p := range phases {
		if len(p) > 0 {
			result = append(result, p)
		}
	}
	return result
}

// RunFlow starts executing a flow's skill nodes step by step.
// Output is streamed to the terminal panel via terminal:output events.
func (a *App) RunFlow(flow Flow) error {
	if a.runCancel != nil {
		a.runCancel()
	}
	ctx, cancel := context.WithCancel(a.ctx)
	a.runCancel = cancel
	a.runCapMu.Lock()
	a.runCap = &strings.Builder{}
	a.runCapMu.Unlock()

	go func() {
		defer func() {
			a.runCancel = nil
			a.runCapMu.Lock()
			a.runCap = nil
			a.runCapMu.Unlock()
			runtime.EventsEmit(a.ctx, "run:done")
		}()
		if err := a.executeFlow(ctx, flow); err != nil && ctx.Err() == nil {
			a.emitTerminal(fmt.Sprintf("\r\n\x1b[1;31m✗ Run failed: %s\x1b[0m\r\n", err.Error()))
		}
	}()
	return nil
}

// StopFlowRun cancels an in-progress run.
func (a *App) StopFlowRun() {
	if a.runCancel != nil {
		a.runCancel()
		a.runCancel = nil
	}
	a.runCapMu.Lock()
	a.runCap = nil
	a.runCapMu.Unlock()
	runtime.EventsEmit(a.ctx, "run:stopped")
}

// applyVars substitutes {{name}} placeholders in s using the vars map.
func applyVars(s string, vars map[string]string) string {
	for name, value := range vars {
		s = strings.ReplaceAll(s, "{{"+name+"}}", value)
	}
	return s
}

// extractVars reads the variables array from a block-variable node's data.
func extractVars(node FlowNode) map[string]string {
	out := map[string]string{}
	list, _ := node.Data["variables"].([]interface{})
	for _, item := range list {
		entry, _ := item.(map[string]interface{})
		name, _ := entry["name"].(string)
		value, _ := entry["value"].(string)
		if strings.TrimSpace(name) != "" {
			out[name] = value
		}
	}
	return out
}

// activateFunc marks a node's outgoing edges as live.
// handle="" activates all outgoing edges; a named handle activates only matching edges.
type activateFunc func(nodeID, handle string)

func (a *App) executeFlow(ctx context.Context, flow Flow) error {
	claudePath, err := shellWhich("claude")
	if err != nil {
		return fmt.Errorf("claude CLI not found — install it with: npm i -g @anthropic-ai/claude-code")
	}
	dir := a.term.dir
	if dir == "" {
		return fmt.Errorf("open the terminal first — the runner needs its session directory")
	}

	phases := computeFlowPhases(flow)
	if len(phases) == 0 {
		return fmt.Errorf("no connected nodes to run")
	}

	// Build edge lookup tables.
	outEdgesMap := map[string][]FlowEdge{} // nodeID → outgoing edges
	inEdgeMap := map[string]string{}        // nodeID → incoming edgeID (single, due to constraint)
	for _, e := range flow.Edges {
		outEdgesMap[e.Source] = append(outEdgesMap[e.Source], e)
		inEdgeMap[e.Target] = e.ID
	}

	// activeEdges tracks which edges are live. Edges from root nodes start active.
	activeEdges := map[string]bool{}
	var edgeMu sync.Mutex
	for _, node := range flow.Nodes {
		if _, hasIn := inEdgeMap[node.ID]; !hasIn {
			for _, e := range outEdgesMap[node.ID] {
				activeEdges[e.ID] = true
			}
		}
	}

	// activate is called after a node completes to mark its outgoing edges live.
	activate := func(nodeID, handle string) {
		edgeMu.Lock()
		defer edgeMu.Unlock()
		for _, e := range outEdgesMap[nodeID] {
			if handle == "" || e.SourceHandle == handle || e.SourceHandle == "" {
				activeEdges[e.ID] = true
			}
		}
	}

	// canRun returns true when a node's incoming edge (if any) is active.
	canRun := func(nodeID string) bool {
		inID, hasIn := inEdgeMap[nodeID]
		if !hasIn {
			return true
		}
		edgeMu.Lock()
		defer edgeMu.Unlock()
		return activeEdges[inID]
	}

	a.emitTerminal(fmt.Sprintf("\r\n\x1b[1;37m━━━━━ Running: %s ━━━━━\x1b[0m\r\n", flow.Name))

	vars := map[string]string{}
	var varsMu sync.Mutex

	for i, phase := range phases {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		// Filter to only nodes whose incoming edge is active.
		var execNodes []FlowNode
		for _, n := range phase {
			if canRun(n.ID) {
				execNodes = append(execNodes, n)
			}
		}
		if len(execNodes) == 0 {
			continue
		}

		phaseNum := i + 1
		if len(execNodes) > 1 {
			a.emitTerminal(fmt.Sprintf("\r\n\x1b[1;36m── Phase %d (concurrent) ──\x1b[0m\r\n", phaseNum))
		} else {
			a.emitTerminal(fmt.Sprintf("\r\n\x1b[1;36m── Phase %d ──\x1b[0m\r\n", phaseNum))
		}

		var wg sync.WaitGroup
		for _, node := range execNodes {
			wg.Add(1)
			go func(n FlowNode) {
				defer wg.Done()
				a.runNode(ctx, n, claudePath, dir, vars, &varsMu, activate)
			}(node)
		}
		wg.Wait()

		if ctx.Err() != nil {
			return ctx.Err()
		}
	}

	a.emitTerminal("\r\n\x1b[1;32m━━━━━ Run complete ━━━━━\x1b[0m\r\n")
	return nil
}

func (a *App) runNode(ctx context.Context, node FlowNode, claudePath, dir string, vars map[string]string, varsMu *sync.Mutex, activate activateFunc) {
	label, _ := node.Data["label"].(string)
	if label == "" {
		label = node.Type
	}

	// activeHandle controls which outgoing edges are activated when this node finishes.
	// "" = all edges (normal); "source-yes"/"source-no" = condition branching.
	activeHandle := ""
	defer func() { activate(node.ID, activeHandle) }()

	// Helper: substitute variables then release lock quickly.
	sub := func(s string) string {
		varsMu.Lock()
		defer varsMu.Unlock()
		return applyVars(s, vars)
	}

	runtime.EventsEmit(a.ctx, "run:node-active", node.ID)
	a.emitTerminal(fmt.Sprintf("\r\n\x1b[1;33m▶ %s\x1b[0m\r\n", label))

	var runErr error
	switch node.Type {
	case "block-mcp":
		serverName, _ := node.Data["serverName"].(string)
		toolName, _ := node.Data["toolName"].(string)
		responseVar, _ := node.Data["responseVar"].(string)
		if responseVar == "" {
			responseVar = "mcp_response"
		}
		if serverName == "" || toolName == "" {
			a.emitTerminal("\x1b[33m⚠ Server or tool name not set — skipping\x1b[0m\r\n")
			runtime.EventsEmit(a.ctx, "run:node-done", node.ID)
			return
		}

		// Build args map from key/value pairs, applying variable substitution
		mcpArgs := map[string]interface{}{}
		if argList, ok := node.Data["args"].([]interface{}); ok {
			for _, item := range argList {
				if entry, ok := item.(map[string]interface{}); ok {
					name, _ := entry["name"].(string)
					value, _ := entry["value"].(string)
					if name != "" {
						mcpArgs[sub(name)] = sub(value)
					}
				}
			}
		}

		a.emitTerminal(fmt.Sprintf("\x1b[2m  %s → %s\x1b[0m\r\n", serverName, toolName))
		result, err := a.InvokeMCPTool(serverName, toolName, mcpArgs)
		if err != nil {
			a.emitTerminal(fmt.Sprintf("\x1b[31m✗ MCP error: %s\x1b[0m\r\n", err.Error()))
			runtime.EventsEmit(a.ctx, "run:node-error", node.ID)
			return
		}
		a.emitTerminal(result + "\r\n")
		varsMu.Lock()
		vars[responseVar] = result
		varsMu.Unlock()
		a.emitTerminal(fmt.Sprintf("\x1b[2m  stored in {{%s}}\x1b[0m\r\n", responseVar))
		runtime.EventsEmit(a.ctx, "run:node-done", node.ID)
		return

	case "block-gate":
		message, _ := node.Data["message"].(string)
		if message == "" {
			message = "Continue with the flow?"
		}
		a.emitTerminal("\x1b[1;33m⏸ Waiting for approval…\x1b[0m\r\n")

		a.gateCh = make(chan bool, 1)
		runtime.EventsEmit(a.ctx, "run:gate-request", map[string]interface{}{
			"nodeId":  node.ID,
			"message": message,
		})

		select {
		case approved := <-a.gateCh:
			a.gateCh = nil
			if !approved {
				a.emitTerminal("\x1b[1;31m✗ Run aborted by user\x1b[0m\r\n")
				runtime.EventsEmit(a.ctx, "run:node-error", node.ID)
				if a.runCancel != nil {
					a.runCancel()
				}
				return
			}
			a.emitTerminal("\x1b[1;32m✓ Approved\x1b[0m\r\n")
			runtime.EventsEmit(a.ctx, "run:node-done", node.ID)
			return
		case <-ctx.Done():
			a.gateCh = nil
			return
		}

	case "block-http":
		method, _ := node.Data["method"].(string)
		if method == "" {
			method = "GET"
		}
		rawURL, _ := node.Data["url"].(string)
		rawURL = sub(rawURL)
		if strings.TrimSpace(rawURL) == "" {
			a.emitTerminal("\x1b[33m⚠ No URL set — skipping\x1b[0m\r\n")
			runtime.EventsEmit(a.ctx, "run:node-done", node.ID)
			return
		}
		bodyStr, _ := node.Data["body"].(string)
		bodyStr = sub(bodyStr)
		responseVar, _ := node.Data["responseVar"].(string)
		if responseVar == "" {
			responseVar = "http_response"
		}

		// Merge queryParams into URL
		if qpList, ok := node.Data["queryParams"].([]interface{}); ok && len(qpList) > 0 {
			if u, err := url.Parse(rawURL); err == nil {
				q := u.Query()
				for _, item := range qpList {
					if entry, ok := item.(map[string]interface{}); ok {
						name, _ := entry["name"].(string)
						value, _ := entry["value"].(string)
						if strings.TrimSpace(name) != "" {
							q.Add(sub(name), sub(value))
						}
					}
				}
				u.RawQuery = q.Encode()
				rawURL = u.String()
			}
		}

		a.emitTerminal(fmt.Sprintf("\x1b[2m  %s %s\x1b[0m\r\n", method, rawURL))

		var bodyReader *bytes.Reader
		if bodyStr != "" {
			bodyReader = bytes.NewReader([]byte(bodyStr))
		} else {
			bodyReader = bytes.NewReader(nil)
		}
		req, err := http.NewRequestWithContext(ctx, method, rawURL, bodyReader)
		if err != nil {
			a.emitTerminal(fmt.Sprintf("\x1b[31m✗ Invalid request: %s\x1b[0m\r\n", err.Error()))
			runtime.EventsEmit(a.ctx, "run:node-error", node.ID)
			return
		}

		// Apply headers
		if headerList, ok := node.Data["headers"].([]interface{}); ok {
			for _, item := range headerList {
				if entry, ok := item.(map[string]interface{}); ok {
					name, _ := entry["name"].(string)
					value, _ := entry["value"].(string)
					if name != "" {
						req.Header.Set(sub(name), sub(value))
					}
				}
			}
		}

		client := &http.Client{Timeout: 30 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			a.emitTerminal(fmt.Sprintf("\x1b[31m✗ Request failed: %s\x1b[0m\r\n", err.Error()))
			runtime.EventsEmit(a.ctx, "run:node-error", node.ID)
			return
		}
		defer resp.Body.Close()

		respBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20)) // 1 MB limit
		respBody := string(respBytes)

		// Emit status + truncated preview
		statusColor := "\x1b[32m"
		if resp.StatusCode >= 400 {
			statusColor = "\x1b[31m"
		} else if resp.StatusCode >= 300 {
			statusColor = "\x1b[33m"
		}
		a.emitTerminal(fmt.Sprintf("%sHTTP %d %s\x1b[0m\r\n", statusColor, resp.StatusCode, resp.Status))
		preview := respBody
		if len(preview) > 500 {
			preview = preview[:500] + "…"
		}
		a.emitTerminal(preview + "\r\n")

		// Store full response in vars
		varsMu.Lock()
		vars[responseVar] = respBody
		varsMu.Unlock()
		a.emitTerminal(fmt.Sprintf("\x1b[2m  stored in {{%s}}\x1b[0m\r\n", responseVar))
		runtime.EventsEmit(a.ctx, "run:node-done", node.ID)
		return

	case "block-output":
		destination, _ := node.Data["destination"].(string)
		filePath, _ := node.Data["filePath"].(string)

		// Grab and clear the capture buffer.
		a.runCapMu.Lock()
		var captured string
		if a.runCap != nil {
			captured = a.runCap.String()
			a.runCap.Reset()
		}
		a.runCapMu.Unlock()

		// Strip ANSI escape codes for clean output.
		ansiRe := regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]`)
		captured = ansiRe.ReplaceAllString(captured, "")
		// Normalise CRLF → LF
		captured = strings.ReplaceAll(captured, "\r\n", "\n")

		switch destination {
		case "clipboard":
			cmd := exec.CommandContext(ctx, "bash", "-c", "pbcopy")
			cmd.Stdin = strings.NewReader(captured)
			if err := cmd.Run(); err != nil {
				a.emitTerminal(fmt.Sprintf("\x1b[31m✗ Clipboard write failed: %s\x1b[0m\r\n", err.Error()))
				runtime.EventsEmit(a.ctx, "run:node-error", node.ID)
				return
			}
			a.emitTerminal("\x1b[2m  output copied to clipboard\x1b[0m\r\n")
		default: // "file"
			if filePath == "" {
				a.emitTerminal("\x1b[33m⚠ No output file path set — skipping\x1b[0m\r\n")
				runtime.EventsEmit(a.ctx, "run:node-done", node.ID)
				return
			}
			if err := os.WriteFile(filePath, []byte(captured), 0644); err != nil {
				a.emitTerminal(fmt.Sprintf("\x1b[31m✗ Could not write file: %s\x1b[0m\r\n", err.Error()))
				runtime.EventsEmit(a.ctx, "run:node-error", node.ID)
				return
			}
			a.emitTerminal(fmt.Sprintf("\x1b[2m  output saved to %s\x1b[0m\r\n", filepath.Base(filePath)))
		}
		runtime.EventsEmit(a.ctx, "run:node-done", node.ID)
		return

	case "block-variable":
		varsMu.Lock()
		for name, value := range extractVars(node) {
			vars[name] = value
		}
		varsMu.Unlock()
		a.emitTerminal(fmt.Sprintf("\x1b[2m  %d variable(s) defined\x1b[0m\r\n", len(extractVars(node))))
		runtime.EventsEmit(a.ctx, "run:node-done", node.ID)
		return

	case "block-context":
		content, _ := node.Data["content"].(string)
		content = sub(content)
		if strings.TrimSpace(content) == "" {
			a.emitTerminal("\x1b[33m⚠ Context injector is empty — skipping\x1b[0m\r\n")
			runtime.EventsEmit(a.ctx, "run:node-done", node.ID)
			return
		}
		// Append to CLAUDE.md in the session dir so all subsequent claude -p
		// calls in the same directory pick up this context automatically.
		claudeMDPath := filepath.Join(dir, "CLAUDE.md")
		existing, _ := os.ReadFile(claudeMDPath)
		appended := string(existing) + "\n\n---\n\n## Injected Context\n\n" + strings.TrimSpace(content) + "\n"
		if err := os.WriteFile(claudeMDPath, []byte(appended), 0644); err != nil {
			a.emitTerminal(fmt.Sprintf("\x1b[31m✗ Could not write context: %s\x1b[0m\r\n", err.Error()))
			runtime.EventsEmit(a.ctx, "run:node-error", node.ID)
			return
		}
		a.emitTerminal("\x1b[2m  context injected into session\x1b[0m\r\n")
		runtime.EventsEmit(a.ctx, "run:node-done", node.ID)
		return

	case "block-file":
		filePath, _ := node.Data["filePath"].(string)
		instruction, _ := node.Data["instruction"].(string)
		instruction = sub(instruction)
		if filePath == "" {
			a.emitTerminal("\x1b[33m⚠ No file selected — skipping\x1b[0m\r\n")
			runtime.EventsEmit(a.ctx, "run:node-done", node.ID)
			return
		}
		fileBytes, err := os.ReadFile(filePath)
		if err != nil {
			a.emitTerminal(fmt.Sprintf("\x1b[31m✗ Could not read file: %s\x1b[0m\r\n", err.Error()))
			runtime.EventsEmit(a.ctx, "run:node-error", node.ID)
			return
		}
		if instruction == "" {
			instruction = "Use the following file content as context for subsequent steps."
		}
		fname := filepath.Base(filePath)
		prompt := fmt.Sprintf("%s\n\nFile: %s\n\n```\n%s\n```", instruction, fname, strings.TrimSpace(string(fileBytes)))
		runErr = a.runClaudePrompt(ctx, claudePath, dir, prompt)

	case "block-text":
		content, _ := node.Data["content"].(string)
		content = sub(content)
		if strings.TrimSpace(content) == "" {
			a.emitTerminal("\x1b[33m⚠ Text block is empty — skipping\x1b[0m\r\n")
			runtime.EventsEmit(a.ctx, "run:node-done", node.ID)
			return
		}
		runErr = a.runClaudePrompt(ctx, claudePath, dir, content)

	case "block-command":
		scriptPath, _ := node.Data["scriptPath"].(string)
		if scriptPath == "" {
			a.emitTerminal("\x1b[33m⚠ No script selected — skipping\x1b[0m\r\n")
			runtime.EventsEmit(a.ctx, "run:node-done", node.ID)
			return
		}
		runErr = a.runShellScript(ctx, dir, scriptPath)

	case "block-condition":
		condition, _ := node.Data["condition"].(string)
		condition = sub(condition)
		if strings.TrimSpace(condition) == "" {
			a.emitTerminal("\x1b[33m⚠ Condition is empty — taking 'no' path\x1b[0m\r\n")
			activeHandle = "source-no"
			runtime.EventsEmit(a.ctx, "run:node-done", node.ID)
			return
		}
		evalPrompt := "Evaluate the following condition and respond with ONLY the single word \"yes\" or \"no\", nothing else.\n\nCondition: " + condition
		a.emitTerminal("\x1b[2m  evaluating condition…\x1b[0m\r\n")
		if err := a.runClaudePrompt(ctx, claudePath, dir, evalPrompt); err != nil {
			if ctx.Err() != nil {
				return
			}
			a.emitTerminal(fmt.Sprintf("\r\n\x1b[1;31m✗ Condition evaluation failed: %s\x1b[0m\r\n", err.Error()))
			runtime.EventsEmit(a.ctx, "run:node-error", node.ID)
			return
		}
		// Read the last captured output to determine yes/no.
		a.runCapMu.Lock()
		var captured string
		if a.runCap != nil {
			captured = a.runCap.String()
		}
		a.runCapMu.Unlock()
		answer := strings.ToLower(strings.TrimSpace(captured))
		if strings.HasPrefix(answer, "y") {
			activeHandle = "source-yes"
			a.emitTerminal("\x1b[1;32m→ yes\x1b[0m\r\n")
		} else {
			activeHandle = "source-no"
			a.emitTerminal("\x1b[1;31m→ no\x1b[0m\r\n")
		}
		runtime.EventsEmit(a.ctx, "run:node-done", node.ID)
		return

	case "block-loop":
		loopPrompt, _ := node.Data["prompt"].(string)
		loopPrompt = sub(loopPrompt)
		countRaw, _ := node.Data["count"].(float64)
		count := int(countRaw)
		if count < 1 {
			count = 1
		}
		if strings.TrimSpace(loopPrompt) == "" {
			a.emitTerminal("\x1b[33m⚠ Loop prompt is empty — skipping\x1b[0m\r\n")
			runtime.EventsEmit(a.ctx, "run:node-done", node.ID)
			return
		}
		for i := 1; i <= count; i++ {
			if ctx.Err() != nil {
				return
			}
			iterPrompt := strings.ReplaceAll(loopPrompt, "{{iteration}}", fmt.Sprintf("%d", i))
			iterPrompt = strings.ReplaceAll(iterPrompt, "{{total_iterations}}", fmt.Sprintf("%d", count))
			a.emitTerminal(fmt.Sprintf("\x1b[2m  iteration %d/%d\x1b[0m\r\n", i, count))
			if err := a.runClaudePrompt(ctx, claudePath, dir, iterPrompt); err != nil {
				if ctx.Err() != nil {
					return
				}
				a.emitTerminal(fmt.Sprintf("\r\n\x1b[1;31m✗ Loop iteration %d failed: %s\x1b[0m\r\n", i, err.Error()))
				runtime.EventsEmit(a.ctx, "run:node-error", node.ID)
				return
			}
		}
		runtime.EventsEmit(a.ctx, "run:node-done", node.ID)
		return

	default: // skill node
		skillName, _ := node.Data["skillName"].(string)
		argumentValue, _ := node.Data["argumentValue"].(string)
		argumentValue = sub(argumentValue)
		prompt := a.resolveSkillPrompt(skillName, argumentValue)
		runErr = a.runClaudePrompt(ctx, claudePath, dir, prompt)
	}

	if runErr != nil {
		if ctx.Err() != nil {
			return
		}
		a.emitTerminal(fmt.Sprintf("\r\n\x1b[1;31m✗ %s failed: %s\x1b[0m\r\n", label, runErr.Error()))
		runtime.EventsEmit(a.ctx, "run:node-error", node.ID)
		return
	}

	a.emitTerminal(fmt.Sprintf("\r\n\x1b[1;32m✓ %s\x1b[0m\r\n", label))
	runtime.EventsEmit(a.ctx, "run:node-done", node.ID)
}

func (a *App) runShellScript(ctx context.Context, dir, scriptPath string) error {
	cmd := exec.CommandContext(ctx, "bash", scriptPath)
	cmd.Dir = dir

	fullPath := os.Getenv("PATH")
	if out, err := exec.Command(os.Getenv("SHELL"), "-l", "-c", "echo $PATH").Output(); err == nil {
		if p := strings.TrimSpace(string(out)); p != "" {
			fullPath = p
		}
	}
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "PATH="+fullPath)

	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		return err
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); a.pipeToTerminal(stdout) }()
	go func() { defer wg.Done(); a.pipeToTerminal(stderr) }()
	wg.Wait()
	return cmd.Wait()
}

// resolveSkillPrompt returns the prompt to pass to claude -p.
// Library skills inline their body; global/project skills invoke by name.
// argumentValue is appended when provided.
func (a *App) resolveSkillPrompt(skillName, argumentValue string) string {
	libPath := filepath.Join(librarySkillsDir(), skillName, "SKILL.md")
	if skill, err := parseSkillFile(libPath, "library"); err == nil && skill.Body != "" {
		if argumentValue != "" {
			return skill.Body + "\n\nArgument: " + argumentValue
		}
		return skill.Body
	}
	if argumentValue != "" {
		return "/" + skillName + " " + argumentValue
	}
	return "/" + skillName
}

func (a *App) runClaudePrompt(ctx context.Context, claudePath, dir, prompt string) error {
	fullPath := os.Getenv("PATH")
	if out, err := exec.Command(os.Getenv("SHELL"), "-l", "-c", "echo $PATH").Output(); err == nil {
		if p := strings.TrimSpace(string(out)); p != "" {
			fullPath = p
		}
	}

	cmd := exec.CommandContext(ctx, claudePath, "-p", prompt)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"PATH="+fullPath,
	)

	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		return err
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); a.pipeToTerminal(stdout) }()
	go func() { defer wg.Done(); a.pipeToTerminal(stderr) }()
	wg.Wait()

	return cmd.Wait()
}

func (a *App) pipeToTerminal(r io.Reader) {
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			a.emitTerminal(string(buf[:n]))
		}
		if err != nil {
			break
		}
	}
}

func (a *App) emitTerminal(text string) {
	encoded := base64.StdEncoding.EncodeToString([]byte(text))
	runtime.EventsEmit(a.ctx, "terminal:output", encoded)
	if a.runCap != nil {
		a.runCapMu.Lock()
		a.runCap.WriteString(text)
		a.runCapMu.Unlock()
	}
}
