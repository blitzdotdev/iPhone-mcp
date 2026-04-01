#!/usr/bin/env node

import { mkdtemp, rm, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const require = createRequire(import.meta.url)
const unixDgram = require('unix-dgram')

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const iterations = Number.parseInt(process.env.BLITZ_GESTURE_BENCH_ITERATIONS ?? '5', 10)
const timeoutMs = Number.parseInt(process.env.BLITZ_GESTURE_BENCH_TIMEOUT_MS ?? '3000', 10)
const tapX = Number.parseFloat(process.env.BLITZ_GESTURE_BENCH_X ?? '100')
const tapY = Number.parseFloat(process.env.BLITZ_GESTURE_BENCH_Y ?? '100')
const targetUdid = process.env.BLITZ_GESTURE_BENCH_UDID ?? 'booted'

function extractText(result) {
  const textPart = result.content.find((item) => item.type === 'text')
  if (!textPart || typeof textPart.text !== 'string') {
    throw new Error('Tool result did not include a text payload')
  }
  return textPart.text
}

function createReceiver(socketPath) {
  const queue = []
  const waiters = []

  const socket = unixDgram.createSocket('unix_dgram', (buffer) => {
    const packet = {
      receivedAtMs: performance.now(),
      event: JSON.parse(buffer.toString('utf8')),
    }

    const waiter = waiters.shift()
    if (waiter) {
      waiter(packet)
      return
    }

    queue.push(packet)
  })

  return {
    async bind() {
      await unlink(socketPath).catch(() => {})
      socket.bind(socketPath)
      await delay(10)
    },
    async nextEvent() {
      if (queue.length > 0) {
        return queue.shift()
      }

      return await Promise.race([
        new Promise((resolve) => {
          waiters.push(resolve)
        }),
        delay(timeoutMs).then(() => {
          throw new Error(`Timed out waiting for gesture event after ${timeoutMs} ms`)
        }),
      ])
    },
    close() {
      socket.close()
    },
  }
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gesture-visualization-bench-'))
  const socketPath = path.join(tempDir, 'gesture-events.sock')
  const receiver = createReceiver(socketPath)

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/cli.js'],
    cwd: repoRoot,
    env: {
      ...process.env,
      BLITZ_GESTURE_EVENTS_SOCKET: socketPath,
    },
    stderr: 'pipe',
  })

  const stderrChunks = []
  transport.stderr?.on('data', (chunk) => {
    stderrChunks.push(String(chunk))
  })

  const client = new Client({
    name: 'gesture-visualization-benchmark',
    version: '0.1.0',
  })

  try {
    await receiver.bind()
    await client.connect(transport)

    const warmupReceive = receiver.nextEvent()
    await client.callTool({
      name: 'device_action',
      arguments: {
        action: 'tap',
        params: { x: tapX, y: tapY },
        udid: targetUdid,
      },
    })
    const warmupPacket = await warmupReceive

    const samples = []
    for (let index = 0; index < iterations; index += 1) {
      const receivePromise = receiver.nextEvent()
      const startedAtMs = performance.now()
      const actionPromise = client.callTool({
        name: 'device_action',
        arguments: {
          action: 'tap',
          params: { x: tapX, y: tapY },
          udid: targetUdid,
        },
      })

      const packet = await receivePromise
      await actionPromise

      samples.push({
        iteration: index + 1,
        overlayLatencyMs: Number((packet.receivedAtMs - startedAtMs).toFixed(3)),
        emittedAtTsMs: packet.event.tsMs,
        eventId: packet.event.id,
        kind: packet.event.kind,
      })

      await delay(100)
    }

    const values = samples.map((sample) => sample.overlayLatencyMs)
    const avgMs = values.reduce((sum, value) => sum + value, 0) / values.length
    const sortedValues = [...values].sort((left, right) => left - right)
    const p95Index = Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * 0.95) - 1)

    process.stdout.write(JSON.stringify({
      socketPath,
      requestedUdid: targetUdid,
      resolvedDeviceId: warmupPacket.event.target.deviceId,
      tap: { x: tapX, y: tapY },
      samples,
      summary: {
        iterations,
        avgMs: Number(avgMs.toFixed(3)),
        minMs: sortedValues[0],
        maxMs: sortedValues[sortedValues.length - 1],
        p50Ms: sortedValues[Math.floor(sortedValues.length / 2)],
        p95Ms: sortedValues[p95Index],
      },
    }, null, 2) + '\n')
  } catch (error) {
    const stderr = stderrChunks.join('')
    const details = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Benchmark failed: ${details}\n`)
    if (stderr) {
      process.stderr.write('\nServer stderr:\n')
      process.stderr.write(stderr)
      if (!stderr.endsWith('\n')) {
        process.stderr.write('\n')
      }
    }
    process.exitCode = 1
  } finally {
    receiver.close()
    await client.close().catch(() => {})
    await rm(tempDir, { recursive: true, force: true })
  }
}

await main()
