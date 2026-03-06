import { spawn, type ChildProcess, exec } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { log } from '../logger.js'
import { childEnv } from '../child-env.js'
import { WDAClient } from './wda-client.js'

const execAsync = promisify(exec)

export type WDASetupStep =
  | 'connecting'
  | 'building_wda'
  | 'installing_wda'
  | 'establishing_connection'
  | 'ready'

export interface WDASetupProgress {
  step: WDASetupStep
  message: string
  error?: string
}

type ProgressCallback = (progress: WDASetupProgress) => void

const SETUP_TIMEOUT_ERROR = `Setup timed out. Please check:

1. iPhone is unlocked — keep it unlocked for the entire setup process.

2. Developer Mode is enabled — on your iPhone: Settings → Privacy & Security → Developer Mode.

3. Same private network — your iPhone and Mac must be on the same home or office WiFi. Public WiFi (airports, hotels, cafes) isolates devices from each other and will block this.
   To verify: on your iPhone go to Settings → WiFi → tap your network name → note the IP Address. On your Mac go to System Settings → Network → WiFi → Details → IP Address. Both should start with the same numbers (e.g., both 192.168.1.x = same network ✓). If they differ, use a personal hotspot or plug in via USB.

For the most reliable setup, connect your iPhone via USB.`

export class WDAManager {
  private static instance: WDAManager | null = null
  private wdaProcesses: Map<string, ChildProcess> = new Map()

  static getInstance(): WDAManager {
    if (!WDAManager.instance) {
      WDAManager.instance = new WDAManager()
    }
    return WDAManager.instance
  }

  getWdaProjectPathOrNull(): string | null {
    try { return this.getWdaProjectPath() } catch { return null }
  }

  getDerivedDataPathPublic(): string {
    return this.getDerivedDataPath()
  }

  async detectTeamIdPublic(): Promise<string> {
    return this.detectTeamId()
  }

  getClient(udid: string, tunnelIP: string, port: number = 8100): WDAClient {
    return WDAClient.getInstance(udid, port, tunnelIP)
  }

  private getWdaProjectPath(): string {
    const mcpPath = join(homedir(), '.blitz-iphone-mcp', 'wda-build', 'WebDriverAgent')
    if (existsSync(join(mcpPath, 'WebDriverAgent.xcodeproj'))) return mcpPath

    const blitzPath = join(homedir(), '.blitz', 'wda-build', 'WebDriverAgent')
    if (existsSync(join(blitzPath, 'WebDriverAgent.xcodeproj'))) return blitzPath

    throw new Error('WebDriverAgent not found. Run `npx @blitzdev/iphone-mcp --setup` to install it.')
  }

  private async ensureWdaSource(): Promise<string> {
    try {
      return this.getWdaProjectPath()
    } catch {
      const targetDir = join(homedir(), '.blitz-iphone-mcp', 'wda-build')
      mkdirSync(targetDir, { recursive: true })
      const wdaDir = join(targetDir, 'WebDriverAgent')

      log('WDAManager', 'log', 'Cloning WebDriverAgent from GitHub...')
      await execAsync(
        `git clone --depth 1 https://github.com/appium/WebDriverAgent.git "${wdaDir}"`,
        { timeout: 120_000, env: childEnv() }
      )
      log('WDAManager', 'log', 'WebDriverAgent cloned successfully')
      return wdaDir
    }
  }

