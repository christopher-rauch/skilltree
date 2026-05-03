package main

import (
	"bufio"
	"bytes"
	"embed"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	// When spawned by Claude Code as an MCP stdio server:
	//   skilltree --mcp-stdio <port>
	// Read JSON-RPC from stdin, POST to the running app's HTTP server,
	// write responses to stdout — no GUI involved.
	if len(os.Args) == 3 && os.Args[1] == "--mcp-stdio" {
		port, err := strconv.Atoi(os.Args[2])
		if err != nil {
			fmt.Fprintln(os.Stderr, "invalid port:", os.Args[2])
			os.Exit(1)
		}
		runMCPStdio(port)
		return
	}

	app := NewApp()

	err := wails.Run(&options.App{
		Title:            "Skilltree",
		Width:            1920,
		Height:           1200,
		MinWidth:         900,
		MinHeight:        600,
		BackgroundColour: &options.RGBA{R: 10, G: 10, B: 10, A: 1},
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		OnStartup:     app.startup,
		OnShutdown:    app.shutdown,
		OnBeforeClose: app.beforeClose,
		Bind:          []any{app},
		Mac: &mac.Options{
			TitleBar: mac.TitleBarHiddenInset(),
			About: &mac.AboutInfo{
				Title:   "Skilltree",
				Message: "A visual skill and workflow manager for Claude Code.\n\nBuild, connect, and export Claude skills as node-based skilltrees — with a built-in Claude terminal and MCP integration.\n\ngithub.com/christopher-rauch",
			},
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}

// runMCPStdio is the stdio MCP proxy mode. It pipes newline-delimited
// JSON-RPC messages from stdin to the app's /message-sync HTTP endpoint
// and writes the responses back to stdout.
func runMCPStdio(port int) {
	client := &http.Client{}
	url := fmt.Sprintf("http://127.0.0.1:%d/message-sync", port)

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4*1024*1024), 4*1024*1024)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		resp, err := client.Post(url, "application/json", bytes.NewReader([]byte(line)))
		if err != nil {
			continue
		}
		data, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil || len(bytes.TrimSpace(data)) == 0 {
			continue
		}
		os.Stdout.Write(data)
		os.Stdout.Write([]byte("\n"))
	}
}
