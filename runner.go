package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"

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

	go func() {
		defer func() {
			a.runCancel = nil
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
	runtime.EventsEmit(a.ctx, "run:stopped")
}

func (a *App) executeFlow(ctx context.Context, flow Flow) error {
	claudePath, err := shellWhich("claude")
	if err != nil {
		return fmt.Errorf("claude CLI not found — install it with: npm i -g @anthropic-ai/claude-code")
	}

	// Use the terminal's session directory so Claude runs in a trusted, pre-configured context.
	dir := a.term.dir
	if dir == "" {
		return fmt.Errorf("open the terminal first — the runner needs its session directory")
	}

	phases := computeFlowPhases(flow)
	if len(phases) == 0 {
		return fmt.Errorf("no connected nodes to run")
	}

	a.emitTerminal(fmt.Sprintf("\r\n\x1b[1;37m━━━━━ Running: %s ━━━━━\x1b[0m\r\n", flow.Name))

	for i, phase := range phases {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		phaseNum := i + 1
		if len(phase) > 1 {
			a.emitTerminal(fmt.Sprintf("\r\n\x1b[1;36m── Phase %d (concurrent) ──\x1b[0m\r\n", phaseNum))
		} else {
			a.emitTerminal(fmt.Sprintf("\r\n\x1b[1;36m── Phase %d ──\x1b[0m\r\n", phaseNum))
		}

		var wg sync.WaitGroup
		for _, node := range phase {
			wg.Add(1)
			go func(n FlowNode) {
				defer wg.Done()
				a.runNode(ctx, n, claudePath, dir)
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

func (a *App) runNode(ctx context.Context, node FlowNode, claudePath, dir string) {
	skillName, _ := node.Data["skillName"].(string)
	label, _ := node.Data["label"].(string)
	if label == "" {
		label = skillName
	}

	runtime.EventsEmit(a.ctx, "run:node-active", node.ID)
	a.emitTerminal(fmt.Sprintf("\r\n\x1b[1;33m▶ %s\x1b[0m\r\n", label))

	prompt := a.resolveSkillPrompt(skillName)

	if err := a.runClaudePrompt(ctx, claudePath, dir, prompt); err != nil {
		if ctx.Err() != nil {
			return
		}
		a.emitTerminal(fmt.Sprintf("\r\n\x1b[1;31m✗ %s failed: %s\x1b[0m\r\n", label, err.Error()))
		runtime.EventsEmit(a.ctx, "run:node-error", node.ID)
		return
	}

	a.emitTerminal(fmt.Sprintf("\r\n\x1b[1;32m✓ %s\x1b[0m\r\n", label))
	runtime.EventsEmit(a.ctx, "run:node-done", node.ID)
}

// resolveSkillPrompt returns the prompt to pass to claude -p.
// Library skills inline their body; global/project skills invoke by name.
func (a *App) resolveSkillPrompt(skillName string) string {
	libPath := filepath.Join(librarySkillsDir(), skillName, "SKILL.md")
	if skill, err := parseSkillFile(libPath, "library"); err == nil && skill.Body != "" {
		return skill.Body
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
}
