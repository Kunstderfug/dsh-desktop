import { afterEach, describe, expect, it } from 'vitest'
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import type { InternetTunnelInstance, TunnelRuntimeState } from '../src/main/mobile/internet-tunnel'
import {
  isInternetTunnelHost,
  isPrivateAddress,
  LanMobileBridge,
  normalizeRemoteAddress
} from '../src/main/mobile/lan-mobile-bridge'

const bridges: LanMobileBridge[] = []
const servers: ReturnType<typeof createServer>[] = []
interface TestWebSocket {
  send(data: string): void
}
interface TestWebSocketServer {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (client: TestWebSocket) => void
  ): void
  close(callback: (error?: Error) => void): void
}
const WebSocketServer = createRequire(import.meta.url)('ws').WebSocketServer as new (options: {
  noServer: boolean
}) => TestWebSocketServer
const webSocketServers: TestWebSocketServer[] = []

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()))
  await Promise.all(
    webSocketServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        )
    )
  )
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
})

describe('LAN mobile bridge address policy', () => {
  it('allows loopback and RFC1918 addresses', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true)
    expect(isPrivateAddress('10.1.2.3')).toBe(true)
    expect(isPrivateAddress('172.16.0.1')).toBe(true)
    expect(isPrivateAddress('172.31.255.1')).toBe(true)
    expect(isPrivateAddress('192.168.1.10')).toBe(true)
  })

  it('rejects public addresses and out-of-range 172 networks', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
    expect(isPrivateAddress('172.15.0.1')).toBe(false)
    expect(isPrivateAddress('172.32.0.1')).toBe(false)
  })

  it('normalizes IPv4-mapped IPv6 addresses', () => {
    expect(normalizeRemoteAddress('::ffff:192.168.1.4')).toBe('192.168.1.4')
  })

  it('recognizes Cloudflare and Pinggy public tunnel hosts', () => {
    expect(isInternetTunnelHost('mobile.trycloudflare.com')).toBe(true)
    expect(isInternetTunnelHost('api.trycloudflare.com')).toBe(false)
    expect(isInternetTunnelHost('mobile.a.pinggy.link')).toBe(true)
    expect(isInternetTunnelHost('mobile.run.pinggy-free.link')).toBe(true)
    expect(isInternetTunnelHost('mobile.a.free.pinggy.online')).toBe(true)
    expect(isInternetTunnelHost('free.pinggy.io')).toBe(false)
  })
})

