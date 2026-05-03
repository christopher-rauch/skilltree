package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// ── Settings parsing ─────────────────────────────────────────────────────────

type claudeSettings struct {
	MCPServers map[string]mcpServerDef `json:"mcpServers"`
}

type mcpServerDef struct {
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
	Type    string            `json:"type"` // "stdio" (default) | "sse" | "http"
	URL     string            `json:"url"`
}

func readClaudeSettings() (claudeSettings, error) {
	home, _ := os.UserHomeDir()
	path := filepath.Join(home, ".claude", "settings.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return claudeSettings{}, err
	}
	var s claudeSettings
	err = json.Unmarshal(data, &s)
	return s, err
}

// GetMCPServers returns the names of all configured MCP servers.
func (a *App) GetMCPServers() ([]string, error) {
	s, err := readClaudeSettings()
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(s.MCPServers))
	for name := range s.MCPServers {
		names = append(names, name)
	}
	return names, nil
}

// ── Stdio MCP client ─────────────────────────────────────────────────────────

// mcpClientConn holds the pipes to a running stdio MCP server process.
type mcpClientConn struct {
	cmd    *exec.Cmd
	writer *json.Encoder
	reader *bufio.Reader
}

func newMCPClient(ctx context.Context, def mcpServerDef) (*mcpClientConn, func(), error) {
	// Resolve command via login shell PATH
	fullPath := os.Getenv("PATH")
	if out, err := exec.Command(os.Getenv("SHELL"), "-l", "-c", "echo $PATH").Output(); err == nil {
		if p := strings.TrimSpace(string(out)); p != "" {
			fullPath = p
		}
	}

	cmd := exec.CommandContext(ctx, def.Command, def.Args...)
	env := append(os.Environ(), "PATH="+fullPath)
	for k, v := range def.Env {
		env = append(env, k+"="+v)
	}
	cmd.Env = env

	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		return nil, nil, err
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}

	if err := cmd.Start(); err != nil {
		return nil, nil, err
	}

	c := &mcpClientConn{
		cmd:    cmd,
		writer: json.NewEncoder(stdinPipe),
		reader: bufio.NewReader(stdoutPipe),
	}

	cleanup := func() {
		stdinPipe.Close()
		cmd.Process.Kill()
		cmd.Wait()
	}

	return c, cleanup, nil
}

func (c *mcpClientConn) send(req rpcRequest) error {
	return c.writer.Encode(req)
}

// readUntilID reads lines until it finds a response with the given numeric ID.
// Notifications (no ID) and mismatched IDs are discarded.
func (c *mcpClientConn) readUntilID(id int) (*rpcResponse, error) {
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		line, err := c.reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var resp rpcResponse
		if err := json.Unmarshal([]byte(line), &resp); err != nil {
			continue
		}
		if resp.ID == nil {
			continue // notification
		}
		// JSON numbers decode as float64
		if v, ok := resp.ID.(float64); ok && int(v) == id {
			return &resp, nil
		}
	}
	return nil, fmt.Errorf("timeout waiting for response id %d", id)
}

func marshalParams(v interface{}) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func (c *mcpClientConn) initialize() error {
	if err := c.send(rpcRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "initialize",
		Params: marshalParams(map[string]interface{}{
			"protocolVersion": "2024-11-05",
			"capabilities":    map[string]interface{}{},
			"clientInfo":      map[string]interface{}{"name": "skilltree", "version": "1.0"},
		}),
	}); err != nil {
		return err
	}
	if _, err := c.readUntilID(1); err != nil {
		return fmt.Errorf("initialize handshake failed: %w", err)
	}
	// Send initialized notification (no response expected)
	return c.send(rpcRequest{JSONRPC: "2.0", Method: "notifications/initialized"})
}

// InvokeMCPTool starts the named MCP server, initializes it, calls the tool,
// and returns the raw result JSON as a string.
func (a *App) InvokeMCPTool(serverName, toolName string, args map[string]interface{}) (string, error) {
	settings, err := readClaudeSettings()
	if err != nil {
		return "", fmt.Errorf("could not read ~/.claude/settings.json: %w", err)
	}
	def, ok := settings.MCPServers[serverName]
	if !ok {
		return "", fmt.Errorf("MCP server %q not found in settings", serverName)
	}
	if def.Type != "" && def.Type != "stdio" {
		return "", fmt.Errorf("only stdio MCP servers are supported (server %q is type %q)", serverName, def.Type)
	}

	ctx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
	defer cancel()

	client, cleanup, err := newMCPClient(ctx, def)
	if err != nil {
		return "", fmt.Errorf("could not start MCP server %q: %w", serverName, err)
	}
	defer cleanup()

	if err := client.initialize(); err != nil {
		return "", err
	}

	if err := client.send(rpcRequest{
		JSONRPC: "2.0",
		ID:      2,
		Method:  "tools/call",
		Params:  marshalParams(map[string]interface{}{"name": toolName, "arguments": args}),
	}); err != nil {
		return "", err
	}

	resp, err := client.readUntilID(2)
	if err != nil {
		return "", fmt.Errorf("tool call failed: %w", err)
	}
	if resp.Error != nil {
		b, _ := json.Marshal(resp.Error)
		return "", fmt.Errorf("MCP error: %s", string(b))
	}

	// Pretty-print the result for readability
	b, _ := json.MarshalIndent(resp.Result, "", "  ")
	return string(b), nil
}
