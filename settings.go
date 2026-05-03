package main

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// AppSettings holds user-configurable paths.
type AppSettings struct {
	GlobalSkillsDir      string `json:"globalSkillsDir"`
	LibrarySkillsDir     string `json:"librarySkillsDir"`
	ProjectSkillsRelPath string `json:"projectSkillsRelPath"`
}

func defaultSettings() AppSettings {
	home, _ := os.UserHomeDir()
	return AppSettings{
		GlobalSkillsDir:      filepath.Join(home, ".claude", "skills"),
		LibrarySkillsDir:     filepath.Join(home, ".claude", "skilltree", "skills"),
		ProjectSkillsRelPath: filepath.Join(".claude", "skills"),
	}
}

func settingsFilePath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "skilltree", "config.json")
}

func loadSettings() AppSettings {
	data, err := os.ReadFile(settingsFilePath())
	if err != nil {
		return defaultSettings()
	}
	def := defaultSettings()
	if err := json.Unmarshal(data, &def); err != nil {
		return defaultSettings()
	}
	// Fill any missing fields with defaults
	d := defaultSettings()
	if def.GlobalSkillsDir == "" {
		def.GlobalSkillsDir = d.GlobalSkillsDir
	}
	if def.LibrarySkillsDir == "" {
		def.LibrarySkillsDir = d.LibrarySkillsDir
	}
	if def.ProjectSkillsRelPath == "" {
		def.ProjectSkillsRelPath = d.ProjectSkillsRelPath
	}
	return def
}

func persistSettings(s AppSettings) error {
	path := settingsFilePath()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

// GetSettings returns the current app settings.
func (a *App) GetSettings() AppSettings {
	return a.settings
}

// SaveSettings persists updated settings and reloads them into the app.
func (a *App) SaveSettings(s AppSettings) error {
	if err := persistSettings(s); err != nil {
		return err
	}
	a.settings = s
	return nil
}

// BrowseForDirectory opens a native directory picker and returns the chosen path.
func (a *App) BrowseForDirectory(title string) (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: title,
	})
}
