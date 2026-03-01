import { spawn, type ChildProcess, exec, execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import { log } from '../logger.js'
import { childEnv } from '../child-env.js'

const execAsync = promisify(exec)

function resolveIdbPath(): string {
  const mcpIdb = join(homedir(), '.blitz-ios-mcp', 'python', 'bin', 'idb')
  if (existsSync(mcpIdb)) return mcpIdb
  const blitzIdb = join(homedir(), '.blitz', 'python', 'bin', 'idb')
  if (existsSync(blitzIdb)) return blitzIdb
  return 'idb'
}

function resolveCompanionPath(): string | null {
  const mcpCompanion = join(homedir(), '.blitz-ios-mcp', 'idb-companion', 'bin', 'idb_companion')
  if (existsSync(mcpCompanion)) return mcpCompanion
  const blitzCompanion = join(homedir(), '.blitz', 'idb-companion', 'bin', 'idb_companion')
  if (existsSync(blitzCompanion)) return blitzCompanion
  return null
}

const IDB_PATH = resolveIdbPath()
const IDB_COMPANION_PATH = resolveCompanionPath()

export async function resolveBootedUdid(): Promise<string> {
  const { stdout } = await execAsync('xcrun simctl list devices booted -j')
  const data = JSON.parse(stdout)
  for (const runtime of Object.values(data.devices) as { udid: string; state: string }[][]) {
    for (const device of runtime) {
      if (device.state === 'Booted') {
        return device.udid
      }
    }
  }
  throw new Error('No booted simulator found')
}

function parseSimctlAppList(raw: string): { bundleId: string; name: string; type: 'System' | 'User' }[] {
  const apps: { bundleId: string; name: string; type: 'System' | 'User' }[] = []
  const entryRegex = /"([^"]+)"\s*=\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g
  let match
  while ((match = entryRegex.exec(raw)) !== null) {
    const bundleId = match[1]
    const block = match[2]
    const nameMatch = block.match(/CFBundleDisplayName\s*=\s*(?:"([^"]+)"|([^;]+));/)
    const typeMatch = block.match(/ApplicationType\s*=\s*(\w+);/)
    const name = (nameMatch?.[1] ?? nameMatch?.[2] ?? bundleId).trim()
    const type = typeMatch?.[1] === 'User' ? 'User' : 'System'
    apps.push({ bundleId, name, type })
  }
  return apps
}

export class IDBClient {
  private static instances: Map<string, IDBClient> = new Map()
  private udid: string
  private shellProcess: ChildProcess | null = null
  private isShuttingDown = false
  private companionKillAttempts = 0
  private static readonly MAX_COMPANION_KILL_ATTEMPTS = 5

  private constructor(udid: string) {
    this.udid = udid
  }

  private resolvedUdid: string | null = null

  private async getResolvedUdid(): Promise<string> {
    if (this.resolvedUdid) return this.resolvedUdid
    if (this.udid === 'booted') {
      this.resolvedUdid = await resolveBootedUdid()
      log('IDBClient', 'log', `Resolved "booted" -> ${this.resolvedUdid}`)
    } else {
      this.resolvedUdid = this.udid
    }
    return this.resolvedUdid
  }

  static getInstance(udid: string = 'booted'): IDBClient {
    if (!IDBClient.instances.has(udid)) {
      IDBClient.instances.set(udid, new IDBClient(udid))
    }
    return IDBClient.instances.get(udid)!
  }