describe('LAN mobile bridge pairing surface', () => {
  it('serves the desktop pairing page only on loopback', async () => {
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9999'
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    expect(snapshot.desktopUrl).toBe(`http://127.0.0.1:${snapshot.port}/desktop`)
    expect(snapshot.desktopUrl).not.toContain('k=')
    const cookie = await authorizeDesktop(bridge)
    const response = await fetch(snapshot.desktopUrl!, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Connect a mobile device')
  })

  it('offers a reconnect page without exposing mobile APIs before approval', async () => {
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9999'
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    const response = await fetch(`http://127.0.0.1:${snapshot.port}/`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Reconnect')
    const blocked = await fetch(`http://127.0.0.1:${snapshot.port}/api/status`)
    expect(blocked.status).toBe(401)
  })

  it('migrates a stale WiFi reconnect into the active internet entry point', async () => {
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9999'
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    let tunnelStopped = false
    Object.assign(bridge as unknown as Record<string, unknown>, {
      tunnelActive: true,
      tunnelInstance: {
        url: 'https://active-mobile.trycloudflare.com',
        process: {},
        stop: async () => {
          tunnelStopped = true
        }
      }
    })

    const lanReconnect = await fetch(`http://127.0.0.1:${snapshot.port}/reconnect`, {
      redirect: 'manual'
    })
    expect(lanReconnect.status).toBe(302)
    expect(lanReconnect.headers.get('location')).toBe(
      'https://active-mobile.trycloudflare.com/reconnect'
    )

    const lanRetry = await fetch(`http://127.0.0.1:${snapshot.port}/pair/retry`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${snapshot.port}`
      },
      body: '{}'
    })
    expect(await lanRetry.json()).toEqual({
      redirectUrl: 'https://active-mobile.trycloudflare.com/reconnect'
    })

    const desktopCookie = await authorizeDesktop(bridge)
    await fetch(`http://127.0.0.1:${snapshot.port}/desktop/tunnel/status`, {
      headers: { cookie: desktopCookie }
    })
    const tunnelReconnect = await fetch(`http://127.0.0.1:${snapshot.port}/reconnect`, {
      headers: {
        host: 'active-mobile.trycloudflare.com',
        'cf-connecting-ip': '203.0.113.8',
        'cf-ray': 'test-ray'
      }
    })
    expect(tunnelReconnect.status).toBe(200)
    expect(await tunnelReconnect.text()).toContain('Enter pairing password')
    expect(tunnelStopped).toBe(false)
  })

  it('treats Pinggy forwarding headers as an internet tunnel request', async () => {
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9999'
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    Object.assign(bridge as unknown as Record<string, unknown>, {
      tunnelActive: true,
      tunnelInstance: {
        provider: 'pinggy',
        url: 'https://active-mobile.a.pinggy.link',
        process: {},
        stop: async () => undefined
      }
    })

    const reconnectStatus = await requestStatus(snapshot.port!, '/reconnect', {
      host: 'active-mobile.a.pinggy.link',
      'x-forwarded-for': '203.0.113.18',
      'x-forwarded-proto': 'https'
    })
    expect(reconnectStatus).toBe(200)
  })

  it('keeps the active internet tunnel available after desktop disconnect', async () => {
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9999'
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    let tunnelStopped = false
    Object.assign(bridge as unknown as Record<string, unknown>, {
      tunnelActive: true,
      tunnelInstance: {
        url: 'https://active-mobile.trycloudflare.com',
        process: {},
        stop: async () => {
          tunnelStopped = true
        }
      }
    })

    const desktopCookie = await authorizeDesktop(bridge)
    const disconnected = await fetch(
      `http://127.0.0.1:${snapshot.port}/desktop/disconnect`,
      { method: 'POST', headers: { cookie: desktopCookie } }
    )
    expect(disconnected.status).toBe(200)
    expect(bridge.snapshot().tunnelActive).toBe(true)
    expect(tunnelStopped).toBe(false)

    const reconnectPage = await fetch(`http://127.0.0.1:${snapshot.port}/disconnected`, {
      headers: {
        host: 'active-mobile.trycloudflare.com',
        'cf-connecting-ip': '203.0.113.8',
        'cf-ray': 'test-ray'
      }
    })
    expect(reconnectPage.status).toBe(200)
    const reconnectHtml = await reconnectPage.text()
    expect(reconnectHtml).toContain('Reconnect')
    expect(reconnectHtml).not.toContain('same Wi-Fi')
  })

  it('opens the pairing window for a WiFi reconnect and does not issue a session', async () => {
    let reconnectRequests = 0
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9999',
      onReconnectRequested: () => {
        reconnectRequests += 1
      }
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    const reconnect = await fetch(`http://127.0.0.1:${snapshot.port}/reconnect`)
    expect(reconnect.headers.get('set-cookie')).toBeNull()
    expect(await reconnect.text()).toContain('scan the new QR code')
    expect(reconnectRequests).toBe(1)
    const retried = await fetch(`http://127.0.0.1:${snapshot.port}/pair/retry`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${snapshot.port}`
      },
      body: '{}'
    })
    expect(await retried.json()).toEqual({ ok: true, rescan: true })
    expect(reconnectRequests).toBe(2)
  })

  it('pairs on scan, then forwards only allowlisted RPC methods', async () => {
    const harness = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url === '/api/remote.mux') {
        response.statusCode = 404
        response.end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { rpcId: string }
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          type: 'server-response',
          rpcId: envelope.rpcId,
          result: { ok: true, value: { items: [], archivedSessionIds: [] } }
        })
      )
    })
    const pairingMux = new WebSocketServer({ noServer: true })
    webSocketServers.push(pairingMux)
    harness.on('upgrade', (request, socket, head) => {
      if (request.url !== '/api/remote.mux') return socket.destroy()
      pairingMux.handleUpgrade(request, socket, head, (client) => {
        client.send(JSON.stringify({
          type: 'item',
          streamId: 'mobile-workspaces',
          value: { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
        }))
      })
    })
    servers.push(harness)
    await new Promise<void>((resolve) => harness.listen(0, '127.0.0.1', resolve))
    const harnessPort = (harness.address() as AddressInfo).port
    const bridge = new LanMobileBridge({
      harnessUrl: () => `http://127.0.0.1:${harnessPort}`
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    const token = new URL(snapshot.pairingUrl!).searchParams.get('token')
    const paired = await fetch(`http://127.0.0.1:${snapshot.port}/pair?token=${token}`, {
      redirect: 'manual'
    })
    expect(paired.status).toBe(302)
    expect(paired.headers.get('location')).toBe('/')
    const cookie = paired.headers.get('set-cookie')!.split(';', 1)[0]!

    const rescanned = await fetch(
      `http://127.0.0.1:${snapshot.port}/pair?token=${token}`,
      { headers: { cookie }, redirect: 'manual' }
    )
    expect(rescanned.status).toBe(302)
    expect(rescanned.headers.get('location')).toBe('/')

    const forwarded = await fetch(`http://127.0.0.1:${snapshot.port}/api/rpc`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'session.list', payload: {} })
    })
    expect(forwarded.status).toBe(200)
    expect(await forwarded.json()).toMatchObject({ ok: true, value: { items: [] } })

    // The Host serves workspaces only as a stream now, so this answer comes
    // from the `workspace/follow` baseline the carrier retained rather than
    // from a unary call.
    const workspaces = await fetch(`http://127.0.0.1:${snapshot.port}/api/rpc`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'workspace.list', payload: {} })
    })
    expect(workspaces.status).toBe(200)
    expect(await workspaces.json()).toMatchObject({
      ok: true,
      value: { items: [], archivedSessionIds: [] }
    })

    const presetList = await fetch(`http://127.0.0.1:${snapshot.port}/api/rpc`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'agentPreset.list', payload: {} })
    })
    expect(presetList.status).toBe(200)

    for (const [method, payload] of [
      ['agentPreset.select', { sessionId: 'session-1', agentPreset: 'standard' }],
      ['session.models', { sessionId: 'session-1' }],
      [
        'session.selectModel',
        { sessionId: 'session-1', provider: 'provider-1', model: 'model-1' }
      ]
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${snapshot.port}/api/rpc`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ method, payload })
      })
      expect(response.status, method).toBe(200)
    }

    const sameBridge = await bridge.start()
    expect(sameBridge.port).toBe(snapshot.port)
    const stillAuthorized = await fetch(`http://127.0.0.1:${snapshot.port}/api/rpc`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'session.list', payload: {} })
    })
    expect(stillAuthorized.status).toBe(200)

    const desktopCookie = await authorizeDesktop(bridge)
    const status = await fetch(`http://127.0.0.1:${snapshot.port}/desktop/status`, {
      headers: { cookie: desktopCookie }
    })
    expect(await status.json()).toEqual({ connected: true })
    const managementPage = await fetch(`http://127.0.0.1:${snapshot.port}/desktop`, {
      headers: { cookie: desktopCookie }
    })
    expect(await managementPage.text()).toContain('Manage phone connection')
    const blockedModeSwitch = await fetch(
      `http://127.0.0.1:${snapshot.port}/desktop/tunnel/toggle`,
      {
        method: 'POST',
        headers: { cookie: desktopCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ enable: true })
      }
    )
    expect(blockedModeSwitch.status).toBe(409)
    expect(await blockedModeSwitch.json()).toEqual({
      ok: false,
      error: 'Disconnect the phone before switching connection modes.'
    })
    const mobileStatus = await fetch(`http://127.0.0.1:${snapshot.port}/api/status`, {
      headers: { cookie }
    })
    expect(mobileStatus.status).toBe(200)
    expect(await mobileStatus.json()).toEqual({ connected: true })
    const samePhoneHomeScreen = await fetch(
      `http://127.0.0.1:${snapshot.port}/api/status`
    )
    expect(samePhoneHomeScreen.status).toBe(200)
    expect(await samePhoneHomeScreen.json()).toEqual({ connected: true })

    const blocked = await fetch(`http://127.0.0.1:${snapshot.port}/api/rpc`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'host.openPath', payload: { path: '/tmp/secret' } })
    })
    expect(blocked.status).toBe(403)

    await fetch(`http://127.0.0.1:${snapshot.port}/desktop/disconnect`, {
      method: 'POST',
      headers: { cookie: desktopCookie }
    })
    const disconnected = await fetch(`http://127.0.0.1:${snapshot.port}/api/rpc`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'workspace.list', payload: {} })
    })
    expect(disconnected.status).toBe(401)
    const disconnectedStatus = await fetch(`http://127.0.0.1:${snapshot.port}/api/status`, {
      headers: { cookie }
    })
    expect(disconnectedStatus.status).toBe(401)
    const disconnectedHomeScreen = await fetch(
      `http://127.0.0.1:${snapshot.port}/api/status`
    )
    expect(disconnectedHomeScreen.status).toBe(401)
    const legacyHomeScreenCookie = `dsh_mobile=${'a'.repeat(43)}`
    const unknownHomeScreenBeforeApproval = await fetch(
      `http://127.0.0.1:${snapshot.port}/api/status`,
      { headers: { cookie: legacyHomeScreenCookie } }
    )
    expect(unknownHomeScreenBeforeApproval.status).toBe(401)

    const reconnectSnapshot = bridge.snapshot()
    const reconnectToken = new URL(reconnectSnapshot.pairingUrl!).searchParams.get('token')
    const reapproved = await fetch(
      `http://127.0.0.1:${snapshot.port}/pair?token=${reconnectToken}`,
      { redirect: 'manual' }
    )
    expect(reapproved.status).toBe(302)
    const newCookie = reapproved.headers.get('set-cookie')!.split(';', 1)[0]!

    const restoredHomeScreen = await fetch(
      `http://127.0.0.1:${snapshot.port}/api/status`,
      { headers: { cookie } }
    )
    expect(restoredHomeScreen.status).toBe(200)
    expect(await restoredHomeScreen.json()).toEqual({ connected: true })
    const newlyPairedSafari = await fetch(
      `http://127.0.0.1:${snapshot.port}/api/status`,
      { headers: { cookie: newCookie } }
    )
    expect(newlyPairedSafari.status).toBe(200)
    const homeScreenWithoutSharedCookies = await fetch(
      `http://127.0.0.1:${snapshot.port}/api/status`
    )
    expect(homeScreenWithoutSharedCookies.status).toBe(200)
    const restoredLegacyHomeScreen = await fetch(
      `http://127.0.0.1:${snapshot.port}/api/status`,
      { headers: { cookie: legacyHomeScreenCookie } }
    )
    expect(restoredLegacyHomeScreen.status).toBe(200)
    const lateHomeScreenCookie = `dsh_mobile=${'b'.repeat(43)}`
    const restoredAfterSafariPaired = await fetch(
      `http://127.0.0.1:${snapshot.port}/api/status`,
      { headers: { cookie: lateHomeScreenCookie } }
    )
    expect(restoredAfterSafariPaired.status).toBe(200)
  })

  it('adapts Harness 0.1.2 history records to the stable mobile page contract', async () => {
    let pageRequest: unknown
    const projections = {
      asOfSeq: 7,
      values: {
        todos: [{ content: 'Restore mobile history', status: 'in_progress' }]
      }
    }
    const records = [
      {
        type: 'event',
        event: { type: 'user/message', time: 1, content: [{ type: 'text', text: 'hello' }] }
      }
    ]
    const harness = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.statusCode = 404
        response.end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        rpcId: string
        method: string
        payload: { args: unknown }
      }
      const value = envelope.method === 'session/list'
        ? {
            items: [
              {
                sessionId: 'session-1',
                updatedAt: 1,
                running: false,
                blank: false,
                projections
              }
            ]
          }
        : { records, hasMore: false }
      if (envelope.method === 'session/page') pageRequest = envelope.payload.args
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        type: 'server-response',
        rpcId: envelope.rpcId,
        result: { ok: true, value }
      }))
    })
    servers.push(harness)
    await new Promise<void>((resolve) => harness.listen(0, '127.0.0.1', resolve))
    const harnessPort = (harness.address() as AddressInfo).port
    const bridge = new LanMobileBridge({
      harnessUrl: () => `http://127.0.0.1:${harnessPort}`
    })
    bridges.push(bridge)
    const { port, cookie } = await pairBridge(bridge)

    const history = await mobileRpc(port, cookie, 'session.history', {
      sessionId: 'session-1',
      maxMessages: 100
    })

    expect(history.status).toBe(200)
    expect(await history.json()).toEqual({
      ok: true,
      value: { events: records, projections, hasMore: false }
    })
    expect(pageRequest).toEqual({
      request: {
        address: { kind: 'session', sessionId: 'session-1' },
        throughSeq: 7,
        maxMessages: 100
      }
    })
  })

  it('streams native session follow snapshots and events to an authorized phone', async () => {
    let sessionOpen: unknown
    const harness = createServer((_request, response) => {
      response.statusCode = 404
      response.end()
    })
    const muxServer = new WebSocketServer({ noServer: true })
    webSocketServers.push(muxServer)
    harness.on('upgrade', (request, socket, head) => {
      if (request.url !== '/api/remote.mux') return socket.destroy()
      muxServer.handleUpgrade(request, socket, head, (client) => {
        const peer = client as TestWebSocket & {
          on(event: 'message', listener: (data: Buffer) => void): void
        }
        peer.on('message', (data) => {
          const opened = JSON.parse(data.toString('utf8')) as {
            streamId: string
            endpoint: string
            payload: unknown
          }
          if (opened.endpoint !== 'session/follow') return
          sessionOpen = opened.payload
          peer.send(JSON.stringify({
            type: 'item',
            streamId: opened.streamId,
            value: {
              type: 'snapshot',
              cursor: 2,
              records: [{ type: 'event', event: { type: 'user/message', seq: 2 } }],
              hasMore: false,
              projections: { asOfSeq: 2, values: {} }
            }
          }))
          peer.send(JSON.stringify({
            type: 'item',
            streamId: opened.streamId,
            value: { type: 'event', event: { type: 'assistant/chunk', seq: 3 } }
          }))
        })
      })
    })
    servers.push(harness)
    await new Promise<void>((resolve) => harness.listen(0, '127.0.0.1', resolve))
    const harnessPort = (harness.address() as AddressInfo).port
    const bridge = new LanMobileBridge({
      harnessUrl: () => `http://127.0.0.1:${harnessPort}`
    })
    bridges.push(bridge)
    const { port, cookie } = await pairBridge(bridge)
    const abort = new AbortController()
    const response = await fetch(
      `http://127.0.0.1:${port}/api/session/stream?sessionId=session-1`,
      { headers: { cookie }, signal: abort.signal }
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let body = ''
    await waitFor(async () => {
      const chunk = await reader.read()
      body += decoder.decode(chunk.value, { stream: true })
      return body.includes('event: snapshot') && body.includes('event: event')
    })
    abort.abort()
    expect(body).toContain('"type":"snapshot"')
    expect(body).toContain('"type":"assistant/chunk"')
    expect(sessionOpen).toEqual({
      args: {
        request: {
          address: { kind: 'session', sessionId: 'session-1' },
          maxMessages: 100
        }
      }
    })
  })

  it('does not crash when a session stream is aborted while the mux handshake is still connecting', async () => {
    // Regression guard for the permanent ws 'error' sink in streamSession.
    // Aborting the SSE request makes streamSession close its upstream mux
    // WebSocket; when the handshake never completed, `ws` then raises 'error'
    // asynchronously ("closed before the connection was established") after
    // cleanup() has removed the real listener. Without a permanent sink that
    // self-inflicted error becomes an unhandled 'error' event and takes the
    // whole process down (consumeMux documents the identical crash path).
    const upgraded: Duplex[] = []
    const harness = createServer((_request, response) => {
      response.statusCode = 404
      response.end()
    })
    // Swallow the upgrade: the mux socket stays CONNECTING on the bridge side.
    harness.on('upgrade', (request, socket) => {
      if (request.url !== '/api/remote.mux') return socket.destroy()
      upgraded.push(socket)
    })
    servers.push(harness)
    await new Promise<void>((resolve) => harness.listen(0, '127.0.0.1', resolve))
    const harnessPort = (harness.address() as AddressInfo).port
    const bridge = new LanMobileBridge({
      harnessUrl: () => `http://127.0.0.1:${harnessPort}`
    })
    bridges.push(bridge)
    const { port, cookie } = await pairBridge(bridge)
    const abort = new AbortController()
    const response = await fetch(
      `http://127.0.0.1:${port}/api/session/stream?sessionId=session-1`,
      { headers: { cookie }, signal: abort.signal }
    )
    expect(response.status).toBe(200)
    abort.abort()
    // Let the async 'error' (when present) fire; with the sink in place the
    // process survives and the request unwinds cleanly.
    await new Promise((resolve) => setTimeout(resolve, 100))
    for (const socket of upgraded) socket.destroy()
    expect(true).toBe(true)
  })
})

