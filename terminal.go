package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/creack/pty"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// shellWhich asks a login shell to resolve a command so we pick up the user's
// full PATH (npm globals, nvm, Homebrew, etc.) even when launched as a .app.
func shellWhich(name string) (string, error) {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/zsh"
	}
	out, err := exec.Command(shell, "-l", "-c", "which "+name).Output()
	if err == nil {
		if p := strings.TrimSpace(string(out)); p != "" {
			return p, nil
		}
	}
	// Fallback: check common install locations directly
	candidates := []string{
		"/usr/local/bin/" + name,
		"/opt/homebrew/bin/" + name,
		filepath.Join(os.Getenv("HOME"), ".npm-global", "bin", name),
		filepath.Join(os.Getenv("HOME"), ".local", "bin", name),
	}
	for _, c := range candidates {
		if _, statErr := os.Stat(c); statErr == nil {
			return c, nil
		}
	}
	return "", fmt.Errorf("%s not found", name)
}

type termState struct {
	mu      sync.Mutex
	ptmx    *os.File
	cmd     *exec.Cmd
	dir     string
	running bool
}

func (a *App) StartTerminal(cols, rows uint16) error {
	a.term.mu.Lock()
	defer a.term.mu.Unlock()
	if a.term.running {
		return nil
	}

	claudePath, err := shellWhich("claude")
	if err != nil {
		return fmt.Errorf("claude CLI not found — install it with: npm i -g @anthropic-ai/claude-code")
	}

	// Temp session directory
	dir, err := os.MkdirTemp("", "skilltree-session-*")
	if err != nil {
		return err
	}

	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte(claudeMD()), 0644); err != nil {
		os.RemoveAll(dir)
		return err
	}

	// Write a tiny Node.js proxy that bridges Claude's stdio MCP to our HTTP server.
	// Using Node avoids any macOS binary-signing issues with spawning the Wails .app.
	nodePath, err := shellWhich("node")
	if err != nil {
		os.RemoveAll(dir)
		return fmt.Errorf("node not found — required for MCP integration")
	}
	proxyPath := filepath.Join(dir, "mcp-proxy.js")
	if err := os.WriteFile(proxyPath, []byte(mcpProxyJS(a.mcpPort)), 0644); err != nil {
		os.RemoveAll(dir)
		return err
	}

	// Project-scoped settings so Claude picks up our MCP server
	claudeDir := filepath.Join(dir, ".claude")
	if err := os.MkdirAll(claudeDir, 0755); err != nil {
		os.RemoveAll(dir)
		return err
	}
	settings := map[string]any{
		"mcpServers": map[string]any{
			"skilltree-gui": map[string]any{
				"command": nodePath,
				"args":    []string{proxyPath},
			},
		},
	}
	settingsJSON, _ := json.MarshalIndent(settings, "", "  ")
	if err := os.WriteFile(filepath.Join(claudeDir, "settings.json"), settingsJSON, 0644); err != nil {
		os.RemoveAll(dir)
		return err
	}

	cmd := exec.Command(claudePath)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

	if cols == 0 {
		cols = 220
	}
	if rows == 0 {
		rows = 50
	}
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		os.RemoveAll(dir)
		return err
	}

	a.term.ptmx = ptmx
	a.term.cmd = cmd
	a.term.dir = dir
	a.term.running = true

	go func() {
		buf := make([]byte, 4096)
		for {
			n, readErr := ptmx.Read(buf)
			if n > 0 {
				runtime.EventsEmit(a.ctx, "terminal:output",
					base64.StdEncoding.EncodeToString(buf[:n]))
			}
			if readErr != nil {
				break
			}
		}
		a.term.mu.Lock()
		a.term.running = false
		if a.term.dir != "" {
			os.RemoveAll(a.term.dir)
			a.term.dir = ""
		}
		a.term.mu.Unlock()
		runtime.EventsEmit(a.ctx, "terminal:exit", nil)
	}()

	return nil
}

func (a *App) StopTerminal() {
	a.term.mu.Lock()
	defer a.term.mu.Unlock()
	if !a.term.running {
		return
	}
	if a.term.cmd != nil && a.term.cmd.Process != nil {
		_ = a.term.cmd.Process.Kill()
	}
	if a.term.ptmx != nil {
		_ = a.term.ptmx.Close()
	}
	if a.term.dir != "" {
		os.RemoveAll(a.term.dir)
		a.term.dir = ""
	}
	a.term.running = false
}

