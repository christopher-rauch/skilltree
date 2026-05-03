package main

import (
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

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
	cols    uint16
	rows    uint16
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

	home, _ := os.UserHomeDir()
	claudeDir := filepath.Join(home, ".claude")

	// Temp session directory (just holds CLAUDE.md; proxy lives elsewhere now)
	dir, err := os.MkdirTemp("", "skilltree-session-*")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte(claudeMD()), 0644); err != nil {
		os.RemoveAll(dir)
		return err
	}

	// Symlink library skills into the session as project-scoped skills so Claude
	// can invoke them (e.g. /create-custom-block) from the interactive terminal.
	sessionSkillsDir := filepath.Join(dir, ".claude", "skills")
	if libEntries, err := os.ReadDir(a.librarySkillsDir()); err == nil && len(libEntries) > 0 {
		_ = os.MkdirAll(sessionSkillsDir, 0755)
		for _, e := range libEntries {
			if !e.IsDir() {
				continue
			}
			src := filepath.Join(a.librarySkillsDir(), e.Name())
			dst := filepath.Join(sessionSkillsDir, e.Name())
			_ = os.Symlink(src, dst)
		}
	}

	nodePath, err := shellWhich("node")
	if err != nil {
		os.RemoveAll(dir)
		return fmt.Errorf("node not found — required for MCP integration")
	}

	// Write port to a stable file that the proxy reads at request time.
	// This survives app restarts without needing to re-register.
	portFile := filepath.Join(claudeDir, "skilltree-mcp-port")
	if err := os.WriteFile(portFile, []byte(fmt.Sprintf("%d", a.mcpPort)), 0644); err != nil {
		os.RemoveAll(dir)
		return err
	}

	// Write the proxy to a stable, permanent path in ~/.claude/ so the daemon
	// can always find it. It reads the port file dynamically on every request,
	// so no re-registration is needed if the app restarts with a new port.
	proxyPath := filepath.Join(claudeDir, "skilltree-mcp-proxy.js")
	if err := os.WriteFile(proxyPath, []byte(mcpProxyJS(portFile)), 0644); err != nil {
		os.RemoveAll(dir)
		return err
	}

	// Register once. If already registered with the right path, this is a no-op.
	if err := a.registerMCPServer(claudePath, nodePath, proxyPath); err != nil {
		runtime.EventsEmit(a.ctx, "terminal:output",
			base64.StdEncoding.EncodeToString([]byte("\r\n\x1b[33m[Skilltree] Warning: could not register MCP server: "+err.Error()+"]\r\n")))
	}

	// Brief pause so the daemon finishes connecting to the proxy before
	// Claude starts its session and loads the tool list.
	time.Sleep(1500 * time.Millisecond)

	// Resolve the full user PATH via a login shell so Claude's session has
	// access to all the same binaries as a regular terminal (e.g. ~/.local/bin).
	fullPath := os.Getenv("PATH")
	if out, err := exec.Command(os.Getenv("SHELL"), "-l", "-c", "echo $PATH").Output(); err == nil {
		if p := strings.TrimSpace(string(out)); p != "" {
			fullPath = p
		}
	}

	cmd := exec.Command(claudePath)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"PATH="+fullPath,
	)

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
	a.term.cols = cols
	a.term.rows = rows

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
	deregisterMCPServer()
}

const mcpServerKey = "skilltree-gui"

func (a *App) registerMCPServer(claudePath, nodePath, proxyPath string) error {
	// Remove stale entry silently, then register fresh.
	exec.Command(claudePath, "mcp", "remove", "-s", "user", mcpServerKey).Run() //nolint
	cmd := exec.Command(claudePath, "mcp", "add", "-s", "user", mcpServerKey, "--", nodePath, proxyPath)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%w: %s", err, string(out))
	}
	return nil
}

func deregisterMCPServer() {
	claudePath, err := shellWhich("claude")
	if err != nil {
		return
	}
	exec.Command(claudePath, "mcp", "remove", "-s", "user", mcpServerKey).Run() //nolint
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
	a.term.cols = cols
	a.term.rows = rows
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

// mcpProxyJS generates a permanent proxy script that reads the port from a
// file at runtime — so no re-registration is needed when the app restarts
// and gets a new random port.
func mcpProxyJS(portFile string) string {
	return fmt.Sprintf(`// Skilltree MCP stdio proxy — reads port dynamically from file.
'use strict';
const http = require('http');
const fs   = require('fs');

const PORT_FILE = %q;
function getPort() {
  try { return parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10); }
  catch { return 0; }
}

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
process.stdin.on('end', () => process.exit(0));
process.on('uncaughtException', (e) => process.stderr.write('[skilltree-mcp] ' + e.message + '\n'));

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function dispatch(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  const port = getPort();
  if (!port) {
    if (msg.id != null) send({ jsonrpc: '2.0', id: msg.id,
      error: { code: -32000, message: 'Skilltree not running (port file missing)' } });
    return;
  }

  const body = Buffer.from(line, 'utf8');
  const req = http.request(
    { hostname: '127.0.0.1', port, path: '/message-sync', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
    (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString().trim();
        if (text) process.stdout.write(text + '\n');
      });
    }
  );
  req.on('error', (err) => {
    if (msg.id != null) send({ jsonrpc: '2.0', id: msg.id,
      error: { code: -32000, message: 'Skilltree unreachable: ' + err.message } });
  });
  req.end(body);
}
`, portFile)
}
