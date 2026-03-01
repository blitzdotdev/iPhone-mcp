#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { exec, execSync } from 'child_process'
import { promisify } from 'util'
import { createInterface } from 'readline'
import { log } from './logger.js'

const execAsync = promisify(exec)

const VERSION = '0.1.0'

function printUsage(): void {
  process.stderr.write(`
blitz-ios-mcp v${VERSION}

Usage:
  blitz-ios-mcp              Start the MCP server (stdio)
  blitz-ios-mcp --setup-all  Install deps + configure globally (Claude Code, Cursor, Codex)
  blitz-ios-mcp --setup-here Install deps + configure for current directory
  blitz-ios-mcp --setup      Interactive setup (prompts for scope)
  blitz-ios-mcp --version    Print version
  blitz-ios-mcp --help       Show this help
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

  process.stderr.write('\n  blitz-ios-mcp setup\n\n')

  // Step 1: Check Xcode
  process.stderr.write('  [1/6] Checking Xcode... ')
  try {
    execSync('xcode-select -p', { stdio: 'pipe' })
    process.stderr.write('OK\n')
  } catch {
    process.stderr.write('MISSING\n\n')
    process.stderr.write('  Xcode is required. Install from the App Store or run:\n')
    process.stderr.write('    xcode-select --install\n\n')
    process.exit(1)
  }

  // Step 2: Check Homebrew
  process.stderr.write('  [2/6] Checking Homebrew... ')
  try {
    execSync('which brew', { stdio: 'pipe' })
    process.stderr.write('OK\n')
  } catch {
    process.stderr.write('MISSING\n\n')
    process.stderr.write('  Homebrew is required. Install from https://brew.sh\n\n')
    process.exit(1)
  }

  // Step 3: Install idb
  process.stderr.write('  [3/6] Checking idb... ')
  const mcpIdb = join(mcpHome, 'python', 'bin', 'idb')
  const blitzIdb = join(blitzHome, 'python', 'bin', 'idb')
  if (existsSync(mcpIdb)) {
    process.stderr.write('OK (blitz-ios-mcp)\n')
  } else if (existsSync(blitzIdb)) {
    process.stderr.write('found in ~/.blitz, symlinking... ')
    mkdirSync(join(mcpHome, 'python', 'bin'), { recursive: true })
    try {
      symlinkSync(join(blitzHome, 'python'), join(mcpHome, 'python'), 'junction')
    } catch {
      // Symlink may already exist partially, copy bin
      symlinkSync(blitzIdb, mcpIdb)
    }
    // Also symlink idb-companion if available
    const blitzCompanion = join(blitzHome, 'idb-companion')
    if (existsSync(blitzCompanion) && !existsSync(join(mcpHome, 'idb-companion'))) {
      try { symlinkSync(blitzCompanion, join(mcpHome, 'idb-companion'), 'junction') } catch { /* ignore */ }
    }
    process.stderr.write('OK\n')
  } else {
    process.stderr.write('not found\n')
    process.stderr.write('  Installing idb (this may take a few minutes)...\n')

    mkdirSync(join(mcpHome, 'python'), { recursive: true })
    mkdirSync(join(mcpHome, 'idb-companion'), { recursive: true })

    try {
      // Install idb_companion via Homebrew
      process.stderr.write('    Installing idb_companion via Homebrew...\n')
      await execAsync('brew tap facebook/fb && brew install idb-companion', { timeout: 300_000 })

      // Install fb-idb via pip
      process.stderr.write('    Installing fb-idb via pip...\n')
      await execAsync(`python3 -m venv "${join(mcpHome, 'python')}" && "${join(mcpHome, 'python', 'bin', 'pip')}" install fb-idb`, { timeout: 300_000 })

      process.stderr.write('    idb installed successfully\n')
    } catch (e) {
      process.stderr.write(`    Warning: idb installation failed: ${(e as Error).message}\n`)
      process.stderr.write('    You can install manually: brew install idb-companion && pip install fb-idb\n')
    }
  }

  // Step 4: Clone WDA
  process.stderr.write('  [4/6] Checking WebDriverAgent... ')
  const wdaPath = join(mcpHome, 'wda-build', 'WebDriverAgent')
  const blitzWda = join(blitzHome, 'wda-build', 'WebDriverAgent')
  if (existsSync(join(wdaPath, 'WebDriverAgent.xcodeproj'))) {
    process.stderr.write('OK\n')
  } else if (existsSync(join(blitzWda, 'WebDriverAgent.xcodeproj'))) {
    process.stderr.write('found in ~/.blitz, symlinking... ')
    mkdirSync(join(mcpHome, 'wda-build'), { recursive: true })
    try { symlinkSync(blitzWda, wdaPath) } catch { /* ignore */ }
    process.stderr.write('OK\n')
  } else {
    process.stderr.write('not found, cloning...\n')
    mkdirSync(join(mcpHome, 'wda-build'), { recursive: true })
    try {
      await execAsync(`git clone --depth 1 https://github.com/appium/WebDriverAgent.git "${wdaPath}"`, { timeout: 120_000 })
      process.stderr.write('    WebDriverAgent cloned successfully\n')
    } catch (e) {
      process.stderr.write(`    Warning: WDA clone failed: ${(e as Error).message}\n`)
      process.stderr.write('    Physical device support requires WDA. You can clone manually.\n')
    }
  }

  // Step 5: Build ax-scan (optional)
  process.stderr.write('  [5/6] Checking ax-scan... ')
  const mcpAxScan = join(mcpHome, 'bin', 'ax-scan')
  const blitzAxScan = join(blitzHome, 'bin', 'ax-scan')
  if (existsSync(mcpAxScan)) {
    process.stderr.write('OK\n')
  } else if (existsSync(blitzAxScan)) {
    process.stderr.write('found in ~/.blitz, symlinking... ')
    mkdirSync(join(mcpHome, 'bin'), { recursive: true })
    try { symlinkSync(blitzAxScan, mcpAxScan) } catch { /* ignore */ }
    process.stderr.write('OK\n')
  } else {
    process.stderr.write('not found, attempting build...\n')
    try {
      const axScanDir = join(import.meta.dirname, 'idb', 'ax-scan')
      if (!existsSync(join(axScanDir, 'Makefile'))) {
        // In dist, look relative to dist dir
        const distAxScanDir = join(import.meta.dirname, '..', 'src', 'idb', 'ax-scan')
        if (existsSync(join(distAxScanDir, 'Makefile'))) {
          await execAsync(`make -C "${distAxScanDir}" install INSTALL_DIR="${join(mcpHome, 'bin')}"`, { timeout: 60_000 })
          process.stderr.write('    ax-scan built successfully\n')
        } else {
          throw new Error('Makefile not found')
        }
      } else {
        await execAsync(`make -C "${axScanDir}" install INSTALL_DIR="${join(mcpHome, 'bin')}"`, { timeout: 60_000 })
        process.stderr.write('    ax-scan built successfully\n')
      }
    } catch (e) {
      process.stderr.write(`    Warning: ax-scan build failed (will use fallback): ${(e as Error).message}\n`)
    }
  }

  // Step 6: Configure MCP clients
  process.stderr.write('  [6/6] MCP configuration\n')

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
    // Project-scoped: ask which clients to configure
    process.stderr.write('\n  Which AI agents should have access to blitz-ios-mcp in this project?\n')
    process.stderr.write('    1. Claude Code (.mcp.json)\n')
    process.stderr.write('    2. Cursor (.cursor/mcp.json)\n')
    process.stderr.write('    3. Codex (.codex/config.toml)\n')
    const answer = await prompt('  Enter choices (e.g. 1,2,3): ')
    const choices = answer.split(/[,\s]+/).map(s => s.trim())

    if (choices.includes('1') || choices.length === 0) {
      configured.push(...writeClaudeCodeConfig(join(process.cwd(), '.mcp.json')))
    }
    if (choices.includes('2')) {
      mkdirSync(join(process.cwd(), '.cursor'), { recursive: true })
      configured.push(...writeCursorConfig(join(process.cwd(), '.cursor', 'mcp.json')))
    }
    if (choices.includes('3')) {
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
      args: ['blitz-ios-mcp'],
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
  const tomlBlock = `\n[mcp_servers.blitz-ios]\ncommand = "npx"\nargs = ["blitz-ios-mcp"]\n`

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
    process.stderr.write(`blitz-ios-mcp v${VERSION}\n`)
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
