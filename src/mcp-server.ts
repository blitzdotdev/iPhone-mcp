import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { resolveBootedUdid } from './idb/idb-client.js'
import { AXScanClient } from './idb/ax-scan-client.js'
import { getDeviceClient } from './device-client.js'
import { isPhysicalDeviceUdid, type ButtonType, type ScanRegion, type UIElement } from './types.js'
import { WDAClient } from './wda/wda-client.js'
import { wdaScanGrid } from './wda/wda-scan.js'
import { listPhysicalDevices } from './wda/device-discovery.js'
import { applyScanUiFilters, applyDescribeScreenFilters } from './ui-filters.js'
import { detectExecutionContext } from './execution-context.js'
import { wdaManager } from './wda/wda-manager.js'
import { childEnv } from './child-env.js'
import { log } from './logger.js'

const tapParamsSchema = z.object({
  x: z.number().describe('X coordinate to tap'),
  y: z.number().describe('Y coordinate to tap'),
  duration: z.number().optional().describe('Tap duration in seconds'),
})

const swipeParamsSchema = z.object({
  fromX: z.number().describe('Starting X coordinate'),
  fromY: z.number().describe('Starting Y coordinate'),
  toX: z.number().describe('Ending X coordinate'),
  toY: z.number().describe('Ending Y coordinate'),
  duration: z.number().optional().describe('Swipe duration in seconds'),
  delta: z.number().optional().describe('Pixels between touch points'),
})

const buttonParamsSchema = z.object({
  button: z.enum(['HOME', 'LOCK', 'SIDE_BUTTON', 'APPLE_PAY', 'SIRI']).describe('Button to press'),
  duration: z.number().optional().describe('Press duration in seconds'),
})

const inputTextParamsSchema = z.object({
  text: z.string().describe('Text to type'),
})

const keyParamsSchema = z.object({
  key: z.union([z.number(), z.string()]).describe('HID keycode (number) or character (string)'),
  duration: z.number().optional().describe('Key press duration in seconds'),
})

const keySequenceParamsSchema = z.object({
  keySequence: z.array(z.union([z.number(), z.string()])).describe('Sequence of HID keycodes or characters'),
})

const describeAfterSchema = z.object({
  point: z.object({ x: z.number(), y: z.number() }).optional().describe('Describe element at this point after action'),
  all: z.boolean().optional().describe('Describe all elements on screen after action'),
  delay: z.number().optional().describe('Delay in ms before capturing screen state (default: 500)'),
}).optional()

const singleActionSchema = z.object({
  action: z.enum(['tap', 'swipe', 'button', 'input-text', 'key', 'key-sequence']).describe('Type of action to perform'),
  params: z.record(z.string(), z.unknown()).describe('Action-specific parameters'),
})

