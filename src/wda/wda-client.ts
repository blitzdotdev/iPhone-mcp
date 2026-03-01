import { log } from '../logger.js'

interface WDAElement {
  type: string
  label: string | null
  name: string | null
  value: string | null
  rect: { x: number; y: number; width: number; height: number }
  isEnabled: boolean
  isVisible: boolean
  children?: WDAElement[]
}

interface WDASessionResponse {
  value: { sessionId: string }
  sessionId: string
}

interface WDAScreenshotResponse {
  value: string
}

interface WDAStatusResponse {
  value: {
    ready: boolean
    message?: string
    state?: string
    os?: { name: string; version: string; sdkVersion?: string }
    ios?: { ip: string }
    build?: { time: string; productBundleIdentifier: string }
  }
}

export class WDAClient {
  private static instances: Map<string, WDAClient> = new Map()
  private baseUrl: string
  private sessionId: string | null = null
  private udid: string
  private port: number

  private constructor(udid: string, port: number = 8100, host?: string) {
    this.udid = udid
    this.port = port
    if (host) {
      const hostPart = host.includes(':') ? `[${host}]` : host
      this.baseUrl = `http://${hostPart}:${port}`
    } else {
      this.baseUrl = `http://localhost:${port}`
    }
  }

  static getInstance(udid: string, port: number = 8100, host?: string): WDAClient {
    const key = `${udid}:${port}`
    const existing = WDAClient.instances.get(key)
    if (existing) {
      if (host) {
        const hostPart = host.includes(':') ? `[${host}]` : host
        existing.baseUrl = `http://${hostPart}:${port}`
      }
      return existing
    }
    const instance = new WDAClient(udid, port, host)
    WDAClient.instances.set(key, instance)
    return instance
  }

  static getExistingInstance(udid: string, port: number = 8100): WDAClient | null {
    return WDAClient.instances.get(`${udid}:${port}`) ?? null
  }

  static removeInstance(udid: string, port: number = 8100): void {
    WDAClient.instances.delete(`${udid}:${port}`)
  }

