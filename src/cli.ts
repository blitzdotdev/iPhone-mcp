#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { exec, execSync } from 'child_process'
import { promisify } from 'util'
import { createInterface } from 'readline'
import checkbox from '@inquirer/checkbox'
import { log } from './logger.js'

const execAsync = promisify(exec)

const VERSION = '0.1.0'

function printUsage(): void {
  process.stderr.write(`
@blitzdev/ios-mcp v${VERSION}

Usage:
  npx @blitzdev/ios-mcp              Start the MCP server (stdio)
  npx @blitzdev/ios-mcp --setup-all  Install deps + configure globally (Claude Code, Cursor, Codex)
  npx @blitzdev/ios-mcp --setup-here Install deps + configure for current directory
  npx @blitzdev/ios-mcp --setup      Interactive setup (prompts for scope)
  npx @blitzdev/ios-mcp --version    Print version
  npx @blitzdev/ios-mcp --help       Show this help
`)
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  return new Promise(resolve => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function runSetup(scope?: 'all' | 'here'): Promise<void> {
  const mcpHome = join(homedir(), '.blitz-ios-mcp')
  const blitzHome = join(homedir(), '.blitz')

  // Steps 1-5: Check/install dependencies (silent when everything is OK)
  try {
    execSync('xcode-select -p', { stdio: 'pipe' })
  } catch {
    process.stderr.write('\n  Xcode is required. Install from the App Store or run:\n')
    process.stderr.write('    xcode-select --install\n\n')
    process.exit(1)
  }

  try {
    execSync('which brew', { stdio: 'pipe' })
  } catch {
    process.stderr.write('\n  Homebrew is required. Install from https://brew.sh\n\n')
    process.exit(1)
  }

  const mcpIdb = join(mcpHome, 'python', 'bin', 'idb')
  const blitzIdb = join(blitzHome, 'python', 'bin', 'idb')
  if (existsSync(mcpIdb)) {
    // already installed
  } else if (existsSync(blitzIdb)) {
    mkdirSync(join(mcpHome, 'python', 'bin'), { recursive: true })
    try {
      symlinkSync(join(blitzHome, 'python'), join(mcpHome, 'python'), 'junction')
    } catch {
      symlinkSync(blitzIdb, mcpIdb)
    }
    const blitzCompanion = join(blitzHome, 'idb-companion')
    if (existsSync(blitzCompanion) && !existsSync(join(mcpHome, 'idb-companion'))) {
      try { symlinkSync(blitzCompanion, join(mcpHome, 'idb-companion'), 'junction') } catch { /* ignore */ }
    }
  } else {
    process.stderr.write('\n  Installing idb (this may take a few minutes)...\n')
    mkdirSync(join(mcpHome, 'python'), { recursive: true })
    mkdirSync(join(mcpHome, 'idb-companion'), { recursive: true })
    try {
      process.stderr.write('    Installing idb_companion via Homebrew...\n')
      await execAsync('brew tap facebook/fb && brew install idb-companion', { timeout: 300_000 })
      process.stderr.write('    Installing fb-idb via pip...\n')
      await execAsync(`python3 -m venv "${join(mcpHome, 'python')}" && "${join(mcpHome, 'python', 'bin', 'pip')}" install fb-idb`, { timeout: 300_000 })
      process.stderr.write('    idb installed successfully\n')
    } catch (e) {
      process.stderr.write(`    Warning: idb installation failed: ${(e as Error).message}\n`)
      process.stderr.write('    You can install manually: brew install idb-companion && pip install fb-idb\n')
    }
  }

  const wdaPath = join(mcpHome, 'wda-build', 'WebDriverAgent')
  const blitzWda = join(blitzHome, 'wda-build', 'WebDriverAgent')
  if (existsSync(join(wdaPath, 'WebDriverAgent.xcodeproj'))) {
    // already installed
  } else if (existsSync(join(blitzWda, 'WebDriverAgent.xcodeproj'))) {
    mkdirSync(join(mcpHome, 'wda-build'), { recursive: true })
    try { symlinkSync(blitzWda, wdaPath) } catch { /* ignore */ }
  } else {
    process.stderr.write('  Cloning WebDriverAgent...\n')
    mkdirSync(join(mcpHome, 'wda-build'), { recursive: true })
    try {
      await execAsync(`git clone --depth 1 https://github.com/appium/WebDriverAgent.git "${wdaPath}"`, { timeout: 120_000 })
    } catch (e) {
      process.stderr.write(`    Warning: WDA clone failed: ${(e as Error).message}\n`)
      process.stderr.write('    Physical device support requires WDA. You can clone manually.\n')
    }
  }

  const mcpAxScan = join(mcpHome, 'bin', 'ax-scan')
  const blitzAxScan = join(blitzHome, 'bin', 'ax-scan')
  if (existsSync(mcpAxScan)) {
    // already installed
  } else if (existsSync(blitzAxScan)) {
    mkdirSync(join(mcpHome, 'bin'), { recursive: true })
    try { symlinkSync(blitzAxScan, mcpAxScan) } catch { /* ignore */ }
  } else {
    try {
      const axScanDir = join(import.meta.dirname, 'idb', 'ax-scan')
      if (!existsSync(join(axScanDir, 'Makefile'))) {
        const distAxScanDir = join(import.meta.dirname, '..', 'src', 'idb', 'ax-scan')
        if (existsSync(join(distAxScanDir, 'Makefile'))) {
          await execAsync(`make -C "${distAxScanDir}" install INSTALL_DIR="${join(mcpHome, 'bin')}"`, { timeout: 60_000 })
        }
      } else {
        await execAsync(`make -C "${axScanDir}" install INSTALL_DIR="${join(mcpHome, 'bin')}"`, { timeout: 60_000 })
      }
    } catch { /* silent fallback */ }
  }

  // Configure MCP clients
  const configured: string[] = []

  if (scope === 'all') {
    // Global: always configure Claude Code, silently try Cursor and Codex if their dirs exist
    configured.push(...writeClaudeCodeConfig(join(homedir(), '.claude.json')))
    if (existsSync(join(homedir(), '.cursor'))) {
      configured.push(...writeCursorConfig(join(homedir(), '.cursor', 'mcp.json')))
    }
    if (existsSync(join(homedir(), '.codex'))) {
      configured.push(...writeCodexConfig(join(homedir(), '.codex', 'config.toml')))
    }
  } else if (scope === 'here') {
    // Project-scoped: checkbox prompt for which clients to configure
    const choices = await checkbox<string>(
      {
        message: 'Which AI agents should have access to @blitzdev/ios-mcp?',
        choices: [
          { name: 'Claude Code', value: 'claude-code', checked: true },
          { name: 'Cursor', value: 'cursor' },
          { name: 'Codex', value: 'codex' },
        ],
      },
      { output: process.stderr },
    )

    if (choices.includes('claude-code')) {
      configured.push(...writeClaudeCodeConfig(join(process.cwd(), '.mcp.json')))
    }
    if (choices.includes('cursor')) {
      mkdirSync(join(process.cwd(), '.cursor'), { recursive: true })
      configured.push(...writeCursorConfig(join(process.cwd(), '.cursor', 'mcp.json')))
    }
    if (choices.includes('codex')) {
      mkdirSync(join(process.cwd(), '.codex'), { recursive: true })
      configured.push(...writeCodexConfig(join(process.cwd(), '.codex', 'config.toml')))
    }
  } else {
    // Interactive --setup: ask scope first, then configure
    const answer = await prompt('\n  Install MCP config:\n    1. System-wide (all projects) [recommended]\n    2. Current directory only\n  Choose (1/2): ')
    if (answer === '2') {
      configured.push(...writeClaudeCodeConfig(join(process.cwd(), '.mcp.json')))
    } else {
      configured.push(...writeClaudeCodeConfig(join(homedir(), '.claude.json')))
      if (existsSync(join(homedir(), '.cursor'))) {
        configured.push(...writeCursorConfig(join(homedir(), '.cursor', 'mcp.json')))
      }
      if (existsSync(join(homedir(), '.codex'))) {
        configured.push(...writeCodexConfig(join(homedir(), '.codex', 'config.toml')))
      }
    }
  }

  if (configured.length > 0) {
    process.stderr.write(`\n  Configured: ${configured.join(', ')}\n`)
  }
  process.stderr.write('\n  Setup complete! Restart your AI agent to activate.\n\n')
}

function writeJsonMcpConfig(configPath: string): boolean {
  const mcpServers = {
    'blitz-ios': {
      command: 'npx',
      args: ['@blitzdev/ios-mcp'],
    },
  }

  try {
    let existing: Record<string, unknown> = {}
    if (existsSync(configPath)) {
      existing = JSON.parse(readFileSync(configPath, 'utf8'))
    }
    const merged = {
      ...existing,
      mcpServers: {
        ...(existing.mcpServers as Record<string, unknown> ?? {}),
        ...mcpServers,
      },
    }
    writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n')
    process.stderr.write(`    Written: ${configPath}\n`)
    return true
  } catch (e) {
    process.stderr.write(`    Warning: Could not write ${configPath}: ${(e as Error).message}\n`)
    return false
  }
}

function writeClaudeCodeConfig(configPath: string): string[] {
  return writeJsonMcpConfig(configPath) ? ['Claude Code'] : []
}

function writeCursorConfig(configPath: string): string[] {
  return writeJsonMcpConfig(configPath) ? ['Cursor'] : []
}

function writeCodexConfig(configPath: string): string[] {
  const tomlBlock = `\n[mcp_servers.blitz-ios]\ncommand = "npx"\nargs = ["@blitzdev/ios-mcp"]\n`

  try {
    let existing = ''
    if (existsSync(configPath)) {
      existing = readFileSync(configPath, 'utf8')
    }
    if (existing.includes('[mcp_servers.blitz-ios]')) {
      process.stderr.write(`    Codex config already has blitz-ios, skipping\n`)
      return ['Codex']
    }
    writeFileSync(configPath, existing + tomlBlock)
    process.stderr.write(`    Written: ${configPath}\n`)
    return ['Codex']
  } catch (e) {
    process.stderr.write(`    Warning: Could not write ${configPath}: ${(e as Error).message}\n`)
    return []
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    printUsage()
    process.exit(0)
  }

  if (args.includes('--version') || args.includes('-v')) {
    process.stderr.write(`@blitzdev/ios-mcp v${VERSION}\n`)
    process.exit(0)
  }

  if (args.includes('--setup-all')) {
    await runSetup('all')
    process.exit(0)
  }

  if (args.includes('--setup-here')) {
    await runSetup('here')
    process.exit(0)
  }

  if (args.includes('--setup')) {
    await runSetup()
    process.exit(0)
  }

  // Default: start MCP server
  const { startServer } = await import('./index.js')
  await startServer()
}

main().catch(e => {
  log('CLI', 'error', `Fatal error: ${e}`)
  process.exit(1)
})
