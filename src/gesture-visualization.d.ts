declare module 'unix-dgram' {
  interface UnixDgramSocket {
    on(event: 'error', listener: (error: Error) => void): this
    send(buf: Buffer, offset: number, length: number, path: string, callback?: (error?: Error | null) => void): void
    close(): void
  }

  export function createSocket(type: 'unix_dgram', listener?: (buf: Buffer) => void): UnixDgramSocket
}