  private getDerivedDataPath(): string {
    const dir = join(homedir(), '.blitz-iphone-mcp', 'wda-build')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  private async preTriggerCodesignDialog(teamId: string): Promise<void> {
    try {
      const { stdout } = await execAsync(
        `security find-identity -v -p codesigning | grep "Apple Development" | grep "${teamId}" | head -1`,
        { env: childEnv() }
      )
      const match = stdout.match(/"(.+?)"/)
      if (!match) return

      const identity = match[1]
      const tmpBin = `/tmp/blitz_codesign_preflight_${Date.now()}`
      await execAsync(`cp /bin/ls "${tmpBin}"`, { env: childEnv() })
      try {
        // This triggers the macOS keychain dialog for the signing cert.
        // User must click "Always Allow" — give them 20s to respond.
        await execAsync(`codesign -f -s "${identity}" "${tmpBin}"`, { timeout: 20_000, env: childEnv() })
      } catch {
        // Dismissed or denied — non-fatal, xcodebuild will prompt again or fail with a clear error
      } finally {
        await execAsync(`rm -f "${tmpBin}"`, { env: childEnv() }).catch(() => {})
      }
    } catch {
      // Non-fatal — proceed with build regardless
    }
  }

  private async detectTeamId(): Promise<string> {
    // Try both keys: older Xcode uses IDEProvisioningTeams, newer versions use IDEProvisioningTeamByIdentifier
    for (const key of ['IDEProvisioningTeams', 'IDEProvisioningTeamByIdentifier']) {
      try {
        const { stdout } = await execAsync(`defaults read com.apple.dt.Xcode ${key}`, { env: childEnv() })
        const match = stdout.match(/teamID\s*=\s*([A-Z0-9]{10})/)
        if (match) return match[1]
      } catch {
        // Key not available, try next
      }
    }
    throw new Error('No development team found. Sign in to Xcode with your Apple ID first (Xcode -> Settings -> Accounts).')
  }

  async getTunnelAddress(udid: string): Promise<string> {
    try {
      const { stdout } = await execAsync('xcrun devicectl list devices --json-output /dev/stdout 2>/dev/null', { env: childEnv() })
      const jsonStart = stdout.indexOf('{')
      if (jsonStart < 0) throw new Error('No JSON in devicectl output')
      const json = JSON.parse(stdout.substring(jsonStart))
      const devices = json?.result?.devices ?? []

      for (const d of devices) {
        const devUdid = d.hardwareProperties?.udid
        if (devUdid !== udid) continue
        const tunnelIP = d.connectionProperties?.tunnelIPAddress
        if (tunnelIP) {
          log('WDAManager', 'log', `Tunnel IP for ${udid}: ${tunnelIP}`)
          return tunnelIP
        }
      }
    } catch (e) {
      log('WDAManager', 'error', `Failed to get tunnel address: ${(e as Error).message}`)
    }
    throw new Error('No CoreDevice tunnel found. Ensure iPhone is connected via USB and trusted.')
  }

  async isWDARunning(udid: string, port: number = 8100): Promise<boolean> {
    try {
      const tunnelIP = await this.getTunnelAddress(udid)
      const client = WDAClient.getInstance(udid, port, tunnelIP)
      return client.isReachable()
    } catch {
      return false
    }
  }

  async setupDevice(
    udid: string,
    onProgress?: ProgressCallback,
    port: number = 8100,
  ): Promise<WDAClient> {
    const report = (step: WDASetupStep, message: string) => {
      log('WDAManager', 'log', `[${udid}] ${step}: ${message}`)
      onProgress?.({ step, message })
    }

    report('connecting', 'Verifying device connection...')
    await this.verifyDeviceConnected(udid)
    report('connecting', 'Device connected.')

    if (await this.isWDARunning(udid, port)) {
      report('establishing_connection', 'WDA already running, creating session...')
      const tunnelIP = await this.getTunnelAddress(udid)
      const client = WDAClient.getInstance(udid, port, tunnelIP)
      await client.createSession()
      report('ready', 'Connected to device.')
      return client
    }

    report('building_wda', 'Building WebDriverAgent (this takes 3-5 min on first run). Watch your Mac screen — macOS will show a keychain dialog asking codesign to access your signing certificate. Click "Always Allow" when prompted.')
    let buildElapsed = 0
    const heartbeat = setInterval(() => {
      buildElapsed += 30
      report('building_wda', `Still building... (${buildElapsed}s elapsed)`)
    }, 30_000)
    try {
      await this.buildWDA(udid)
    } finally {
      clearInterval(heartbeat)
    }
    report('building_wda', 'Build complete.')

    report('installing_wda', 'Installing WebDriverAgent on device. Keep your iPhone unlocked — the app cannot install or launch on a locked screen.')

    let installElapsed = 0
    const installHeartbeat = setInterval(() => {
      installElapsed += 30
      report('installing_wda', `Still installing... (${installElapsed}s elapsed)`)
    }, 30_000)

    const connectTimeoutMs = 10 * 60 * 1000
    const connectTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(SETUP_TIMEOUT_ERROR)), connectTimeoutMs)
    )

    const connect = async () => {
      try {
        await this.launchWDA(udid)
        report('installing_wda', 'WebDriverAgent launched.')

        report('establishing_connection', 'Waiting for WebDriverAgent...')
        const tunnelIP = await this.getTunnelAddress(udid)
        await this.waitForWDA(udid, port, tunnelIP)

        const client = WDAClient.getInstance(udid, port, tunnelIP)
        await client.createSession()
        report('ready', 'Connected to device.')
        return client
      } finally {
        clearInterval(installHeartbeat)
      }
    }

    return Promise.race([connect(), connectTimeout])
  }

  async quickConnect(
    udid: string,
    onProgress?: ProgressCallback,
    port: number = 8100,
  ): Promise<WDAClient> {
    const report = (step: WDASetupStep, message: string) => {
      log('WDAManager', 'log', `[${udid}] ${step}: ${message}`)
      onProgress?.({ step, message })
    }

    report('establishing_connection', 'Connecting to WebDriverAgent...')
    const tunnelIP = await this.getTunnelAddress(udid)
    await this.waitForWDA(udid, port, tunnelIP)
    const client = WDAClient.getInstance(udid, port, tunnelIP)
    await client.createSession()
    report('ready', 'Connected to device.')
    return client
  }

  private async verifyDeviceConnected(udid: string): Promise<void> {
    try {
      const { stdout } = await execAsync('xcrun devicectl list devices --json-output /dev/stdout 2>/dev/null', { env: childEnv() })
      const jsonStart = stdout.indexOf('{')
      if (jsonStart < 0) throw new Error(`Device ${udid} not found. Connect your iPhone via USB.`)
      const json = JSON.parse(stdout.substring(jsonStart))
      const devices = json?.result?.devices ?? []
      const found = devices.some((d: { hardwareProperties?: { udid?: string }; identifier?: string }) =>
        d.hardwareProperties?.udid === udid || d.identifier === udid
      )
      if (!found) throw new Error(`Device ${udid} not found. Connect your iPhone via USB.`)
    } catch (e) {
      if ((e as Error).message.includes('not found')) throw e
      throw new Error(`Failed to verify device connection: ${(e as Error).message}`)
    }
  }

  private async buildWDA(udid: string): Promise<void> {
    const wdaPath = await this.ensureWdaSource()
    const derivedData = this.getDerivedDataPath()
    const teamId = await this.detectTeamId()

    // Pre-trigger the macOS keychain dialog so it appears before the long build.
    // The user must click "Always Allow" — if they miss it, xcodebuild will fail with code 70.
    await this.preTriggerCodesignDialog(teamId)

    const args = [
      'build-for-testing',
      '-project', join(wdaPath, 'WebDriverAgent.xcodeproj'),
      '-scheme', 'WebDriverAgentRunner',
      '-destination', 'generic/platform=iOS',
      '-derivedDataPath', derivedData,
      '-allowProvisioningUpdates',
      `DEVELOPMENT_TEAM=${teamId}`,
    ]

    log('WDAManager', 'log', `Building WDA: xcodebuild ${args.join(' ')}`)

    return new Promise<void>((resolve, reject) => {
      const proc = spawn('xcodebuild', args, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv() })
      let stderr = ''
      let settled = false

      const buildTimeout = setTimeout(() => {
        if (settled) return
        settled = true
        proc.kill('SIGTERM')
        reject(new Error(SETUP_TIMEOUT_ERROR))
      }, 10 * 60 * 1000)

      proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })

      proc.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(buildTimeout)
        if (code === 0) {
          log('WDAManager', 'log', 'WDA build succeeded')
          resolve()
        } else {
          log('WDAManager', 'error', `WDA build failed (code ${code}): ${stderr.slice(-500)}`)
          if (stderr.includes('Developer Mode')) {
            reject(new Error('Enable Developer Mode on your iPhone: Settings -> Privacy & Security -> Developer Mode'))
          } else if (stderr.includes('provisioning')) {
            reject(new Error('Provisioning error. Ensure your Apple ID is signed into Xcode.'))
          } else if (stderr.includes('Trust This Computer')) {
            reject(new Error('Tap "Trust This Computer" on your iPhone.'))
          } else if (code === 70) {
            reject(new Error('WDA build failed (code 70): macOS blocked codesign access to your signing certificate. A keychain dialog may have appeared and been missed or denied. Try setup_device again and click "Always Allow" when macOS asks codesign to access your keychain.'))
          } else {
            reject(new Error(`WDA build failed with code ${code}`))
          }
        }
      })

      proc.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(buildTimeout)
        reject(new Error(`Failed to start xcodebuild: ${err.message}`))
      })
    })
  }

  private async launchWDA(udid: string): Promise<void> {
    const existing = this.wdaProcesses.get(udid)
    if (existing) {
      existing.kill('SIGTERM')
      this.wdaProcesses.delete(udid)
    }

    const wdaPath = this.getWdaProjectPath()
    const derivedData = this.getDerivedDataPath()

    const args = [
      'test-without-building',
      '-project', join(wdaPath, 'WebDriverAgent.xcodeproj'),
      '-scheme', 'WebDriverAgentRunner',
      '-destination', `id=${udid}`,
      '-derivedDataPath', derivedData,
    ]

    log('WDAManager', 'log', `Launching WDA: xcodebuild ${args.join(' ')}`)

    const proc = spawn('xcodebuild', args, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv() })
    this.wdaProcesses.set(udid, proc)

    // Wait until WDA signals it's ready rather than sleeping a fixed 3s.
    // The connectTimeout in setupDevice handles the overall deadline.
    return new Promise<void>((resolve, reject) => {
      let resolved = false

      const onData = (data: Buffer) => {
        if (resolved) return
        if (data.toString().includes('ServerURLHere')) {
          resolved = true
          log('WDAManager', 'log', `WDA server started on device ${udid}`)
          resolve()
        }
      }

      proc.stdout?.on('data', onData)
      proc.stderr?.on('data', onData)

      proc.on('exit', (code, signal) => {
        log('WDAManager', 'log', `WDA process exited for ${udid}: code=${code} signal=${signal}`)
        this.wdaProcesses.delete(udid)
        if (!resolved) reject(new Error(`WDA process exited before starting (code=${code} signal=${signal})`))
      })

      proc.on('error', (err) => {
        log('WDAManager', 'error', `WDA process error for ${udid}: ${err.message}`)
        this.wdaProcesses.delete(udid)
        if (!resolved) reject(new Error(`WDA process error: ${err.message}`))
      })
    })
  }

  private async waitForWDA(udid: string, port: number, tunnelIP: string, maxRetries: number = 30): Promise<void> {
    const client = WDAClient.getInstance(udid, port, tunnelIP)
    for (let i = 0; i < maxRetries; i++) {
      if (await client.isReachable()) {
        log('WDAManager', 'log', `WDA reachable on attempt ${i + 1}`)
        return
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    throw new Error('WebDriverAgent did not become reachable in time. Check that your iPhone is unlocked.')
  }

  async teardownDevice(udid: string): Promise<void> {
    const wdaProc = this.wdaProcesses.get(udid)
    if (wdaProc) {
      wdaProc.kill('SIGTERM')
      this.wdaProcesses.delete(udid)
    }
    const client = WDAClient.getInstance(udid)
    await client.shutdown()
    log('WDAManager', 'log', `[${udid}] Device torn down`)
  }

  async shutdownAll(): Promise<void> {
    for (const [udid, proc] of this.wdaProcesses) {
      proc.kill('SIGTERM')
      log('WDAManager', 'log', `Killed WDA process for ${udid}`)
    }
    this.wdaProcesses.clear()
  }
}

export const wdaManager = WDAManager.getInstance()