describe('LAN mobile bridge user questions', () => {
  it('replays pending questions and forwards the desktop answer protocol', async () => {
    const responses: unknown[] = []
    const muxClients: TestWebSocket[] = []
    const harness = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url === '/api/remote.mux') {
        response.statusCode = 426
        response.end()
        return
      }
      if (request.method === 'POST' && request.url === '/api/$events/result') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { rpcId: string }
        responses.push(envelope)
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          type: 'server-response',
          rpcId: envelope.rpcId,
          result: { ok: true, value: { accepted: true } }
        }))
        return
      }
      response.statusCode = 404
      response.end()
    })
    const muxServer = new WebSocketServer({ noServer: true })
    webSocketServers.push(muxServer)
    harness.on('upgrade', (request, socket, head) => {
      if (request.url !== '/api/remote.mux') return socket.destroy()
      muxServer.handleUpgrade(request, socket, head, (client) => {
        muxClients.push(client)
        // The carrier names the generation before anything else; the bridge
        // quotes that clientId when it settles an event.
        client.send(JSON.stringify({
          type: 'item',
          streamId: 'mobile-events',
          value: { type: 'ready', clientId: 'client-1', host: { home: '/home/test' } }
        }))
        client.send(JSON.stringify({
          type: 'item',
          streamId: 'mobile-workspaces',
          value: { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
        }))
        client.send(
          JSON.stringify({
            type: 'item',
            streamId: 'mobile-events',
            value: {
              type: 'waterfall',
              event: 'user-questions/request',
              eventId: 'question-rpc-1',
              agentId: 'session-1',
              request: {
              questions: [
                {
                  id: 'domain',
                  header: '领域确认',
                  question: '你说的持续学习指哪个领域？',
                  options: [
                    {
                      label: '机器学习中的 Continual Learning (推荐)',
                      description: '终身学习与抗灾难性遗忘'
                    },
                    { label: '教育学中的持续学习' }
                  ]
                }
              ]
              }
            }
          })
        )
      })
    })
    servers.push(harness)
    await new Promise<void>((resolve) => harness.listen(0, '127.0.0.1', resolve))
    const harnessPort = (harness.address() as AddressInfo).port
    const bridge = new LanMobileBridge({
      harnessUrl: () => `http://127.0.0.1:${harnessPort}`
    })
    bridges.push(bridge)
    const { port, cookie } = await pairBridge(bridge)

    const pending = await waitForRpcValue(port, cookie, 'interaction.pending', {
      sessionId: 'session-1'
    })
    expect(pending).toMatchObject({
      rpcId: 'question-rpc-1',
      sessionId: 'session-1',
      questions: [
        {
          id: 'domain',
          header: '领域确认',
          question: '你说的持续学习指哪个领域？'
        }
      ]
    })

    const answer = await mobileRpc(port, cookie, 'interaction.answer', {
      rpcId: 'question-rpc-1',
      sessionId: 'session-1',
      answers: [
        {
          id: 'domain',
          selected: ['机器学习中的 Continual Learning (推荐)']
        }
      ]
    })
    expect(answer.status).toBe(200)
    expect(answer.status).toBe(200)
    expect(responses).toEqual([
      {
        type: 'client-request',
        rpcId: expect.any(String),
        method: '$events/result',
        payload: {
          args: {
            clientId: 'client-1',
            eventId: 'question-rpc-1',
            outcome: {
              kind: 'result',
              value: {
                answers: [
                  {
                    id: 'domain',
                    selected: ['机器学习中的 Continual Learning (推荐)']
                  }
                ]
              }
            }
          }
        }
      }
    ])

    // Settling the event is the end of it. The old mux broadcast a separate
    // `question/resolved` that kept the Harness authoritative over when a
    // question cleared; the Gateway sends nothing after a result, so a
    // question that stayed pending here would never clear.
    await waitFor(async () => {
      const response = await mobileRpc(port, cookie, 'interaction.pending', {
        sessionId: 'session-1'
      })
      return (await response.json()).value === null
    })
  })

  it('opens the mux downlink only while a phone is attached', async () => {
    let upgrades = 0
    const harness = createServer((_request, response) => {
      response.statusCode = 404
      response.end()
    })
    const muxServer = new WebSocketServer({ noServer: true })
    webSocketServers.push(muxServer)
    harness.on('upgrade', (request, socket, head) => {
      if (request.url !== '/api/remote.mux') return socket.destroy()
      upgrades += 1
      muxServer.handleUpgrade(request, socket, head, () => undefined)
    })
    servers.push(harness)
    await new Promise<void>((resolve) => harness.listen(0, '127.0.0.1', resolve))
    const harnessPort = (harness.address() as AddressInfo).port
    const connectionEvents: boolean[] = []
    const bridge = new LanMobileBridge({
      harnessUrl: () => `http://127.0.0.1:${harnessPort}`,
      onConnectedChange: (connected) => connectionEvents.push(connected)
    })
    bridges.push(bridge)

    // A desktop that never pairs a phone has no consumer for the downlink, so
    // it must not sit there reconnecting to it for the life of the process.
    await bridge.start()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(upgrades).toBe(0)
    expect(connectionEvents).toEqual([])

    await pairBridge(bridge)
    await waitFor(async () => upgrades > 0)
    expect(connectionEvents).toEqual([true])

    await bridge.stop()
    expect(connectionEvents).toEqual([true, false])
  })

  it('rejects answers that were not offered by the pending question', async () => {
    const responses: unknown[] = []
    const harness = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url === '/api/remote.mux') {
        response.statusCode = 426
        response.end()
        return
      }
      if (request.method === 'POST' && request.url === '/api/$events/result') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { rpcId: string }
        responses.push(envelope)
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          type: 'server-response',
          rpcId: envelope.rpcId,
          result: { ok: true, value: { accepted: true } }
        }))
        return
      }
      response.statusCode = 404
      response.end()
    })
    const muxServer = new WebSocketServer({ noServer: true })
    webSocketServers.push(muxServer)
    harness.on('upgrade', (request, socket, head) => {
      if (request.url !== '/api/remote.mux') return socket.destroy()
      muxServer.handleUpgrade(request, socket, head, (client) => {
        client.send(JSON.stringify({
          type: 'item',
          streamId: 'mobile-events',
          value: { type: 'ready', clientId: 'client-2', host: { home: '/home/test' } }
        }))
        client.send(
          JSON.stringify({
            type: 'item',
            streamId: 'mobile-events',
            value: {
              type: 'waterfall',
              event: 'user-questions/request',
              eventId: 'question-rpc-2',
              agentId: 'session-2',
              request: {
                questions: [{ id: 'choice', question: '选择一个', options: [{ label: 'A' }] }]
              }
            }
          })
        )
      })
    })
    servers.push(harness)
    await new Promise<void>((resolve) => harness.listen(0, '127.0.0.1', resolve))
    const harnessPort = (harness.address() as AddressInfo).port
    const bridge = new LanMobileBridge({
      harnessUrl: () => `http://127.0.0.1:${harnessPort}`
    })
    bridges.push(bridge)
    const { port, cookie } = await pairBridge(bridge)
    await waitForRpcValue(port, cookie, 'interaction.pending', { sessionId: 'session-2' })
    const answer = await mobileRpc(port, cookie, 'interaction.answer', {
      rpcId: 'question-rpc-2',
      sessionId: 'session-2',
      answers: [{ id: 'choice', selected: ['B'] }]
    })
    expect(answer.status).toBe(500)
    expect(await answer.json()).toMatchObject({ ok: false, error: 'Answer contains an unknown option.' })

    const cancel = await mobileRpc(port, cookie, 'interaction.cancel', {
      rpcId: 'question-rpc-2',
      sessionId: 'session-2'
    })
    expect(cancel.status).toBe(200)
    expect(responses).toEqual([
      {
        type: 'client-request',
        rpcId: expect.any(String),
        method: '$events/result',
        payload: {
          args: {
            clientId: 'client-2',
            eventId: 'question-rpc-2',
            outcome: {
              kind: 'rejected',
              error: {
                name: 'Error',
                code: 'cancelled',
                message: 'the user closed this question request'
              }
            }
          }
        }
      }
    ])
  })
})