  private async startShell(): Promise<void> {
    if (this.shellProcess || this.isShuttingDown) return

    log('IDBClient', 'log', `Starting idb shell for ${this.udid}...`)
    const resolvedUdid = await this.getResolvedUdid()

    const args: string[] = []
    if (IDB_COMPANION_PATH) {
      args.push('--companion-path', IDB_COMPANION_PATH)
    }
    args.push('shell', '--no-prompt', '--udid', resolvedUdid)

    log('IDBClient', 'log', `IDB command - ${IDB_PATH} ${args.join(' ')}`)

    const proc = spawn(IDB_PATH, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.shellProcess = proc

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      log('IDBClient', 'log', `[${this.udid}] stderr: ${text.trim()}`)

      if (text.includes('Connection refused')) {
        this.companionKillAttempts++
        if (this.companionKillAttempts > IDBClient.MAX_COMPANION_KILL_ATTEMPTS) {
          log('IDBClient', 'error', `[${this.udid}] Companion connection refused after ${IDBClient.MAX_COMPANION_KILL_ATTEMPTS} attempts`)
          return
        }
        log('IDBClient', 'warn', `[${this.udid}] Companion connection refused (attempt ${this.companionKillAttempts}/${IDBClient.MAX_COMPANION_KILL_ATTEMPTS}) — restarting shell`)
        proc.kill('SIGTERM')
        if (this.shellProcess === proc) this.shellProcess = null
        execAsync(`${IDB_PATH} kill`)
          .catch(e => log('IDBClient', 'log', `[${this.udid}] idb kill error: ${e}`))
          .then(() => new Promise(resolve => setTimeout(resolve, 2000)))
          .then(() => this.startShell())
      }
    })

    proc.on('error', (error) => {
      log('IDBClient', 'error', `[${this.udid}] Shell process error: ${error}`)
      if (this.shellProcess === proc) this.shellProcess = null
    })

    proc.on('exit', (code, signal) => {
      log('IDBClient', 'log', `[${this.udid}] Shell exited code=${code} signal=${signal}`)
      if (this.shellProcess === proc) this.shellProcess = null
    })

