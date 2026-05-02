package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"sync"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type mcpServer struct {
	app      *App
	sessions map[string]chan []byte
	mu       sync.Mutex
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcResponse struct {
	JSONRPC string `json:"jsonrpc"`
	ID      any    `json:"id"`
	Result  any    `json:"result,omitempty"`
	Error   any    `json:"error,omitempty"`
}

func startMCPServer(app *App) (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := ln.Addr().(*net.TCPAddr).Port

	srv := &mcpServer{app: app, sessions: make(map[string]chan []byte)}
	mux := http.NewServeMux()
	mux.HandleFunc("/sse", srv.handleSSE)
	mux.HandleFunc("/message", srv.handleMessage)
	mux.HandleFunc("/message-sync", srv.handleMessageSync) // for stdio proxy
	go func() { _ = http.Serve(ln, mux) }()
	return port, nil
}

// handleMessageSync is a synchronous JSON-RPC endpoint used by the stdio proxy.
// It processes the request and returns the response directly in the HTTP body.
func (s *mcpServer) handleMessageSync(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	var req rpcRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"jsonrpc":"2.0","error":{"code":-32700,"message":"parse error"}}`, 400)
		return
	}

	resp := s.dispatch(req)
	if resp == nil {
		// Notification — no response
		w.WriteHeader(http.StatusNoContent)
		return
	}
	json.NewEncoder(w).Encode(resp)
}

func (s *mcpServer) handleSSE(w http.ResponseWriter, r *http.Request) {
	sid := fmt.Sprintf("s%p", r)
	ch := make(chan []byte, 64)
	s.mu.Lock()
	s.sessions[sid] = ch
	s.mu.Unlock()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	fmt.Fprintf(w, "event: endpoint\ndata: /message?sessionId=%s\n\n", sid)
	w.(http.Flusher).Flush()

	defer func() {
		s.mu.Lock()
		delete(s.sessions, sid)
		s.mu.Unlock()
	}()
	for {
		select {
		case data := <-ch:
			fmt.Fprintf(w, "event: message\ndata: %s\n\n", data)
			w.(http.Flusher).Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func (s *mcpServer) handleMessage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method == "OPTIONS" {
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		return
	}
	sid := r.URL.Query().Get("sessionId")
	var req rpcRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", 400)
		return
	}
	w.WriteHeader(http.StatusAccepted)
	go func() {
		resp := s.dispatch(req)
		if resp == nil {
			return
		}
		data, _ := json.Marshal(resp)
		s.mu.Lock()
		ch := s.sessions[sid]
		s.mu.Unlock()
		if ch != nil {
			select {
			case ch <- data:
			default:
			}
		}
	}()
}

func (s *mcpServer) dispatch(req rpcRequest) *rpcResponse {
	ok := func(result any) *rpcResponse {
		return &rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: result}
	}
	rpcErr := func(msg string) *rpcResponse {
		return &rpcResponse{JSONRPC: "2.0", ID: req.ID,
			Error: map[string]any{"code": -32000, "message": msg}}
	}

	switch req.Method {
	case "initialize":
		// Echo the client's protocol version so we never mismatch
		var params struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &params)
		if params.ProtocolVersion == "" {
			params.ProtocolVersion = "2024-11-05"
		}
		return ok(map[string]any{
			"protocolVersion": params.ProtocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "skilltree-gui", "version": "1.0"},
		})

	case "initialized":
		return nil

	case "tools/list":
		return ok(map[string]any{"tools": s.toolList()})

	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return rpcErr("invalid params")
		}
		text, err := s.callTool(p.Name, p.Arguments)
		if err != nil {
			return rpcErr(err.Error())
		}
		return ok(map[string]any{
			"content": []map[string]any{{"type": "text", "text": text}},
		})
	}
	return rpcErr("method not found")
}

func str(m map[string]any, k string) string {
	v, _ := m[k].(string)
	return v
}

func (s *mcpServer) callTool(name string, args map[string]any) (string, error) {
	emit := func(event string, data any) {
		runtime.EventsEmit(s.app.ctx, event, data)
	}

	switch name {
	case "navigate":
		view := str(args, "view")
		emit("mcp:navigate", view)
		return "Navigated to " + view, nil

	case "list_skills":
		scope := str(args, "scope")
		var skills []Skill
		switch scope {
		case "global":
			skills, _ = s.app.GetGlobalSkills()
		case "project":
			skills, _ = s.app.GetProjectSkills()
		default:
			g, _ := s.app.GetGlobalSkills()
			p, _ := s.app.GetProjectSkills()
			skills = append(g, p...)
		}
		data, _ := json.MarshalIndent(skills, "", "  ")
		return string(data), nil

	case "create_skill":
		skill := Skill{
			Name: str(args, "name"), Description: str(args, "description"),
			Body: str(args, "body"), Scope: str(args, "scope"),
			ArgumentHint: str(args, "argumentHint"), AllowedTools: str(args, "allowedTools"),
		}
		if skill.Scope == "" {
			skill.Scope = "global"
		}
		if err := s.app.SaveSkill(skill, ""); err != nil {
			return "", err
		}
		emit("mcp:refresh", nil)
		return fmt.Sprintf("Created skill '%s' (%s)", skill.Name, skill.Scope), nil

	case "delete_skill":
		if err := s.app.DeleteSkill(str(args, "name"), str(args, "scope")); err != nil {
			return "", err
		}
		emit("mcp:refresh", nil)
		return "Deleted skill " + str(args, "name"), nil

	case "list_flows":
		flows, err := s.app.GetFlows()
		if err != nil {
			return "", err
		}
		data, _ := json.MarshalIndent(flows, "", "  ")
		return string(data), nil

	case "create_flow":
		id := s.app.NewFlowID()
		flow := Flow{ID: id, Name: str(args, "name"), Nodes: []FlowNode{}, Edges: []FlowEdge{}}
		if flow.Name == "" {
			flow.Name = "New Skilltree"
		}
		if err := s.app.SaveFlow(flow); err != nil {
			return "", err
		}
		emit("mcp:refresh", nil)
		return fmt.Sprintf("Created flow '%s' (id: %s)", flow.Name, flow.ID), nil

	case "delete_flow":
		if err := s.app.DeleteFlow(str(args, "id")); err != nil {
			return "", err
		}
		emit("mcp:refresh", nil)
		return "Deleted flow " + str(args, "id"), nil

	case "open_flow":
		emit("mcp:open_flow", str(args, "id"))
		return "Opened flow " + str(args, "id"), nil

	case "export_flow_as_skill":
		flows, _ := s.app.GetFlows()
		id := str(args, "id")
		for _, f := range flows {
			if f.ID == id {
				scope := str(args, "scope")
				if scope == "" {
					scope = "global"
				}
				if err := s.app.GenerateFlowSkill(f, str(args, "skillName"), scope); err != nil {
					return "", err
				}
				emit("mcp:refresh", nil)
				return "Exported flow as skill " + str(args, "skillName"), nil
			}
		}
		return "", fmt.Errorf("flow not found: %s", id)
	}
	return "", fmt.Errorf("unknown tool: %s", name)
}

func (s *mcpServer) toolList() []map[string]any {
	tool := func(name, desc string, props map[string]any, required []string) map[string]any {
		return map[string]any{
			"name": name, "description": desc,
			"inputSchema": map[string]any{
				"type": "object", "properties": props, "required": required,
			},
		}
	}
	str := func(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }

	return []map[string]any{
		tool("navigate", "Switch the app to a different view",
			map[string]any{"view": str("One of: skills, trees, board")}, []string{"view"}),
		tool("list_skills", "List all Claude skills",
			map[string]any{"scope": str("Optional: global or project")}, nil),
		tool("create_skill", "Create or update a skill",
			map[string]any{
				"name": str("Skill name (lowercase, hyphens)"), "description": str("When to use this skill"),
				"body": str("Markdown body"), "scope": str("global or project"),
				"argumentHint": str("Optional argument hint"), "allowedTools": str("Optional comma-separated tools"),
			}, []string{"name", "description", "body"}),
		tool("delete_skill", "Delete a skill",
			map[string]any{"name": str("Skill name"), "scope": str("global or project")},
			[]string{"name", "scope"}),
		tool("list_flows", "List all saved skilltrees/flows", map[string]any{}, nil),
		tool("create_flow", "Create a new empty flow",
			map[string]any{"name": str("Flow name")}, []string{"name"}),
		tool("delete_flow", "Delete a flow",
			map[string]any{"id": str("Flow ID")}, []string{"id"}),
		tool("open_flow", "Open a flow in the Builder",
			map[string]any{"id": str("Flow ID")}, []string{"id"}),
		tool("export_flow_as_skill", "Export a flow as a Claude skill",
			map[string]any{
				"id": str("Flow ID"), "skillName": str("Name for the generated skill"),
				"scope": str("global or project"),
			}, []string{"id", "skillName"}),
	}
}