export function createMcpServer(viewerPort: number) {
  const server = new McpServer({
    name: 'blitz-ios-mcp',
    version: '0.1.0',
  })

  server.registerTool(
    'describe_screen',
    {
      description: `Get the full UI element hierarchy of the current screen. Returns ALL element types (buttons, text, images, containers, etc.) that are currently visible on screen.

Filters applied automatically:
- Off-screen elements are excluded
- Generic unlabeled container nodes are excluded

For finding tappable elements specifically, prefer scan_ui instead.`,
      inputSchema: {
        udid: z.string().optional().describe('Device identifier (default: "booted" for current simulator)'),
        nested: z.boolean().optional().describe('Include nested element hierarchy'),
      },
    },
    async ({ udid = 'booted', nested = false }) => {
      log('MCP', 'log', `describe_screen udid=${udid} nested=${nested}`)
      try {
        const resolvedUdid = udid === 'booted' ? await resolveBootedUdid() : udid
        const client = await getDeviceClient(resolvedUdid)
        const raw = await client.describeAll(nested)

        let screenWidth = 393, screenHeight = 852
        try {
          if (isPhysicalDeviceUdid(resolvedUdid)) {
            const size = await (client as unknown as WDAClient).getWindowSize()
            screenWidth = size.width
            screenHeight = size.height
          } else {
            const axClient = AXScanClient.getInstance(resolvedUdid)
            const size = await axClient.getScreenSize()
            screenWidth = size.width
            screenHeight = size.height
          }
        } catch { /* use defaults */ }

        const rawArray = Array.isArray(raw) ? raw : [raw]
        const filtered = applyDescribeScreenFilters(rawArray as UIElement[], screenWidth, screenHeight)

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(filtered, null, 2) }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error describing screen: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        }
      }
    }
  )

  server.registerTool(
    'device_action',
    {
      description: `Execute a single device action on the iOS device.

Actions available:
- tap: Tap at coordinates { x, y, duration? }
- swipe: Swipe gesture { fromX, fromY, toX, toY, duration?, delta? }
- button: Press button { button: 'HOME'|'LOCK'|'SIDE_BUTTON'|'APPLE_PAY'|'SIRI', duration? }
- input-text: Type text { text }
- key: Press key { key: number (HID keycode) | string (character), duration? }
- key-sequence: Press key sequence { keySequence: (number|string)[] }

Use describe_after to see the screen state after the action.`,
      inputSchema: {
        action: z.enum(['tap', 'swipe', 'button', 'input-text', 'key', 'key-sequence']).describe('Type of action'),
        params: z.record(z.string(), z.unknown()).describe('Action parameters (depends on action type)'),
        udid: z.string().optional().describe('Device identifier (default: "booted")'),
        describe_after: describeAfterSchema.describe('Optional: describe screen after action'),
      },
    },
    async ({ action, params, udid = 'booted', describe_after }) => {
      log('MCP', 'log', `device_action action=${action} udid=${udid}`)
      try {
        const client = await getDeviceClient(udid)
        let actionResult = 'Action completed successfully'

        switch (action) {
          case 'tap': {
            const p = tapParamsSchema.parse(params)
            await client.tap(p.x, p.y, p.duration)
            actionResult = `Tapped at (${p.x}, ${p.y})`
            break
          }
          case 'swipe': {
            const p = swipeParamsSchema.parse(params)
            await client.swipe(p.fromX, p.fromY, p.toX, p.toY, p.duration, p.delta)
            actionResult = `Swiped from (${p.fromX}, ${p.fromY}) to (${p.toX}, ${p.toY})`
            break
          }
          case 'button': {
            const p = buttonParamsSchema.parse(params)
            await client.pressButton(p.button as ButtonType, p.duration)
            actionResult = `Pressed ${p.button} button`
            break
          }
          case 'input-text': {
            const p = inputTextParamsSchema.parse(params)
            await client.inputText(p.text)
            actionResult = `Typed text: "${p.text}"`
            break
          }
          case 'key': {
            const p = keyParamsSchema.parse(params)
            await client.pressKey(p.key, p.duration)
            actionResult = `Pressed key: ${p.key}`
            break
          }
          case 'key-sequence': {
            const p = keySequenceParamsSchema.parse(params)
            await client.pressKeySequence(p.keySequence)
            actionResult = `Pressed key sequence: ${p.keySequence.join(', ')}`
            break
          }
        }

        let descriptionResult: unknown = null
        if (describe_after) {
          await new Promise(resolve => setTimeout(resolve, describe_after.delay ?? 500))
          if (describe_after.all) {
            descriptionResult = await client.describeAll(false)
          } else if (describe_after.point) {
            descriptionResult = await client.describePoint(describe_after.point.x, describe_after.point.y, false)
          }
        }

        const result: { action_result: string; screen_description?: unknown } = { action_result: actionResult }
        if (descriptionResult) result.screen_description = descriptionResult

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error executing ${action}: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        }
      }
    }
  )

  server.registerTool(
    'device_actions',
    {
      description: `Execute multiple device actions in sequence on the iOS device.

Each action in the array should have:
- action: 'tap' | 'swipe' | 'button' | 'input-text' | 'key' | 'key-sequence'
- params: Action-specific parameters

Use describe_after to see the screen state after all actions complete.`,
      inputSchema: {
        actions: z.array(singleActionSchema).describe('Array of actions to execute in sequence'),
        udid: z.string().optional().describe('Device identifier (default: "booted")'),
        describe_after: describeAfterSchema.describe('Optional: describe screen after all actions'),
      },
    },
    async ({ actions, udid = 'booted', describe_after }) => {
      log('MCP', 'log', `device_actions count=${actions.length} udid=${udid}`)
      try {
        const client = await getDeviceClient(udid)
        const results: string[] = []

        for (const { action, params } of actions) {
          switch (action) {
            case 'tap': {
              const p = tapParamsSchema.parse(params)
              await client.tap(p.x, p.y, p.duration)
              results.push(`Tapped at (${p.x}, ${p.y})`)
              break
            }
            case 'swipe': {
              const p = swipeParamsSchema.parse(params)
              await client.swipe(p.fromX, p.fromY, p.toX, p.toY, p.duration, p.delta)
              results.push(`Swiped from (${p.fromX}, ${p.fromY}) to (${p.toX}, ${p.toY})`)
              break
            }
            case 'button': {
              const p = buttonParamsSchema.parse(params)
              await client.pressButton(p.button as ButtonType, p.duration)
              results.push(`Pressed ${p.button} button`)
              break
            }
            case 'input-text': {
              const p = inputTextParamsSchema.parse(params)
              await client.inputText(p.text)
              results.push(`Typed text: "${p.text}"`)
              break
            }
            case 'key': {
              const p = keyParamsSchema.parse(params)
              await client.pressKey(p.key, p.duration)
              results.push(`Pressed key: ${p.key}`)
              break
            }
            case 'key-sequence': {
              const p = keySequenceParamsSchema.parse(params)
              await client.pressKeySequence(p.keySequence)
              results.push(`Pressed key sequence: ${p.keySequence.join(', ')}`)
              break
            }
          }
        }

        let descriptionResult: unknown = null
        if (describe_after) {
          await new Promise(resolve => setTimeout(resolve, describe_after.delay ?? 500))
          if (describe_after.all) {
            descriptionResult = await client.describeAll(false)
          } else if (describe_after.point) {
            descriptionResult = await client.describePoint(describe_after.point.x, describe_after.point.y, false)
          }
        }

        const result: { action_results: string[]; screen_description?: unknown } = { action_results: results }
        if (descriptionResult) result.screen_description = descriptionResult

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error executing actions: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        }
      }
    }
  )

  server.registerTool(
    'get_screenshot',
    {
      description: 'Capture a screenshot of the current iOS device screen. Returns the file path to a PNG image.',
      inputSchema: {
        udid: z.string().optional().describe('Device identifier (default: "booted")'),
      },
    },
    async ({ udid = 'booted' }) => {
      log('MCP', 'log', `get_screenshot udid=${udid}`)
      try {
        const timestamp = Date.now()
        const rawFile = path.join(os.tmpdir(), `blitz-screenshot-${timestamp}.png`)
        const resizedFile = path.join(os.tmpdir(), `blitz-screenshot-${timestamp}-sm.png`)

        if (isPhysicalDeviceUdid(udid)) {
          const client = await getDeviceClient(udid)
          const pngBuffer = await client.screenshot()
          await fs.writeFile(rawFile, pngBuffer)
        } else {
          await new Promise<void>((resolve, reject) => {
            execFile('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=png', rawFile], { env: childEnv(), timeout: 10000 }, (error) => {
              if (error) reject(error)
              else resolve()
            })
          })
        }

        const sizeOutput = await new Promise<string>((resolve, reject) => {
          execFile('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', rawFile], { timeout: 5000 }, (error, stdout) => {
            if (error) reject(error)
            else resolve(stdout)
          })
        })
        const widthMatch = sizeOutput.match(/pixelWidth:\s*(\d+)/)
        const heightMatch = sizeOutput.match(/pixelHeight:\s*(\d+)/)
        const targetWidth = Math.round(Number(widthMatch![1]) / 3)
        const targetHeight = Math.round(Number(heightMatch![1]) / 3)
        await new Promise<void>((resolve, reject) => {
          execFile(
            'sips',
            ['--resampleWidth', String(targetWidth), '--resampleHeight', String(targetHeight), rawFile, '--out', resizedFile],
            { timeout: 5000 },
            (error) => {
              if (error) reject(error)
              else resolve()
            }
          )
        })

        return {
          content: [{ type: 'text' as const, text: resizedFile }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error capturing screenshot: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        }
      }
    }
  )

  server.registerTool(
    'scan_ui',
    {
      description: `Find interactive UI elements (buttons, links, text fields, switches, icons, etc.) on the current screen. Returns only tappable/interactive elements with their coordinates.

Use the "query" parameter to search for a specific element by label (e.g. "Add to Cart", "Settings"). When a query is provided:
- First searches visible interactive elements matching the query
- If not found on-screen, searches off-screen elements and warns you to scroll
- If no interactive match, falls back to all visible interactive elements

Without a query, returns all visible interactive elements on screen.

Region options optimize scan time:
- "top-left" / "top-right" / "bottom-left" / "bottom-right": ~250ms
- "top-half" / "bottom-half": ~500ms
- "full": ~1s (entire screen)

For the complete element tree (all types), use describe_screen instead.`,
      inputSchema: {
        region: z.enum(['full', 'top-half', 'bottom-half', 'top-left', 'top-right', 'bottom-left', 'bottom-right'])
          .describe('Screen region to scan'),
        query: z.string().optional().describe('Search for elements matching this text (case-insensitive)'),
        udid: z.string().optional().describe('Device identifier (default: "booted")'),
      },
    },
    async ({ region, query, udid = 'booted' }) => {
      log('MCP', 'log', `scan_ui region=${region} query=${query ?? '(none)'} udid=${udid}`)
      try {
        const resolvedUdid = udid === 'booted' ? await resolveBootedUdid() : udid

        let rawElements: unknown[]
        let screenWidth = 393, screenHeight = 852

        if (isPhysicalDeviceUdid(resolvedUdid)) {
          const client = await getDeviceClient(resolvedUdid) as unknown as WDAClient
          rawElements = await wdaScanGrid(client, region as ScanRegion)
          try {
            const size = await client.getWindowSize()
            screenWidth = size.width
            screenHeight = size.height
          } catch { /* use defaults */ }
        } else {
          const client = AXScanClient.getInstance(resolvedUdid)
          rawElements = await client.scan(region as ScanRegion)
          try {
            const size = await client.getScreenSize()
            screenWidth = size.width
            screenHeight = size.height
          } catch { /* use defaults */ }
        }

        const { elements, warning } = applyScanUiFilters(rawElements as UIElement[], screenWidth, screenHeight, query)

        const content: { type: 'text'; text: string }[] = []
        if (warning) content.push({ type: 'text' as const, text: `Warning: ${warning}` })
        content.push({ type: 'text' as const, text: JSON.stringify(elements, null, 2) })

        return { content }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error scanning UI: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        }
      }
    }
  )

  server.registerTool(
    'list_devices',
    {
      description: 'List all available iOS devices (simulators and physical devices).',
      inputSchema: {},
    },
    async () => {
      log('MCP', 'log', 'list_devices')
      try {
        let simulators: { udid: string; name: string; state: string }[] = []
        try {
          const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
            execFile('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { timeout: 10000 }, (error, stdout) => {
              if (error) reject(error)
              else resolve({ stdout })
            })
          })
          const data = JSON.parse(stdout)
          for (const runtime of Object.values(data.devices) as { udid: string; name: string; state: string }[][]) {
            for (const device of runtime) {
              if (device.state === 'Booted') {
                simulators.push({ udid: device.udid, name: device.name, state: device.state })
              }
            }
          }
        } catch {
          // simctl not available
        }

        const physicalDevices = await listPhysicalDevices()

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ simulators, physicalDevices }, null, 2) }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error listing devices: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        }
      }
    }
  )

  server.registerTool(
    'get_execution_context',
    {
      description: `Get the current execution context — which iOS device(s) are available.

Call this first to discover available devices. Returns:
- target: 'simulator' — one simulator booted, use the returned udid
- target: 'device' — one physical device connected, use the returned udid. Inform user about viewer_url for screen viewing.
- target: 'ambiguous' — multiple devices found. Ask the user which one to use.
- target: 'none' — no devices. Tell user to boot a simulator or connect an iPhone.

Pass the returned udid to all subsequent tool calls.`,
      inputSchema: {},
    },
    async () => {
      log('MCP', 'log', 'get_execution_context')
      try {
        const ctx = await detectExecutionContext(viewerPort)

        if (ctx.target === 'simulator') {
          let screenSize: { width: number; height: number } | null = null
          try {
            const axClient = AXScanClient.getInstance(ctx.udid)
            screenSize = await axClient.getScreenSize()
          } catch { /* unavailable */ }

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                target: 'simulator',
                udid: ctx.udid,
                name: ctx.name,
                screen_size: screenSize,
              }, null, 2),
            }],
          }
        }

        if (ctx.target === 'device') {
          let screenSize: { width: number; height: number } | null = null
          try {
            const client = await getDeviceClient(ctx.udid) as unknown as WDAClient
            screenSize = await client.getWindowSize()
          } catch { /* unavailable */ }

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                target: 'device',
                udid: ctx.udid,
                device_name: ctx.name,
                model: ctx.model,
                connection_type: ctx.connectionType,
                viewer_url: ctx.viewerUrl,
                screen_size: screenSize,
              }, null, 2),
            }],
          }
        }

        if (ctx.target === 'ambiguous') {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                target: 'ambiguous',
                message: 'Multiple devices found. Ask the user which device to target.',
                simulators: ctx.simulators,
                physical_devices: ctx.physicalDevices,
              }, null, 2),
            }],
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ target: 'none', message: ctx.message }, null, 2),
          }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error getting execution context: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        }
      }
    }
  )

  server.registerTool(
    'setup_device',
    {
      description: `Build, install, and launch WebDriverAgent on a physical iPhone. This is required before any other tool can interact with a physical device.

Call this when get_execution_context shows a physical device with wdaRunning: false. The process takes 1-3 minutes (building WDA, installing on device, establishing connection).

Prerequisites:
- iPhone connected via USB and trusted
- Developer Mode enabled on iPhone (Settings > Privacy & Security > Developer Mode)
- Apple ID signed into Xcode (Xcode > Settings > Accounts)

After setup completes, use the returned udid for all subsequent tool calls. Also inform the user about the viewer_url where they can see the device screen.`,
      inputSchema: {
        udid: z.string().describe('Physical device UDID from list_devices or get_execution_context'),
      },
    },
    async ({ udid }, extra) => {
      log('MCP', 'log', `setup_device udid=${udid}`)
      try {
        const progressToken = extra._meta?.progressToken
        const steps: Record<string, number> = {
          connecting: 1,
          building_wda: 2,
          installing_wda: 3,
          establishing_connection: 4,
          ready: 5,
        }
        const totalSteps = 5
        const progressMessages: string[] = []

        const client = await wdaManager.setupDevice(udid, (progress) => {
          progressMessages.push(`[${progress.step}] ${progress.message}`)
          if (progressToken) {
            extra.sendNotification({
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: steps[progress.step] ?? 0,
                total: totalSteps,
                message: progress.message,
              },
            }).catch(() => {})
          }
        })

        let screenSize: { width: number; height: number } | null = null
        try {
          screenSize = await client.getWindowSize()
        } catch { /* unavailable */ }

        const viewerUrl = `http://localhost:${viewerPort}?udid=${encodeURIComponent(udid)}`

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'connected',
              udid,
              viewer_url: viewerUrl,
              screen_size: screenSize,
              setup_log: progressMessages,
            }, null, 2) + `\n\nIMPORTANT: Tell the user to open this URL to see the device screen: ${viewerUrl}`,
          }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error setting up device: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        }
      }
    }
  )

  server.registerTool(
    'launch_app',
    {
      description: 'Launch an app on the iOS device by bundle ID.',
      inputSchema: {
        bundleId: z.string().describe('The bundle identifier of the app to launch (e.g. "com.apple.mobilesafari")'),
        udid: z.string().optional().describe('Device identifier (default: "booted")'),
      },
    },
    async ({ bundleId, udid = 'booted' }) => {
      log('MCP', 'log', `launch_app bundleId=${bundleId} udid=${udid}`)
      try {
        if (isPhysicalDeviceUdid(udid)) {
          const client = await getDeviceClient(udid) as unknown as WDAClient
          await client.activateApp(bundleId)
        } else {
          const { getIDBClient } = await import('./idb/idb-client.js')
          const client = getIDBClient(udid)
          await client.launch(bundleId)
        }

        return {
          content: [{ type: 'text' as const, text: `Launched ${bundleId}` }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error launching app: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        }
      }
    }
  )

  server.registerTool(
    'list_apps',
    {
      description: 'List installed apps on the iOS device.',
      inputSchema: {
        udid: z.string().optional().describe('Device identifier (default: "booted")'),
      },
    },
    async ({ udid = 'booted' }) => {
      log('MCP', 'log', `list_apps udid=${udid}`)
      try {
        if (isPhysicalDeviceUdid(udid)) {
          return {
            content: [{ type: 'text' as const, text: 'list_apps is not yet supported for physical devices via WDA.' }],
          }
        }

        const { getIDBClient } = await import('./idb/idb-client.js')
        const client = getIDBClient(udid)
        const apps = await client.listApps()

        const userApps = apps.filter(a => a.type === 'User')
        const systemApps = apps.filter(a => a.type === 'System')

        let text = `User apps (${userApps.length}):\n`
        for (const app of userApps) {
          text += `  ${app.name} — ${app.bundleId}\n`
        }
        text += `\nSystem apps (${systemApps.length}):\n`
        for (const app of systemApps) {
          text += `  ${app.name} — ${app.bundleId}\n`
        }

        return {
          content: [{ type: 'text' as const, text: text.trim() }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error listing apps: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        }
      }
    }
  )

  return server
}