    await new Promise(resolve => setTimeout(resolve, 300))
    log('IDBClient', 'log', `idb shell started for ${this.udid}`)
  }

  private async runInShell(args: string): Promise<void> {
    if (this.isShuttingDown) throw new Error('IDB client is shutting down')
    if (!this.shellProcess) await this.startShell()
    if (!this.shellProcess?.stdin) throw new Error('Shell process not available')
    log('IDBClient', 'log', `[${this.udid}] Executing: ${args}`)
    this.shellProcess.stdin.write(args + '\n')
  }

  private async runDirect(args: string): Promise<string> {
    const resolvedUdid = await this.getResolvedUdid()
    const companionArg = IDB_COMPANION_PATH ? `--companion-path ${IDB_COMPANION_PATH}` : ''
    const udidArg = `--udid ${resolvedUdid}`
    const cmd = `${IDB_PATH} ${companionArg} ${args} ${udidArg}`.trim()
    log('IDBClient', 'log', `[${this.udid}] Running direct: ${cmd}`)
    const { stdout, stderr } = await execAsync(cmd)
    if (stderr) log('IDBClient', 'log', `[${this.udid}] stderr: ${stderr}`)
    return stdout.trim()
  }

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return
    log('IDBClient', 'log', `[${this.udid}] Shutting down...`)
    this.isShuttingDown = true

    if (this.shellProcess) {
      this.shellProcess.stdin?.end()
      this.shellProcess.kill('SIGTERM')
      await new Promise(resolve => setTimeout(resolve, 1000))
      if (this.shellProcess && !this.shellProcess.killed) {
        this.shellProcess.kill('SIGKILL')
      }
      this.shellProcess = null
    }

    IDBClient.instances.delete(this.udid)
    log('IDBClient', 'log', `[${this.udid}] Shutdown complete`)
  }

  async tap(x: number, y: number, duration?: number): Promise<void> {
    let args = `ui tap ${x} ${y}`
    if (duration !== undefined) args += ` --duration ${duration}`
    args += ' --json'
    await this.runInShell(args)
  }

  async swipe(fromX: number, fromY: number, toX: number, toY: number, duration?: number, delta?: number): Promise<void> {
    let args = `ui swipe ${fromX} ${fromY} ${toX} ${toY}`
    if (duration !== undefined) args += ` --duration ${duration}`
    if (delta !== undefined) args += ` --delta ${delta}`
    args += ' --json'
    await this.runInShell(args)
  }

  async pressButton(button: 'HOME' | 'LOCK' | 'SIDE_BUTTON' | 'APPLE_PAY' | 'SIRI', duration?: number): Promise<void> {
    let args = `ui button ${button}`
    if (duration !== undefined) args += ` --duration ${duration}`
    args += ' --json'
    await this.runInShell(args)
  }

  async inputText(text: string): Promise<void> {
    await this.runInShell(`ui text ${JSON.stringify(text)} --json`)
  }

  async pressKey(key: number | string, duration?: number): Promise<void> {
    if (typeof key === 'string') {
      await this.inputText(key)
      return
    }
    let args = `ui key ${key}`
    if (duration !== undefined) args += ` --duration ${duration}`
    args += ' --json'
    await this.runInShell(args)
  }

  async pressKeySequence(keySequence: (number | string)[]): Promise<void> {
    const keys = keySequence.join(' ')
    await this.runInShell(`ui key-sequence ${keys} --json`)
  }

  async describeAll(nested?: boolean): Promise<unknown> {
    let args = 'ui describe-all --json'
    if (nested) args += ' --nested'

    let output = ''
    try {
      output = await this.runDirect(args)
      const jsonMatch = output.match(/[{[][\s\S]*[}\]]/)
      if (jsonMatch) return JSON.parse(jsonMatch[0])
      return JSON.parse(output)
    } catch (error) {
      throw new Error(`Failed to parse UI description. Raw output: ${output.substring(0, 300)}`)
    }
  }

  async describePoint(x: number, y: number, nested?: boolean): Promise<unknown> {
    let args = `ui describe-point ${Math.round(x)} ${Math.round(y)} --json`
    if (nested) args += ' --nested'

    let output = ''
    try {
      output = await this.runDirect(args)
      const jsonMatch = output.match(/[{[][\s\S]*[}\]]/)
      if (jsonMatch) return JSON.parse(jsonMatch[0])
      return JSON.parse(output)
    } catch (error) {
      throw new Error(`Failed to parse UI description at point (${x}, ${y}). Raw output: ${output.substring(0, 300)}`)
    }
  }

  async screenshot(): Promise<Buffer> {
    const resolvedUdid = await this.getResolvedUdid()
    const filePath = join(tmpdir(), `blitz-idb-screenshot-${Date.now()}.png`)
    const execFileAsync = promisify(execFile)
    await execFileAsync('xcrun', ['simctl', 'io', resolvedUdid, 'screenshot', '--type=png', filePath], {
      env: childEnv(),
      timeout: 10000,
    })
    const { readFile, unlink } = await import('fs/promises')
    const buffer = await readFile(filePath)
    await unlink(filePath).catch(() => {})
    return buffer
  }

  async listApps(): Promise<{ bundleId: string; name: string; type: 'System' | 'User' }[]> {
    const resolvedUdid = await this.getResolvedUdid()
    const { stdout } = await execAsync(`xcrun simctl listapps ${resolvedUdid}`)
    return parseSimctlAppList(stdout)
  }

  async launch(bundleId: string): Promise<void> {
    const resolvedUdid = await this.getResolvedUdid()
    await execAsync(`xcrun simctl launch ${resolvedUdid} ${bundleId}`)
  }
}

export function getIDBClient(udid: string = 'booted'): IDBClient {
  return IDBClient.getInstance(udid)
}

let isCleaningUp = false

async function cleanupAllInstances(): Promise<void> {
  if (isCleaningUp) return
  isCleaningUp = true
  const instances = Array.from((IDBClient as unknown as { instances: Map<string, IDBClient> }).instances.values())
  if (instances.length > 0) {
    log('IDBClient', 'log', `Cleaning up ${instances.length} IDB client instance(s)...`)
    await Promise.all(instances.map(instance => instance.shutdown()))
    log('IDBClient', 'log', 'All IDB client instances cleaned up')
  }
}

process.on('SIGINT', () => {
  cleanupAllInstances().then(() => process.exit(0)).catch(() => process.exit(1))
})

process.on('SIGTERM', () => {
  cleanupAllInstances().then(() => process.exit(0)).catch(() => process.exit(1))
})

export async function shutdownAllIDBClients(): Promise<void> {
  await cleanupAllInstances()
}
