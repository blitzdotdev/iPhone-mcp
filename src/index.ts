import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpServer } from './mcp-server.js'
import { createViewerServer } from './viewer/server.js'
import { log } from './logger.js'

const DEFAULT_VIEWER_PORT = 5150

export async function startServer(): Promise<void> {
  log('Server', 'log', 'Starting blitz-iphone-mcp...')

  let viewerPort = 0
  try {
    const { start } = createViewerServer()
    viewerPort = await start(DEFAULT_VIEWER_PORT)
    log('Server', 'log', `Viewer server listening on http://localhost:${viewerPort}`)
  } catch (e) {
    log('Server', 'warn', `Viewer server failed to start (non-fatal): ${e}`)
  }

  const server = createMcpServer(viewerPort)
  const transport = new StdioServerTransport()
  await server.connect(transport)

  log('Server', 'log', `MCP server running (stdio).${viewerPort ? ` Viewer at http://localhost:${viewerPort}` : ''}`)
}