  private async request<T>(method: string, path: string, body?: Record<string, unknown>, _retried?: boolean): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const options: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
    }
    if (body) options.body = JSON.stringify(body)

    const response = await fetch(url, options)
    if (!response.ok) {
      const text = await response.text()
      if (response.status === 404 && (text.includes('invalid session id') || text.includes('Session does not exist'))) {
        log('WDAClient', 'warn', `Session ${this.sessionId} is stale, clearing and retrying`)
        this.sessionId = null
        if (!_retried && path.includes('/session/')) {
          await this.createSession()
          const newPath = path.replace(/\/session\/[^/]+/, `/session/${this.sessionId}`)
          return this.request<T>(method, newPath, body, true)
        }
      }
      let shortMessage = text
      try {
        const parsed = JSON.parse(text)
        if (parsed?.value?.message) {
          const msg = parsed.value.message as string
          const nsDesc = msg.match(/NSLocalizedDescription=([^,}]+)/)
          shortMessage = nsDesc ? nsDesc[1] : msg.split('UserInfo=')[0].trim()
        }
      } catch { /* not JSON, use raw text */ }
      log('WDAClient', 'error', `WDA ${method} ${path} -> ${response.status}: ${text}`)
      throw new Error(shortMessage)
    }
    return response.json() as Promise<T>
  }

  async isReachable(): Promise<boolean> {
    try {
      const status = await this.request<WDAStatusResponse>('GET', '/status')
      return status.value?.ready === true
    } catch {
      return false
    }
  }

  async createSession(): Promise<void> {
    if (this.sessionId) return
    log('WDAClient', 'log', `Creating WDA session for ${this.udid}...`)
    const response = await this.request<WDASessionResponse>('POST', '/session', {
      capabilities: { alwaysMatch: {}, firstMatch: [{}] },
    })
    this.sessionId = response.value?.sessionId ?? response.sessionId
    log('WDAClient', 'log', `WDA session created: ${this.sessionId}`)
  }

  async destroySession(): Promise<void> {
    if (!this.sessionId) return
    try {
      await this.request<unknown>('DELETE', `/session/${this.sessionId}`)
    } catch (e) {
      log('WDAClient', 'warn', `Failed to destroy WDA session: ${e}`)
    }
    this.sessionId = null
  }

  private async ensureSession(): Promise<string> {
    if (!this.sessionId) await this.createSession()
    return this.sessionId!
  }

  async tap(x: number, y: number, duration?: number): Promise<void> {
    const sessionId = await this.ensureSession()
    log('WDAClient', 'log', `Tap at (${x}, ${y}) duration=${duration}`)

    if (duration && duration > 0) {
      await this.request<unknown>('POST', `/session/${sessionId}/wda/touchAndHold`, { x, y, duration })
    } else {
      await this.request<unknown>('POST', `/session/${sessionId}/actions`, {
        actions: [{
          type: 'pointer',
          id: 'finger1',
          parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, x, y },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 100 },
            { type: 'pointerUp', button: 0 },
          ],
        }],
      })
    }
  }

  async swipe(fromX: number, fromY: number, toX: number, toY: number, duration?: number): Promise<void> {
    const sessionId = await this.ensureSession()
    const moveDuration = Math.round((duration ?? 0.3) * 1000)
    log('WDAClient', 'log', `Swipe from (${fromX}, ${fromY}) to (${toX}, ${toY}) duration=${moveDuration}ms`)

    await this.request<unknown>('POST', `/session/${sessionId}/actions`, {
      actions: [{
        type: 'pointer',
        id: 'finger1',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: fromX, y: fromY },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', duration: moveDuration, x: toX, y: toY, origin: 'viewport' },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    })
  }

  async inputText(text: string): Promise<void> {
    const sessionId = await this.ensureSession()
    log('WDAClient', 'log', `Input text: "${text.slice(0, 50)}"`)
    await this.request<unknown>('POST', `/session/${sessionId}/wda/keys`, { value: [...text] })
  }

  async pressButton(button: string, duration?: number): Promise<void> {
    const sessionId = await this.ensureSession()
    log('WDAClient', 'log', `Press button: ${button} duration=${duration}`)

    const buttonMap: Record<string, string> = {
      HOME: 'home',
      LOCK: 'lock',
      SIDE_BUTTON: 'lock',
      VOLUME_UP: 'volumeUp',
      VOLUME_DOWN: 'volumeDown',
    }
    const wdaButton = buttonMap[button] ?? button.toLowerCase()
    await this.request<unknown>('POST', `/session/${sessionId}/wda/pressButton`, {
      name: wdaButton,
      ...(duration ? { duration } : {}),
    })
  }

  async pressKey(key: number | string, _duration?: number): Promise<void> {
    if (typeof key === 'string') {
      await this.inputText(key)
      return
    }
    log('WDAClient', 'warn', `pressKey with HID keycode ${key} not supported on physical device`)
  }

  async pressKeySequence(keySequence: (number | string)[]): Promise<void> {
    const text = keySequence.filter((k): k is string => typeof k === 'string').join('')
    if (text) await this.inputText(text)
  }

  async screenshot(): Promise<Buffer> {
    let sessionId = await this.ensureSession()
    try {
      const response = await this.request<WDAScreenshotResponse>('GET', `/session/${sessionId}/screenshot`)
      return Buffer.from(response.value, 'base64')
    } catch (e) {
      if (!this.sessionId) {
        sessionId = await this.ensureSession()
        const response = await this.request<WDAScreenshotResponse>('GET', `/session/${sessionId}/screenshot`)
        return Buffer.from(response.value, 'base64')
      }
      throw e
    }
  }

  async getWindowSize(): Promise<{ width: number; height: number }> {
    const sessionId = await this.ensureSession()
    const response = await this.request<{ value: { width: number; height: number } }>('GET', `/session/${sessionId}/window/size`)
    return response.value
  }

  async getSource(): Promise<string> {
    const sessionId = await this.ensureSession()
    const response = await this.request<{ value: string }>('GET', `/session/${sessionId}/source`)
    return response.value
  }

  async describeAll(nested?: boolean): Promise<unknown> {
    const xml = await this.getSource()
    return this.parseAccessibilityXml(xml, nested)
  }

  async describePoint(x: number, y: number, nested?: boolean): Promise<unknown> {
    const xml = await this.getSource()
    return this.findElementAtPoint(this.parseAccessibilityXml(xml, nested ?? true), x, y)
  }

  parseAccessibilityXml(xml: string, nested?: boolean): Record<string, unknown>[] {
    const elements: Record<string, unknown>[] = []
    const elementRegex = /<(XCUIElementType\w+)\s+([^>]*?)(\s*\/>|>)/g
    let match: RegExpExecArray | null

    while ((match = elementRegex.exec(xml)) !== null) {
      const attrs = this.parseXmlAttributes(match[2])
      const elementType = this.normalizeElementType(match[1])

      const element: Record<string, unknown> = {
        type: elementType,
        AXLabel: attrs.label ?? null,
        AXValue: attrs.value ?? null,
        title: attrs.name ?? null,
        frame: {
          x: Number(attrs.x ?? 0),
          y: Number(attrs.y ?? 0),
          width: Number(attrs.width ?? 0),
          height: Number(attrs.height ?? 0),
        },
        AXUniqueId: attrs.accessible === 'true' ? attrs.name : null,
        enabled: attrs.enabled === 'true',
        visible: attrs.visible === 'true',
      }

      if (!nested) {
        if (element.visible && (element.enabled || elementType === 'StaticText')) {
          elements.push(element)
        }
      } else {
        elements.push(element)
      }
    }

    return elements
  }

  private parseXmlAttributes(attrString: string): Record<string, string> {
    const attrs: Record<string, string> = {}
    const attrRegex = /(\w+)="([^"]*)"/g
    let match: RegExpExecArray | null
    while ((match = attrRegex.exec(attrString)) !== null) {
      attrs[match[1]] = match[2]
    }
    return attrs
  }

  private normalizeElementType(wdaType: string): string {
    return wdaType.replace('XCUIElementType', '')
  }

  private normalizeElement(raw: Record<string, unknown>): Record<string, unknown> {
    return {
      type: this.normalizeElementType(raw.type as string ?? ''),
      AXLabel: raw.label ?? null,
      AXValue: raw.value ?? null,
      frame: raw.rect ?? { x: 0, y: 0, width: 0, height: 0 },
      enabled: raw.isEnabled ?? true,
      visible: raw.isVisible ?? true,
    }
  }

  private findElementAtPoint(tree: unknown, x: number, y: number): unknown {
    if (!tree || typeof tree !== 'object') return null
    const elements = Array.isArray(tree) ? tree : (tree as { children?: unknown[] }).children ?? []

    let best: WDAElement | null = null
    let bestArea = Infinity

    for (const el of elements as WDAElement[]) {
      const r = el.rect ?? { x: 0, y: 0, width: 0, height: 0 }
      if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) {
        const area = r.width * r.height
        if (area < bestArea) {
          bestArea = area
          best = el
        }
      }
      if (el.children) {
        const child = this.findElementAtPoint({ children: el.children }, x, y)
        if (child) {
          const cr = (child as WDAElement).rect
          if (cr) {
            const childArea = cr.width * cr.height
            if (childArea < bestArea) {
              bestArea = childArea
              best = child as WDAElement
            }
          }
        }
      }
    }

    return best ? this.normalizeElement(best as unknown as Record<string, unknown>) : null
  }

  async activateApp(bundleId: string): Promise<void> {
    const sessionId = await this.ensureSession()
    await this.request<unknown>('POST', `/session/${sessionId}/wda/apps/activate`, { bundleId })
  }

  async shutdown(): Promise<void> {
    await this.destroySession()
    WDAClient.removeInstance(this.udid, this.port)
    log('WDAClient', 'log', `[${this.udid}] Shutdown complete`)
  }
}

export function getWDAClient(udid: string, port: number = 8100): WDAClient {
  return WDAClient.getInstance(udid, port)
}