describe('mobile idle efficiency', () => {
  it('reuses one session/list serialization and history page per poll burst and rebuilds on expiry and mutation', async () => {
    let listCount = 0
    let pageCount = 0
    let promptCount = 0
    const projections = { asOfSeq: 7, values: {} }
    const records = [{ type: 'event', event: { type: 'user/message', time: 1 } }]
    const harness = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.statusCode = 404
        response.end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        rpcId: string
        method: string
      }
      let value: unknown
      if (envelope.method === 'session/list') {
        listCount += 1
        value = { items: [{ sessionId: 'session-1', updatedAt: 1, running: false, blank: false, projections }] }
      } else if (envelope.method === 'session/page') {
        pageCount += 1
        value = { records, hasMore: false }
      } else if (envelope.method === 'session/prompt') {
        promptCount += 1
        value = {}
      } else {
        value = {}
      }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        type: 'server-response',
        rpcId: envelope.rpcId,
        result: { ok: true, value }
      }))
    })
    servers.push(harness)
    await new Promise<void>((resolve) => harness.listen(0, '127.0.0.1', resolve))
    const harnessPort = (harness.address() as AddressInfo).port
    let now = Date.now()
    const bridge = new LanMobileBridge({
      harnessUrl: () => `http://127.0.0.1:${harnessPort}`,
      now: () => now
    })
    bridges.push(bridge)
    const { port, cookie } = await pairBridge(bridge)
    const history = () =>
      mobileRpc(port, cookie, 'session.history', { sessionId: 'session-1', maxMessages: 100 })

    // A burst of polls costs one serialization and one page fetch.
    await history()
    await history()
    expect(listCount).toBe(1)
    expect(pageCount).toBe(1)

    // Beyond the short TTL the list (shared by session.list) is rebuilt once,
    // and the expired history page with it.
    now += 751
    const firstList = await mobileRpc(port, cookie, 'session.list', {})
    const secondList = await mobileRpc(port, cookie, 'session.list', {})
    expect(firstList.status).toBe(200)
    expect(await secondList.json()).toEqual(await firstList.clone().json())
    expect(listCount).toBe(2)
    await history()
    expect(listCount).toBe(2)
    expect(pageCount).toBe(2)

    // A forwarded mutation invalidates immediately: the next poll refetches.
    const prompt = await mobileRpc(port, cookie, 'session.prompt', {
      sessionId: 'session-1',
      mode: 'steer',
      content: [{ type: 'text', text: 'go' }]
    })
    expect(prompt.status).toBe(200)
    expect(promptCount).toBe(1)
    await history()
    expect(listCount).toBe(3)
    expect(pageCount).toBe(3)
  })

  it('drops the workspace baseline when the mux drops so the next poll rebuilds it', async () => {
    const muxClients: (TestWebSocket & { close(): void })[] = []
    const harness = createServer((_request, response) => {
      response.statusCode = 404
      response.end()
    })
    const muxServer = new WebSocketServer({ noServer: true })
    webSocketServers.push(muxServer)
    harness.on('upgrade', (request, socket, head) => {
      if (request.url !== '/api/remote.mux') return socket.destroy()
      muxServer.handleUpgrade(request, socket, head, (client) => {
        muxClients.push(client as TestWebSocket & { close(): void })
        client.send(JSON.stringify({
          type: 'item',
          streamId: 'mobile-workspaces',
          value: { type: 'baseline', value: { items: [{ workspaceId: 'ws-1' }], archivedSessionIds: [] } }
        }))
      })
    })
    servers.push(harness)
    await new Promise<void>((resolve) => harness.listen(0, '127.0.0.1', resolve))
    const harnessPort = (harness.address() as AddressInfo).port
    const bridge = new LanMobileBridge({
      harnessUrl: () => `http://127.0.0.1:${harnessPort}`
    })
    bridges.push(bridge)
    const { port, cookie } = await pairBridge(bridge)

    await waitFor(async () => {
      const response = await mobileRpc(port, cookie, 'workspace.list', {})
      return (await response.json()).ok === true
    })

    // A carrier that delivered data and died leaves nothing stale behind.
    muxClients.forEach((client) => client.close())
    await waitFor(async () => {
      const response = await mobileRpc(port, cookie, 'workspace.list', {})
      return (await response.json()).ok === false
    })
    const stale = await mobileRpc(port, cookie, 'workspace.list', {})
    expect(await stale.json()).toMatchObject({
      ok: false,
      error: 'Harness workspaces are not loaded yet.'
    })

    // A phone is still attached, so the monitor reconnects and the opening
    // baseline repopulates the snapshot.
    await waitFor(async () => {
      const response = await mobileRpc(port, cookie, 'workspace.list', {})
      return (await response.json()).ok === true
    }, 5000)
  })

  it('bounds pending pairing requests by count and age', async () => {
    let now = Date.now()
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9999',
      now: () => now
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    const pendingPairings = () =>
      (bridge as unknown as { pendingPairings?: Map<string, unknown> }).pendingPairings
    const reconnectFrom = (address: string) =>
      fetch(`http://127.0.0.1:${snapshot.port}/reconnect`, {
        headers: { 'cf-connecting-ip': address, 'cf-ray': `ray-${address}` }
      })

    // The fork used to bound a `pendingPairings` map here; Harness 0.1.7
    // replaced the pairing-wait/approval flow with direct LAN cookie pairing
    // and the tunnel PIN page, so /reconnect records no per-address state at
    // all and the unbounded accumulation the cap guarded against cannot
    // happen. Assert the superseding behavior instead.
    for (let i = 1; i <= 24; i++) await reconnectFrom(`203.0.113.${i}`)
    expect(pendingPairings()).toBeUndefined()

    // After expiry the reconnect page still renders from the durable PIN and
    // still records nothing per address.
    now += 5 * 60 * 1000 + 1
    const expired = await reconnectFrom('203.0.114.1')
    expect(expired.status).toBe(200)
    expect(await expired.text()).toContain('Reconnect DSH')
    expect(pendingPairings()).toBeUndefined()
  })

  it('ends the session stream once buffered SSE backpressure exceeds the cap', async () => {
    const frameText = 'x'.repeat(256 * 1024)
    let peerClosed = false
    const harness = createServer((_request, response) => {
      response.statusCode = 404
      response.end()
    })
    const muxServer = new WebSocketServer({ noServer: true })
    webSocketServers.push(muxServer)
    harness.on('upgrade', (request, socket, head) => {
      if (request.url !== '/api/remote.mux') return socket.destroy()
      muxServer.handleUpgrade(request, socket, head, (client) => {
        const peer = client as TestWebSocket & {
          on(event: 'message', listener: (data: Buffer) => void): void
          on(event: 'close', listener: () => void): void
        }
        peer.on('close', () => {
          peerClosed = true
        })
        peer.on('message', (data) => {
          const opened = JSON.parse(data.toString('utf8')) as {
            streamId: string
            endpoint: string
          }
          if (opened.endpoint !== 'session/follow') return
          const frame = JSON.stringify({
            type: 'item',
            streamId: opened.streamId,
            value: {
              type: 'event',
              event: { type: 'assistant/chunk', chunk: { type: 'text-delta', text: frameText } }
            }
          })
          // ~8MB of SSE frames toward a phone that stopped reading.
          for (let i = 0; i < 32; i++) peer.send(frame)
        })
      })
    })
    servers.push(harness)
    await new Promise<void>((resolve) => harness.listen(0, '127.0.0.1', resolve))
    const harnessPort = (harness.address() as AddressInfo).port
    const bridge = new LanMobileBridge({
      harnessUrl: () => `http://127.0.0.1:${harnessPort}`
    })
    bridges.push(bridge)
    const { port, cookie } = await pairBridge(bridge)

    // A stalled phone: the SSE response is opened but never drained.
    let clientResponse: IncomingMessage | undefined
    const drained = new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/api/session/stream?sessionId=session-bp',
          headers: { cookie }
        },
        (response) => {
          clientResponse = response
          response.pause()
          let bytes = 0
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length
          })
          response.on('end', () => resolve(bytes))
          response.on('error', reject)
        }
      )
      request.on('error', reject)
      request.end()
    })

    // The bridge cuts the stream, which closes the upstream mux socket.
    await waitFor(async () => peerClosed, 5000)
    clientResponse!.resume()
    const received = await drained
    const pushedBytes = 32 * (frameText.length + 128)
    expect(received).toBeLessThan(pushedBytes)
  })

  it('threads supervised tunnel state changes into the snapshot with LAN fallback', async () => {
    let fireState: ((state: TunnelRuntimeState) => void) | undefined
    let tunnelStopped = false
    // Mirror the committed supervisor contract: the instance's `url` getter is
    // the state channel (live URL while connected, undefined while down).
    let instanceUrl: string | undefined = 'https://first.trycloudflare.com'
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9999',
      createCloudflareTunnel: async (_port, hooks) => {
        fireState = hooks.onStateChange
        return {
          provider: 'cloudflare',
          get url() {
            return instanceUrl
          },
          process: {},
          stop: async () => {
            tunnelStopped = true
          }
        } as InternetTunnelInstance
      }
    })
    bridges.push(bridge)
    await bridge.start()
    await bridge.toggleTunnel(true)
    expect(bridge.snapshot().tunnelActive).toBe(true)

    // The tunnel child dies: the snapshot flips to down, the error surfaces,
    // and no dead URL is advertised (pairing falls back to the LAN address).
    instanceUrl = undefined
    fireState!({
      provider: 'cloudflare',
      active: false,
      error: 'cloudflare tunnel process exited unexpectedly (code 1)'
    })
    const down = bridge.snapshot()
    expect(down.tunnelActive).toBe(false)
    expect(down.tunnelError).toContain('exited unexpectedly')
    expect(down.tunnelUrl).toBeUndefined()

    // A relaunch recovers: active again, error cleared, replacement URL live.
    instanceUrl = 'https://second.trycloudflare.com'
    fireState!({
      provider: 'cloudflare',
      active: true,
      url: 'https://second.trycloudflare.com'
    })
    const recovered = bridge.snapshot()
    expect(recovered.tunnelActive).toBe(true)
    expect(recovered.tunnelError).toBeUndefined()
    expect(recovered.tunnelUrl).toBe('https://second.trycloudflare.com')

    // After the host stops the tunnel, a late report from the replaced
    // instance cannot resurrect its state in the snapshot.
    await bridge.toggleTunnel(false)
    expect(tunnelStopped).toBe(true)
    fireState!({
      provider: 'cloudflare',
      active: true,
      url: 'https://zombie.trycloudflare.com'
    })
    const afterStop = bridge.snapshot()
    expect(afterStop.tunnelActive).toBe(false)
    expect(afterStop.tunnelUrl).toBeUndefined()
  })
})
async function authorizeDesktop(bridge: LanMobileBridge): Promise<string> {
  const url = bridge.createDesktopUrl()
  expect(url).toBeTruthy()
  const bootstrap = await fetch(url!, { redirect: 'manual' })
  expect(bootstrap.status).toBe(303)
  expect(bootstrap.headers.get('location')).toBe('/desktop')
  const setCookie = bootstrap.headers.get('set-cookie') ?? ''
  expect(setCookie).toContain('HttpOnly')
  expect(setCookie).toContain('SameSite=Strict')
  return setCookie.split(';', 1)[0]!
}