func (a *App) TerminalInput(dataB64 string) error {
	a.term.mu.Lock()
	defer a.term.mu.Unlock()
	if !a.term.running || a.term.ptmx == nil {
		return fmt.Errorf("terminal not running")
	}
	data, err := base64.StdEncoding.DecodeString(dataB64)
	if err != nil {
		return err
	}
	_, err = a.term.ptmx.Write(data)
	return err
}

func (a *App) TerminalResize(cols, rows uint16) error {
	a.term.mu.Lock()
	defer a.term.mu.Unlock()
	if a.term.ptmx == nil {
		return nil
	}
	return pty.Setsize(a.term.ptmx, &pty.Winsize{Cols: cols, Rows: rows})
}

func (a *App) IsTerminalRunning() bool {
	a.term.mu.Lock()
	defer a.term.mu.Unlock()
	return a.term.running
}

func claudeMD() string {
	bt := "`"
	return "# Skilltree — Claude Interface\n\n" +
		"You are running inside the **Skilltree** desktop app via a built-in terminal.\n\n" +
		"Skilltree is a GUI for managing Claude skills and building skill workflows.\n\n" +
		"## MCP Tools (skilltree-gui server)\n\n" +
		"You have access to the following tools via the " + bt + "skilltree-gui" + bt + " MCP server.\n" +
		"Use them directly — do NOT use Bash or curl to interact with the app.\n\n" +
		"| Tool | What it does |\n" +
		"|---|---|\n" +
		"| " + bt + "navigate" + bt + " | Switch view: skills, trees, or board |\n" +
		"| " + bt + "list_skills" + bt + " | List skills (scope: global or project) |\n" +
		"| " + bt + "create_skill" + bt + " | Create or update a skill file |\n" +
		"| " + bt + "delete_skill" + bt + " | Delete a skill |\n" +
		"| " + bt + "list_flows" + bt + " | List all saved skilltrees |\n" +
		"| " + bt + "create_flow" + bt + " | Create a new empty flow |\n" +
		"| " + bt + "delete_flow" + bt + " | Delete a flow |\n" +
		"| " + bt + "open_flow" + bt + " | Open a flow in the Node Board view |\n" +
		"| " + bt + "export_flow_as_skill" + bt + " | Convert a flow into a Claude skill |\n\n" +
		"## Concepts\n\n" +
		"- **Skill** — a Claude slash command stored as SKILL.md in " + bt + "~/.claude/skills/" + bt + " (global) or " + bt + ".claude/skills/" + bt + " (project)\n" +
		"- **Flow / Skilltree** — a saved node board connecting skills in sequence or parallel phases\n" +
		"- **Export** — converts a flow into a new skill that chains all connected skills in order\n\n" +
		"When the user asks you to perform GUI actions, call the MCP tool directly.\n"
}

func mcpProxyJS(port int) string {
	return fmt.Sprintf(`// Skilltree MCP stdio proxy
// Bridges Claude Code's stdio MCP transport to the Skilltree HTTP server.
'use strict';
const http = require('http');

const PORT = %d;
let buf = '';

process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) dispatch(line);
  }
});

// Keep alive until stdin closes
process.stdin.on('end', () => process.exit(0));

// Surface unhandled rejections as stderr noise rather than crashing
process.on('uncaughtException', (e) => process.stderr.write('[mcp-proxy] ' + e.message + '\n'));

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function dispatch(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  const body = Buffer.from(line, 'utf8');

  const options = {
    hostname: '127.0.0.1',
    port: PORT,
    path: '/message-sync',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
    },
  };

  const req = http.request(options, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString().trim();
      if (text) process.stdout.write(text + '\n');
    });
  });

  req.on('error', (err) => {
    // Return a proper JSON-RPC error so Claude doesn't hang waiting
    if (msg.id !== undefined && msg.id !== null) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32000, message: 'Skilltree app not reachable: ' + err.message },
      });
    }
  });

  req.end(body);
}
`, port)
}
