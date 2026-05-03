import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { EventsOn, EventsOff } from '../../wailsjs/runtime/runtime'
import {
  StartTerminal,
  TerminalInput,
  TerminalResize,
  IsTerminalRunning,
} from '../../wailsjs/go/main/App'
import './Terminal.css'

interface Props {
  onExit: () => void
}

export interface TerminalHandle {
  getContent: () => string
  scrollToBottom: () => void
  scrollToCursor: () => void
}

export const Terminal = forwardRef<TerminalHandle, Props>(function Terminal({ onExit }, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useImperativeHandle(ref, () => ({
    scrollToBottom() {
      xtermRef.current?.scrollToBottom()
    },
    scrollToCursor() {
      const term = xtermRef.current
      if (!term) return
      const buf = term.buffer.active
      // Cursor's absolute position in the full buffer (including scrollback)
      const cursorAbs = buf.baseY + buf.cursorY
      // Scroll so the cursor appears near the bottom of the viewport
      term.scrollToLine(Math.max(0, cursorAbs - term.rows + 4))
    },
    getContent() {
      const term = xtermRef.current
      if (!term) return ''
      const buf = term.buffer.active
      const lines: string[] = []
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i)
        if (line) lines.push(line.translateToString(true))
      }
      // Trim trailing blank lines
      let end = lines.length
      while (end > 0 && lines[end - 1].trim() === '') end--
      return lines.slice(0, end).join('\n')
    },
  }))

  const handleResize = useCallback(() => {
    if (!fitRef.current || !xtermRef.current) return
    fitRef.current.fit()
    const { cols, rows } = xtermRef.current
    TerminalResize(cols, rows).catch(() => {})
  }, [])

  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      theme: {
        background: '#0a0a0a',
        foreground: '#e0e0e0',
        cursor: '#10b981',
        cursorAccent: '#0a0a0a',
        selectionBackground: 'rgba(16, 185, 129, 0.25)',
        black: '#1a1a1a',
        brightBlack: '#404040',
        red: '#ef4444',
        brightRed: '#f87171',
        green: '#10b981',
        brightGreen: '#34d399',
        yellow: '#f59e0b',
        brightYellow: '#fbbf24',
        blue: '#3b82f6',
        brightBlue: '#60a5fa',
        magenta: '#8b5cf6',
        brightMagenta: '#a78bfa',
        cyan: '#06b6d4',
        brightCyan: '#22d3ee',
        white: '#e0e0e0',
        brightWhite: '#f5f5f5',
      },
      fontFamily: '"SF Mono", "Fira Code", "JetBrains Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()

    xtermRef.current = term
    fitRef.current = fit

    // PTY output from Go — decode base64 to raw bytes so xterm
    // handles UTF-8 sequences correctly instead of as code points
    EventsOn('terminal:output', (b64: string) => {
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
        term.write(bytes)
      } catch {}
    })

    // Process exited
    EventsOn('terminal:exit', () => {
      term.writeln('\r\n\x1b[2m[terminal exited]\x1b[0m')
      onExit()
    })

    // Keyboard → PTY
    term.onData((data) => {
      TerminalInput(btoa(data)).catch(() => {})
    })

    term.onResize(({ cols, rows }) => {
      TerminalResize(cols, rows).catch(() => {})
    })

    // ResizeObserver for when the panel is resized
    const ro = new ResizeObserver(() => handleResize())
    ro.observe(containerRef.current)

    // Fit after one animation frame so the container has its final CSS dimensions,
    // then start Claude with the exact measured cols×rows so its initial layout
    // matches what xterm is actually displaying.
    const raf = requestAnimationFrame(() => {
      fit.fit()
      const { cols, rows } = term
      IsTerminalRunning().then((running) => {
        if (!running) {
          StartTerminal(cols, rows).catch((err: unknown) => {
            term.writeln(`\x1b[31mFailed to start Claude CLI: ${err}\x1b[0m`)
            term.writeln('\x1b[2mMake sure claude-code is installed: npm i -g @anthropic-ai/claude-code\x1b[0m')
          })
        } else {
          // Already running — just sync the size
          TerminalResize(cols, rows).catch(() => {})
        }
      })
    })

    return () => {
      cancelAnimationFrame(raf)
      EventsOff('terminal:output')
      EventsOff('terminal:exit')
      ro.disconnect()
      term.dispose()
    }
  }, [])

  return <div ref={containerRef} className="xterm-container" />
})