async function pairBridge(bridge: LanMobileBridge): Promise<{ port: number; cookie: string }> {
  const snapshot = await bridge.start()
  const token = new URL(snapshot.pairingUrl!).searchParams.get('token')
  const paired = await fetch(`http://127.0.0.1:${snapshot.port}/pair?token=${token}`, {
    redirect: 'manual'
  })
  return {
    port: snapshot.port!,
    cookie: paired.headers.get('set-cookie')!.split(';', 1)[0]!
  }
}

function requestStatus(
  port: number,
  path: string,
  headers: Record<string, string>
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path, headers },
      (response) => {
        response.resume()
        response.once('end', () => resolve(response.statusCode))
      }
    )
    request.once('error', reject)
    request.end()
  })
}

function mobileRpc(
  port: number,
  cookie: string,
  method: string,
  payload: unknown
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/rpc`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ method, payload })
  })
}

async function waitForRpcValue(
  port: number,
  cookie: string,
  method: string,
  payload: unknown
): Promise<unknown> {
  let value: unknown = null
  await waitFor(async () => {
    const response = await mobileRpc(port, cookie, method, payload)
    value = (await response.json()).value
    return value !== null
  })
  return value
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for condition.')
}
describe('snapshot keeps tunnel state after the pairing token is consumed', () => {
  it('reports an active tunnel through status and toggle endpoints once the token is consumed', async () => {
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9999'
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()

    // Simulate the post-approval state: the single-use pairing token is gone,
    // no phone session is active, but a tunnel keeps running.
    Object.assign(bridge as unknown as Record<string, unknown>, {
      pairingToken: undefined,
      pairingExpiresAt: undefined,
      tunnelActive: true,
      tunnelInstance: {
        url: 'https://post-pair.trycloudflare.com',
        process: {},
        stop: async () => undefined
      }
    })

    const desktopCookie = await authorizeDesktop(bridge)
    const status = await fetch(`http://127.0.0.1:${snapshot.port}/desktop/tunnel/status`, {
      headers: { cookie: desktopCookie }
    })
    const statusJson = await status.json()
    expect(statusJson.active).toBe(true)
    expect(statusJson.url).toBe('https://post-pair.trycloudflare.com')

    const toggle = await fetch(`http://127.0.0.1:${snapshot.port}/desktop/tunnel/toggle`, {
      method: 'POST',
      headers: {
        cookie: desktopCookie,
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${snapshot.port}`
      },
      body: JSON.stringify({ enable: true })
    })
    expect(toggle.status).toBe(200)
    const toggleJson = await toggle.json()
    expect(toggleJson.ok).toBe(true)
    expect(toggleJson.active).toBe(true)
    expect(toggleJson.url).toBe('https://post-pair.trycloudflare.com')
  })

  it('serves the desktop page with a fresh pairing token after approval or expiry', async () => {
    let now = Date.now()
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9999',
      now: () => now
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    const desktopCookie = await authorizeDesktop(bridge)
    const before = await fetch(snapshot.desktopUrl!, { headers: { cookie: desktopCookie } })
    expect(before.status).toBe(200)

    const token = new URL(snapshot.pairingUrl!).searchParams.get('token')
    await fetch(`http://127.0.0.1:${snapshot.port}/pair?token=${token}`, { redirect: 'manual' })

    const afterApproval = await fetch(snapshot.desktopUrl!, { headers: { cookie: desktopCookie } })
    expect(afterApproval.status).toBe(200)
    const html = await afterApproval.text()
    expect(html).toContain('/pair?token=')

    // Let the (rotated) token expire: the desktop page must rotate again
    // instead of rendering a dead QR code.
    now += 5 * 60 * 1000 + 1
    const afterExpiry = await fetch(snapshot.desktopUrl!, { headers: { cookie: desktopCookie } })
    expect(afterExpiry.status).toBe(200)
    const fresh = await bridge.snapshot()
    expect(fresh.pairingUrl).toBeTruthy()
    expect(fresh.expiresAt!).toBeGreaterThan(now)
  })
})

describe('pairing token boundary and desktop origin hardening', () => {
  it('treats now === expiresAt as still valid and does not rotate', async () => {
    let now = Date.now()
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9999',
      now: () => now
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    const tokenBefore = snapshot.pairingUrl

    now = snapshot.expiresAt!
    const atBoundary = bridge.snapshot()
    expect(atBoundary.pairingUrl).toBeTruthy()
    expect(atBoundary.expiresAt).toBe(now)
    // /desktop must not rotate at exactly the expiry instant.
    const desktopCookie = await authorizeDesktop(bridge)
    const page = await fetch(snapshot.desktopUrl!, { headers: { cookie: desktopCookie } })
    expect(page.status).toBe(200)
    const rotated = bridge.snapshot()
    expect(rotated.pairingUrl).toBe(tokenBefore)
  })

  it('rejects cross-site browser requests to desktop endpoints', async () => {
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9999'
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    const base = `http://127.0.0.1:${snapshot.port}`
    const origin = `http://127.0.0.1:${snapshot.port}`

    const desktopCookie = await authorizeDesktop(bridge)
    const crossSiteGet = await fetch(`${base}/desktop`, {
      headers: { cookie: desktopCookie, 'sec-fetch-site': 'cross-site' }
    })
    expect(crossSiteGet.status).toBe(500)
    expect(await crossSiteGet.text()).toContain('Cross-site request rejected')

    const crossOriginPost = await fetch(`${base}/desktop/disconnect`, {
      method: 'POST',
      headers: { cookie: desktopCookie, origin: 'https://evil.example.com' }
    })
    expect(crossOriginPost.status).toBe(500)

    // Same-origin and no-header requests keep working (local tooling, tests).
    const sameOrigin = await fetch(`${base}/desktop`, {
      headers: { cookie: desktopCookie, 'sec-fetch-site': 'same-origin', origin }
    })
    expect(sameOrigin.status).toBe(200)
    const noHeaders = await fetch(`${base}/desktop`, { headers: { cookie: desktopCookie } })
    expect(noHeaders.status).toBe(200)
  })
})

function memoryPinStore(initial: { pin?: string; pinConsent?: boolean } = {}) {
  let state = { ...initial }
  return {
    load: () => ({ ...state }),
    save: (next: { pin?: string; pinConsent?: boolean }) => {
      state = { ...next }
      return true
    }
  }
}

function armFakeTunnel(
  bridge: LanMobileBridge,
  url = 'https://active-mobile.trycloudflare.com',
  provider: 'cloudflare' | 'pinggy' = 'cloudflare'
): { emitClose: () => void } {
  const listeners: Array<() => void> = []
  const process = {
    once: (_event: string, listener: () => void) => {
      listeners.push(listener)
      return process
    }
  }
  Object.assign(bridge as unknown as Record<string, unknown>, {
    tunnelActive: true,
    tunnelInstance: {
      provider,
      url,
      process,
      stop: async () => undefined
    }
  })
  return {
    emitClose: () => {
      for (const listener of listeners) listener()
    }
  }
}

describe('LAN vs tunnel pairing authorization', () => {
  it('issues a LAN session cookie immediately and never puts the pin in snapshot', async () => {
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9999'
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    expect(snapshot).not.toHaveProperty('pairingPin')
    const token = new URL(snapshot.pairingUrl!).searchParams.get('token')
    const paired = await fetch(`http://127.0.0.1:${snapshot.port}/pair?token=${token}`, {
      redirect: 'manual'
    })
    expect(paired.status).toBe(302)
    expect(paired.headers.get('set-cookie')).toContain('HttpOnly')
    expect(paired.headers.get('set-cookie')).not.toContain('Secure')
    expect(bridge.snapshot()).not.toHaveProperty('pairingPin')
  })

  it('redirects a LAN /pair request to the active tunnel host', async () => {
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9999'
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    armFakeTunnel(bridge)
    const token = new URL(bridge.snapshot().pairingUrl ?? snapshot.pairingUrl!).searchParams.get(
      'token'
    )
    const migrated = await fetch(`http://127.0.0.1:${snapshot.port}/pair?token=${token}`, {
      redirect: 'manual'
    })
    expect(migrated.status).toBe(302)
    expect(migrated.headers.get('location')).toBe(
      `https://active-mobile.trycloudflare.com/pair?token=${token}`
    )
  })

  it('does not expose the pairing pin on desktop routes from a tunnel request', async () => {
    const store = memoryPinStore({ pin: '246810', pinConsent: true })
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9999',
      pairingPinStore: store
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    armFakeTunnel(bridge)

    const desktopCookie = await authorizeDesktop(bridge)
    const localStatus = await fetch(`http://127.0.0.1:${snapshot.port}/desktop/tunnel/status`, {
      headers: { cookie: desktopCookie }
    })
    expect(localStatus.status).toBe(200)
    expect(await localStatus.json()).toMatchObject({ pairingPin: '246810' })

    const spoofedHeaders = {
      host: 'active-mobile.trycloudflare.com',
      'cf-connecting-ip': '127.0.0.1',
      'cf-ray': 'test-ray',
      'x-forwarded-for': '127.0.0.1'
    }
    const desktop = await fetch(`http://127.0.0.1:${snapshot.port}/desktop`, {
      headers: spoofedHeaders
    })
    expect(desktop.status).toBe(403)
    expect(await desktop.text()).not.toContain('246810')

    const tunnelStatus = await fetch(`http://127.0.0.1:${snapshot.port}/desktop/tunnel/status`, {
      headers: spoofedHeaders
    })
    expect(tunnelStatus.status).toBe(403)
    expect(await tunnelStatus.text()).not.toContain('246810')
  })

  it('requires a PIN on the tunnel and ignores a sibling device on the same public IP', async () => {
    const store = memoryPinStore({ pin: '246810', pinConsent: true })
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9999',
      pairingPinStore: store
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    armFakeTunnel(bridge)
    const token = new URL(bridge.snapshot().pairingUrl ?? `http://x/pair?token=missing`).searchParams.get(
      'token'
    )
    const headers = {
      host: 'active-mobile.trycloudflare.com',
      'cf-connecting-ip': '203.0.113.40',
      'cf-ray': 'test-ray'
    }
    const pinPage = await fetch(`http://127.0.0.1:${snapshot.port}/pair?token=${token}`, { headers })
    expect(await pinPage.text()).toContain('Enter pairing password')
    expect(pinPage.headers.get('set-cookie')).toBeNull()

    const wrong = await fetch(`http://127.0.0.1:${snapshot.port}/pair/verify`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '000000' })
    })
    expect(wrong.status).toBe(401)

    const verified = await fetch(`http://127.0.0.1:${snapshot.port}/pair/verify`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '246810' })
    })
    expect(verified.status).toBe(200)
    const cookie = verified.headers.get('set-cookie')!
    expect(cookie).toContain('Secure')

    const sibling = await fetch(`http://127.0.0.1:${snapshot.port}/api/status`, { headers })
    expect(sibling.status).toBe(401)
    const owner = await fetch(`http://127.0.0.1:${snapshot.port}/api/status`, {
      headers: { ...headers, cookie: cookie.split(';', 1)[0]! }
    })
    expect(owner.status).toBe(200)
  })

  it('rate-limits PIN guesses per IP and globally', async () => {
    const store = memoryPinStore({ pin: '111111', pinConsent: true })
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9999',
      pairingPinStore: store
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    armFakeTunnel(bridge)
    const headers = {
      host: 'active-mobile.trycloudflare.com',
      'cf-connecting-ip': '203.0.113.41',
      'cf-ray': 'test-ray',
      'content-type': 'application/json'
    }
    for (let i = 0; i < 4; i++) {
      const response = await fetch(`http://127.0.0.1:${snapshot.port}/pair/verify`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ pin: '000000' })
      })
      expect(response.status).toBe(401)
    }
    const fifth = await fetch(`http://127.0.0.1:${snapshot.port}/pair/verify`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ pin: '000000' })
    })
    expect(fifth.status).toBe(429)
    const limited = await fetch(`http://127.0.0.1:${snapshot.port}/pair/verify`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ pin: '111111' })
    })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBeTruthy()
  })

  it('does not mint a new temporary PIN from /reconnect or /pair/verify after expiry', async () => {
    let now = Date.now()
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9999',
      now: () => now
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    armFakeTunnel(bridge)
    const desktopCookie = await authorizeDesktop(bridge)
    const status = await fetch(`http://127.0.0.1:${snapshot.port}/desktop/tunnel/status`, {
      headers: { cookie: desktopCookie }
    })
    const created = (await status.json()) as { pairingPin: string }
    expect(created.pairingPin).toMatch(/^\d{6}$/)
    now += 5 * 60 * 1000 + 1
    const reconnect = await fetch(`http://127.0.0.1:${snapshot.port}/reconnect`, {
      headers: {
        host: 'active-mobile.trycloudflare.com',
        'cf-connecting-ip': '203.0.113.9',
        'cf-ray': 'test-ray'
      }
    })
    expect(await reconnect.text()).toContain('Scan the new QR code')
    const verify = await fetch(`http://127.0.0.1:${snapshot.port}/pair/verify`, {
      method: 'POST',
      headers: {
        host: 'active-mobile.trycloudflare.com',
        'cf-connecting-ip': '203.0.113.9',
        'cf-ray': 'test-ray',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ pin: created.pairingPin })
    })
    expect(verify.status).toBe(401)
    expect(await verify.json()).toMatchObject({ rescan: true })
    const again = await fetch(`http://127.0.0.1:${snapshot.port}/reconnect`, {
      headers: {
        host: 'active-mobile.trycloudflare.com',
        'cf-connecting-ip': '203.0.113.9',
        'cf-ray': 'test-ray'
      }
    })
    expect(await again.text()).toContain('Scan the new QR code')
  })

  it('revokes existing sessions when the durable PIN is reset', async () => {
    const store = memoryPinStore({ pin: '654321', pinConsent: true })
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9999',
      pairingPinStore: store
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    armFakeTunnel(bridge)
    const cookie = (
      await fetch(`http://127.0.0.1:${snapshot.port}/pair/verify`, {
        method: 'POST',
        headers: {
          host: 'active-mobile.trycloudflare.com',
          'cf-connecting-ip': '203.0.113.10',
          'cf-ray': 'test-ray',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ pin: '654321' })
      })
    ).headers.get('set-cookie')!.split(';', 1)[0]!
    const desktopCookie = await authorizeDesktop(bridge)
    const reset = await fetch(`http://127.0.0.1:${snapshot.port}/desktop/pin/reset`, {
      method: 'POST',
      headers: { cookie: desktopCookie }
    })
    const body = (await reset.json()) as { ok: boolean; pairingPin: string }
    expect(body.ok).toBe(true)
    expect(body.pairingPin).not.toBe('654321')
    const stale = await fetch(`http://127.0.0.1:${snapshot.port}/api/status`, {
      headers: {
        host: 'active-mobile.trycloudflare.com',
        'cf-connecting-ip': '203.0.113.10',
        'cf-ray': 'test-ray',
        cookie
      }
    })
    expect(stale.status).toBe(401)
  })

  it('clears tunnel sessions on unexpected close and allows a later toggle', async () => {
    const store = memoryPinStore({ pin: '777777', pinConsent: true })
    const events: boolean[] = []
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9999',
      pairingPinStore: store,
      createCloudflareTunnel: async () =>
        ({
          provider: 'cloudflare',
          url: 'https://second.trycloudflare.com',
          process: { once: () => undefined },
          stop: async () => undefined
        }) as never,
      onConnectedChange: (connected) => events.push(connected)
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    const armed = armFakeTunnel(bridge)
    ;(bridge as unknown as { armTunnelProcess: (instance: unknown) => void }).armTunnelProcess(
      (bridge as unknown as { tunnelInstance: unknown }).tunnelInstance
    )
    await fetch(`http://127.0.0.1:${snapshot.port}/pair/verify`, {
      method: 'POST',
      headers: {
        host: 'active-mobile.trycloudflare.com',
        'cf-connecting-ip': '203.0.113.11',
        'cf-ray': 'test-ray',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ pin: '777777' })
    })
    expect(bridge.snapshot().connected).toBe(true)
    armed.emitClose()
    expect(bridge.snapshot().tunnelActive).toBe(false)
    expect(bridge.snapshot().connected).toBe(false)
    const desktopCookie = await authorizeDesktop(bridge)
    const status = await fetch(`http://127.0.0.1:${snapshot.port}/desktop/tunnel/status`, {
      headers: { cookie: desktopCookie }
    })
    expect(await status.json()).toMatchObject({
      unexpectedlyClosed: true,
      provider: 'cloudflare'
    })
    const toggled = await fetch(`http://127.0.0.1:${snapshot.port}/desktop/tunnel/toggle`, {
      method: 'POST',
      headers: { cookie: desktopCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ enable: true })
    })
    expect(toggled.status).toBe(200)
    expect(await toggled.json()).toMatchObject({ active: true, unexpectedlyClosed: false })
    expect(events.at(-1)).toBe(false)
  })

  it('does not promote a fabricated cookie over a tunnel even when the IP already has a session', async () => {
    const store = memoryPinStore({ pin: '246810', pinConsent: true })
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9999',
      pairingPinStore: store
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    armFakeTunnel(bridge)
    const headers = {
      host: 'active-mobile.trycloudflare.com',
      'cf-connecting-ip': '203.0.113.40',
      'cf-ray': 'test-ray'
    }
    const verified = await fetch(`http://127.0.0.1:${snapshot.port}/pair/verify`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '246810' })
    })
    expect(verified.status).toBe(200)
    const fabricated = 'A'.repeat(43)
    const sibling = await fetch(`http://127.0.0.1:${snapshot.port}/api/status`, {
      headers: { ...headers, cookie: `dsh_mobile=${fabricated}` }
    })
    expect(sibling.status).toBe(401)
  })

  it('keeps /desktop closed without a desktop session even if Host claims loopback', async () => {
    const store = memoryPinStore({ pin: '246810', pinConsent: true })
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9999',
      pairingPinStore: store
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    const open = await fetch(`http://127.0.0.1:${snapshot.port}/desktop`)
    expect(open.status).toBe(403)
    expect(await open.text()).not.toContain('246810')

    const pinggySpoof = await fetch(`http://127.0.0.1:${snapshot.port}/desktop`, {
      headers: {
        host: '127.0.0.1',
        'x-forwarded-for': '203.0.113.50'
      }
    })
    expect(pinggySpoof.status).toBe(403)
    expect(await pinggySpoof.text()).not.toContain('246810')
  })

  it('exchanges a one-time desktop bootstrap token for a session cookie', async () => {
    const store = memoryPinStore({ pin: '246810', pinConsent: true })
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9999',
      pairingPinStore: store
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    armFakeTunnel(bridge)
    const bootstrapUrl = bridge.createDesktopUrl()
    expect(bootstrapUrl).toContain('/desktop?k=')
    expect(snapshot.desktopUrl).not.toContain('k=')

    const bootstrap = await fetch(bootstrapUrl!, { redirect: 'manual' })
    expect(bootstrap.status).toBe(303)
    expect(bootstrap.headers.get('location')).toBe('/desktop')
    const setCookie = bootstrap.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('dsh_desktop=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    const cookie = setCookie.split(';', 1)[0]!

    const replay = await fetch(bootstrapUrl!, { redirect: 'manual' })
    expect(replay.status).toBe(403)

    const page = await fetch(`http://127.0.0.1:${snapshot.port}/desktop`, {
      headers: { cookie }
    })
    expect(page.status).toBe(200)

    const status = await fetch(`http://127.0.0.1:${snapshot.port}/desktop/tunnel/status`, {
      headers: { cookie }
    })
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({ pairingPin: '246810' })

    const fabricated = await fetch(`http://127.0.0.1:${snapshot.port}/desktop/tunnel/status`, {
      headers: { cookie: `dsh_desktop=${'B'.repeat(43)}` }
    })
    expect(fabricated.status).toBe(403)
    expect(await fabricated.text()).not.toContain('246810')
  })
})
