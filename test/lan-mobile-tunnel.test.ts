import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { LanMobileBridge } from '../src/main/mobile/lan-mobile-bridge'
import {
  CLOUDFLARED_ASSETS,
  CLOUDFLARED_DOWNLOAD_ATTEMPTS,
  CLOUDFLARED_VERSION,
  downloadCloudflaredWithRetry,
  ensureCloudflaredBinary,
  extractTryCloudflareUrl,
  isRetryableDownloadError,
  resolveCurrentAssetSpec,
  sha256OfFile,
  startCloudflareQuickTunnel,
  terminateChildProcess,
  type CloudflareQuickTunnelOptions
} from '../src/main/mobile/cloudflared-tunnel'
import {
  buildPinggySshArgs,
  ensurePinggyIdentity,
  extractPinggyUrl,
  PINGGY_HOST,
  PINGGY_USER,
  pinggyIdentityPath,
  startPinggyTunnel,
  type PinggyTunnelOptions
} from '../src/main/mobile/pinggy-tunnel'
import {
  startTunnelWithFallback,
  superviseTunnel,
  tunnelRelaunchDelayMs,
  TUNNEL_RELAUNCH_MAX_ATTEMPTS,
  TUNNEL_RELAUNCH_MAX_MS,
  TUNNEL_RELAUNCH_START_MS,
  watchPostConnectExit,
  type InternetTunnelInstance,
  type TunnelChildProcess,
  type TunnelExitDetail,
  type TunnelRuntimeState
} from '../src/main/mobile/internet-tunnel'

const bridges: LanMobileBridge[] = []
const harnessServers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()))
  await Promise.all(
    harnessServers.splice(0).map((server) => {
      server.closeAllConnections()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    })
  )
})

describe('Cloudflare Quick Tunnel utilities', () => {
  it('extracts trycloudflare URLs from realistic log streams', () => {
    const log1 = '2026-08-21T09:12:34Z INF | Your quick Tunnel has been created! Visit it at: https://orange-forest-1234.trycloudflare.com |'
    const log2 = 'INF +--------------------------------------------------------------------------------------------+\nINF |  https://my-tunnel-preview-abc-xyz.trycloudflare.com                                         |\nINF +--------------------------------------------------------------------------------------------+'
    const log3 = 'no url here'

    expect(extractTryCloudflareUrl(log1)).toBe('https://orange-forest-1234.trycloudflare.com')
    expect(extractTryCloudflareUrl(log2)).toBe('https://my-tunnel-preview-abc-xyz.trycloudflare.com')
    expect(extractTryCloudflareUrl(log3)).toBeNull()
    expect(
      extractTryCloudflareUrl(
        'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": connection reset'
      )
    ).toBeNull()
  })

  it('resolves supported platform and arch specs', () => {
    const darwinArm = resolveCurrentAssetSpec('darwin', 'arm64')
    expect(darwinArm?.spec.asset).toBe('cloudflared-darwin-arm64.tgz')
    expect(darwinArm?.spec.isTarGz).toBe(true)

    const winX64 = resolveCurrentAssetSpec('win32', 'x64')
    expect(winX64?.spec.asset).toBe('cloudflared-windows-amd64.exe')
    expect(winX64?.spec.isTarGz).toBe(false)

    const linuxArm64 = resolveCurrentAssetSpec('linux', 'arm64')
    expect(linuxArm64?.spec.asset).toBe('cloudflared-linux-arm64')

    expect(CLOUDFLARED_VERSION).toBeTruthy()
  })

  describe('terminateChildProcess escalation', () => {
    interface FakeChild {
      exitCode: number | null
      signalCode: NodeJS.Signals | null
      killed: boolean
      kill: (signal: NodeJS.Signals) => boolean
    }

    function fakeChild(): FakeChild {
      const child = {
        exitCode: null,
        signalCode: null,
        killed: false,
        kill: vi.fn((signal: NodeJS.Signals) => {
          child.killed = true
          return true
        })
      }
      return child
    }

    it('escalates to SIGKILL when SIGTERM did not stop the child', async () => {
      const child = fakeChild()
      terminateChildProcess(child, 10)
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      await new Promise((resolve) => setTimeout(resolve, 40))
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    })

    it('never escalates once the child has exited after SIGTERM', async () => {
      const child = fakeChild()
      vi.mocked(child.kill).mockImplementationOnce(() => {
        child.killed = true
        child.exitCode = 143
        return true
      })
      terminateChildProcess(child, 10)
      await new Promise((resolve) => setTimeout(resolve, 40))
      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    })

    it('leaves an already-exited child untouched', () => {
      const child = fakeChild()
      child.exitCode = 0
      terminateChildProcess(child, 10)
      expect(child.kill).not.toHaveBeenCalled()
    })
  })
})

describe('Pinggy Tunnel utilities', () => {
  it('extracts current Pinggy HTTPS URL formats without accepting the control host', () => {
    expect(
      extractPinggyUrl(
        'You can access local server via following URL(s):\nhttps://fakqxzqrohxxx.a.pinggy.link'
      )
    ).toBe('https://fakqxzqrohxxx.a.pinggy.link')
    expect(
      extractPinggyUrl(
        '{"urls":["https://rnckk-2405-201.run.pinggy-free.link"]}'
      )
    ).toBe('https://rnckk-2405-201.run.pinggy-free.link')
    expect(extractPinggyUrl('ssh -p 443 free.pinggy.io')).toBeNull()
  })

  it('uses a fixed Pinggy user and dedicated identity instead of the local login name', () => {
    const knownHostsPath = join('/tmp', 'dsh-cloudflared', 'pinggy-known-hosts')
    const identityPath = join('/tmp', 'dsh-cloudflared', 'pinggy-id')
    const args = buildPinggySshArgs({
      port: 39871,
      knownHostsPath,
      identityPath
    })
    expect(PINGGY_USER).toBe('dsh')
    expect(PINGGY_USER).not.toBe(process.env.USER)
    expect(PINGGY_USER).not.toBe(process.env.USERNAME)
    expect(args).toContain('-R')
    expect(args).toContain('0:127.0.0.1:39871')
    expect(args).toContain('-i')
    expect(args).toContain(identityPath)
    expect(args).toContain('IdentitiesOnly=yes')
    expect(args).toContain('BatchMode=yes')
    expect(args).toContain(`User=${PINGGY_USER}`)
    expect(args.at(-1)).toBe(PINGGY_HOST)
    expect(args.join(' ')).not.toContain('@')
    expect(pinggyIdentityPath(knownHostsPath)).toBe(identityPath)
  })

  it('reuses an existing Pinggy identity and creates one when missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pinggy-'))
    const existing = join(dir, 'existing-id')
    await writeFile(existing, 'key')
    const created: string[] = []
    expect(await ensurePinggyIdentity({ identityPath: existing })).toBe(existing)

    const missing = join(dir, 'new-id')
    await ensurePinggyIdentity({
      identityPath: missing,
      createIdentity: async (identityPath) => {
        created.push(identityPath)
        await writeFile(identityPath, 'generated')
      }
    })
    expect(created).toEqual([missing])
    expect(existsSync(missing)).toBe(true)
  })

  it('uses Pinggy only after Cloudflare fails', async () => {
    const calls: string[] = []
    const pinggy = fakeTunnel('pinggy', 'https://fallback.a.pinggy.link')
    const result = await startTunnelWithFallback({
      startCloudflare: async () => {
        calls.push('cloudflare')
        throw new Error('connection reset')
      },
      startPinggy: async () => {
        calls.push('pinggy')
        return pinggy
      }
    })

    expect(result).toBe(pinggy)
    expect(calls).toEqual(['cloudflare', 'pinggy'])
  })

  it('does not start Pinggy when Cloudflare succeeds', async () => {
    const cloudflare = fakeTunnel(
      'cloudflare',
      'https://primary-mobile.trycloudflare.com'
    )
    let pinggyStarted = false
    const result = await startTunnelWithFallback({
      startCloudflare: async () => cloudflare,
      startPinggy: async () => {
        pinggyStarted = true
        return fakeTunnel('pinggy', 'https://unused.a.pinggy.link')
      }
    })

    expect(result).toBe(cloudflare)
    expect(pinggyStarted).toBe(false)
  })

  it('can force the real fallback path for manual Pinggy testing', async () => {
    const calls: string[] = []
    const logs: string[] = []
    const pinggy = fakeTunnel('pinggy', 'https://forced-fallback.a.pinggy.link')
    const result = await startTunnelWithFallback({
      forceCloudflareFailure: true,
      startCloudflare: async () => {
        calls.push('cloudflare')
        return fakeTunnel('cloudflare', 'https://unused.trycloudflare.com')
      },
      startPinggy: async () => {
        calls.push('pinggy')
        return pinggy
      },
      log: (message) => logs.push(message)
    })

    expect(result).toBe(pinggy)
    expect(calls).toEqual(['pinggy'])
    expect(logs).toContain(
      '[tunnel] Cloudflare unavailable, falling back to Pinggy: Cloudflare failure forced by DSH_TUNNEL_FORCE_PINGGY'
    )
  })

  it('preserves both provider errors when neither tunnel is available', async () => {
    await expect(
      startTunnelWithFallback({
        startCloudflare: async () => {
          throw new Error('Cloudflare reset')
        },
        startPinggy: async () => {
          throw new Error('OpenSSH missing')
        }
      })
    ).rejects.toThrow('Cloudflare: Cloudflare reset; Pinggy: OpenSSH missing')
  })
})

describe('LanMobileBridge tunnel state and endpoints', () => {
  it('exposes tunnel status and handles tunnel toggle', async () => {
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:3000',
      port: 0
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    expect(snapshot.running).toBe(true)
    expect(snapshot.port).toBeGreaterThan(0)

    const statusRes = await fetch(`http://127.0.0.1:${snapshot.port}/desktop/tunnel/status`)
    expect(statusRes.status).toBe(200)
    const status = await statusRes.json()
    expect(status.active).toBe(false)
    expect(status.loading).toBe(false)

    // Toggle off when already off returns current snapshot safely
    const toggleOffRes = await fetch(`http://127.0.0.1:${snapshot.port}/desktop/tunnel/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enable: false })
    })
    expect(toggleOffRes.status).toBe(200)
    const toggleOffJson = await toggleOffRes.json()
    expect(toggleOffJson.active).toBe(false)
  })

  it('starts Pinggy and stops Cloudflare when the user asks for a backup link', async () => {
    const stopped: string[] = []
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:3000',
      port: 0,
      createCloudflareTunnel: async () =>
        fakeTunnel('cloudflare', 'https://primary.trycloudflare.com', () =>
          stopped.push('cloudflare')
        ),
      createPinggyTunnel: async () => fakeTunnel('pinggy', 'https://fallback.a.pinggy.link')
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()
    await bridge.toggleTunnel(true)
    expect(bridge.snapshot().tunnelProvider).toBe('cloudflare')

    const response = await fetch(`http://127.0.0.1:${snapshot.port}/desktop/tunnel/fallback`, {
      method: 'POST'
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.active).toBe(true)
    expect(body.provider).toBe('pinggy')
    expect(body.url).toBe('https://fallback.a.pinggy.link')
    expect(body.pairingUrl).toContain('https://fallback.a.pinggy.link/pair?token=')
    expect(stopped).toEqual(['cloudflare'])
  })

  it('keeps Cloudflare when the Pinggy backup link cannot start', async () => {
    const stopped: string[] = []
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:3000',
      port: 0,
      createCloudflareTunnel: async () =>
        fakeTunnel('cloudflare', 'https://primary.trycloudflare.com', () =>
          stopped.push('cloudflare')
        ),
      createPinggyTunnel: async () => {
        throw new Error('OpenSSH missing')
      }
    })
    bridges.push(bridge)
    await bridge.start()
    await bridge.toggleTunnel(true)

    const snapshot = await bridge.fallbackToPinggy()
    expect(snapshot.tunnelActive).toBe(true)
    expect(snapshot.tunnelProvider).toBe('cloudflare')
    expect(snapshot.tunnelUrl).toBe('https://primary.trycloudflare.com')
    expect(snapshot.tunnelError).toBe('OpenSSH missing')
    expect(stopped).toEqual([])
  })

  it('rejects backup-link fallback unless an unconnected Cloudflare tunnel is active', async () => {
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:3000',
      port: 0,
      forceCloudflareFailure: true,
      createPinggyTunnel: async () => fakeTunnel('pinggy', 'https://forced.a.pinggy.link')
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()

    const lanRes = await fetch(`http://127.0.0.1:${snapshot.port}/desktop/tunnel/fallback`, {
      method: 'POST'
    })
    expect(lanRes.status).toBe(400)

    await bridge.toggleTunnel(true)
    expect(bridge.snapshot().tunnelProvider).toBe('pinggy')
    const pinggyRes = await fetch(`http://127.0.0.1:${snapshot.port}/desktop/tunnel/fallback`, {
      method: 'POST'
    })
    expect(pinggyRes.status).toBe(400)

    await bridge.toggleTunnel(false)
    const reconnect = await fetch(`http://127.0.0.1:${snapshot.port}/reconnect`)
    const pairingId = /let id="([^"]+)"/.exec(await reconnect.text())?.[1]
    expect(pairingId).toBeTruthy()
    await fetch(`http://127.0.0.1:${snapshot.port}/desktop/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: pairingId, approved: true })
    })
    await fetch(`http://127.0.0.1:${snapshot.port}/pair/status?id=${pairingId}`)

    const connectedRes = await fetch(`http://127.0.0.1:${snapshot.port}/desktop/tunnel/fallback`, {
      method: 'POST'
    })
    expect(connectedRes.status).toBe(409)
  })
})
function fakeTunnel(
  provider: InternetTunnelInstance['provider'],
  url: string,
  onStop?: () => void
): InternetTunnelInstance {
  return {
    provider,
    url,
    process: {} as InternetTunnelInstance['process'],
    stop: async () => {
      onStop?.()
    }
  }
}

describe('cloudflared download integrity', () => {
  it('computes the sha256 digest of a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-sha-'))
    const file = join(dir, 'payload.bin')
    await writeFile(file, 'hello dsh')
    expect(await sha256OfFile(file)).toBe(
      '5ca8af871577287acfeec98bc5c810d39d7d1713c860579cda5a45808222ad03'
    )
  })

  it('pins the real upstream digests for cloudflared 2026.8.2', () => {
    // Verified against the GitHub Releases API digests for tag 2026.8.2.
    expect(CLOUDFLARED_ASSETS['darwin-arm64']!.sha256).toBe(
      '9042c2c5d8b2de78e60f313d5fb31b6c5c1cebde787a3caf1f2c9588084ac442'
    )
    expect(CLOUDFLARED_ASSETS['darwin-x64']!.sha256).toBe(
      'f1727723c586500e2092368ae21871b3df7ddfd2cb097f22d81bee4a9c458bb4'
    )
    expect(CLOUDFLARED_ASSETS['win32-x64']!.sha256).toBe(
      'c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5'
    )
    expect(CLOUDFLARED_ASSETS['linux-x64']!.sha256).toBe(
      'fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2'
    )
    expect(CLOUDFLARED_ASSETS['linux-arm64']!.sha256).toBe(
      '7747d94570fb390cf47dcb4f9555c193c6355cda9793f0d878d9049e5d6a7790'
    )
  })

  it('rejects and deletes a downloaded binary whose checksum does not match the pinned spec', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tunnel-'))
    const download = vi.fn(async (_url: string, destination: string) => {
      await writeFile(destination, 'tampered binary payload')
    })

    await expect(
      ensureCloudflaredBinary({
        cacheDir: dir,
        osPlatform: 'linux',
        osArch: 'x64',
        download,
        findOnPath: async () => null
      })
    ).rejects.toThrow(/checksum mismatch/i)

    expect(download).toHaveBeenCalledTimes(1)
    expect(existsSync(join(dir, 'cloudflared'))).toBe(false)
    const leftovers = await readdir(dir)
    expect(leftovers.filter((name) => name.startsWith('.download-'))).toEqual([])
  })

  it('verifies before extracting tar.gz assets and leaves nothing behind on mismatch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tunnel-'))
    await expect(
      ensureCloudflaredBinary({
        cacheDir: dir,
        osPlatform: 'darwin',
        osArch: 'arm64',
        download: async (_url: string, destination: string) => {
          await writeFile(destination, 'not really a tarball')
        },
        findOnPath: async () => null
      })
    ).rejects.toThrow(/checksum mismatch/i)
    expect(await readdir(join(dir, CLOUDFLARED_VERSION))).toEqual([])
  })

  it('accepts a download whose checksum matches the pinned spec', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tunnel-'))
    const spec = CLOUDFLARED_ASSETS['linux-x64']!
    const originalSha = spec.sha256
    const payload = Buffer.from('genuine cloudflared binary bytes')
    spec.sha256 = createHash('sha256').update(payload).digest('hex')
    try {
      const binaryPath = await ensureCloudflaredBinary({
        cacheDir: dir,
        osPlatform: 'linux',
        osArch: 'x64',
        download: async (_url: string, destination: string) => {
          await writeFile(destination, payload)
        },
        findOnPath: async () => null
      })
      expect(binaryPath).toBe(join(dir, CLOUDFLARED_VERSION, 'cloudflared'))
      expect(existsSync(binaryPath)).toBe(true)
    } finally {
      spec.sha256 = originalSha
    }
  })

  it('retries retryable download resets then succeeds', async () => {
    let attempts = 0
    const dest = join(await mkdtemp(join(tmpdir(), 'dsh-dl-')), 'cloudflared')
    await downloadCloudflaredWithRetry('https://example.com/cloudflared', dest, {
      attempts: CLOUDFLARED_DOWNLOAD_ATTEMPTS,
      sleep: async () => undefined,
      download: async (_url, destination) => {
        attempts += 1
        if (attempts < 3) {
          const error = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
          await writeFile(destination, `partial-${attempts}`)
          throw error
        }
        await writeFile(destination, 'ok')
      }
    })
    expect(attempts).toBe(3)
    expect(existsSync(dest)).toBe(true)
  })

  it('does not retry non-reset download failures', async () => {
    let attempts = 0
    await expect(
      downloadCloudflaredWithRetry('https://example.com/cloudflared', '/tmp/unused', {
        sleep: async () => undefined,
        download: async () => {
          attempts += 1
          throw new Error('Download failed with status 404')
        }
      })
    ).rejects.toThrow(/status 404/)
    expect(attempts).toBe(1)
    expect(isRetryableDownloadError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(
      true
    )
    expect(isRetryableDownloadError(new Error('Download failed with status 404'))).toBe(false)
  })

  it('sweeps leftover .download-* files from interrupted runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tunnel-'))
    const versionDir = join(dir, CLOUDFLARED_VERSION)
    await mkdir(versionDir, { recursive: true })
    await writeFile(join(versionDir, '.download-1700000000000-cloudflared-linux-amd64'), 'partial')
    const spec = CLOUDFLARED_ASSETS['linux-x64']!
    const originalSha = spec.sha256
    const payload = Buffer.from('fresh genuine bytes')
    spec.sha256 = createHash('sha256').update(payload).digest('hex')
    try {
      await ensureCloudflaredBinary({
        cacheDir: dir,
        osPlatform: 'linux',
        osArch: 'x64',
        download: async (_url: string, destination: string) => {
          await writeFile(destination, payload)
        },
        findOnPath: async () => null
      })
      const leftovers = (await readdir(versionDir)).filter((name) => name.startsWith('.download-'))
      expect(leftovers).toEqual([])
    } finally {
      spec.sha256 = originalSha
    }
  })
})

describe('LanMobileBridge toggle concurrency', () => {
  it('ignores concurrent tunnel toggles while a launch is already in flight', async () => {
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:3000',
      port: 0
    })
    bridges.push(bridge)
    await bridge.start()

    let launches = 0
    Object.assign(bridge as unknown as Record<string, unknown>, {
      launchTunnel: async () => {
        launches += 1
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
    })

    const [first, second] = await Promise.all([
      bridge.toggleTunnel(true),
      bridge.toggleTunnel(true)
    ])

    expect(launches).toBe(1)
    expect(first.tunnelActive).toBe(true)
    expect(second.tunnelLoading).toBe(true)
    expect(second.tunnelActive).toBe(false)
    expect(bridge.snapshot().tunnelActive).toBe(true)
  })
})

describe('LanMobileBridge launch lifecycle', () => {
  it('stops a tunnel spawned by a launch that disables mid-flight', async () => {
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:3000',
      port: 0
    })
    bridges.push(bridge)
    await bridge.start()

    const stopped: string[] = []
    let releaseLaunch: (() => void) | undefined
    Object.assign(bridge as unknown as Record<string, unknown>, {
      launchTunnel: () =>
        new Promise<void>((resolve) => {
          releaseLaunch = () => {
            Object.assign(bridge as unknown as Record<string, unknown>, {
              tunnelInstance: {
                url: 'https://raced.trycloudflare.com',
                process: {},
                stop: async () => {
                  stopped.push('raced')
                }
              }
            })
            resolve()
          }
        })
    })

    const enabling = bridge.toggleTunnel(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const disabling = bridge.toggleTunnel(false)
    await new Promise((resolve) => setTimeout(resolve, 20))
    releaseLaunch!()
    await Promise.all([enabling, disabling])

    expect(stopped).toEqual(['raced'])
    const snapshot = bridge.snapshot()
    expect(snapshot.tunnelActive).toBe(false)
    expect(snapshot.tunnelLoading).toBe(false)
  })

  it('retries after a failed launch and resets the loading flag', async () => {
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:3000',
      port: 0
    })
    bridges.push(bridge)
    await bridge.start()

    let launches = 0
    Object.assign(bridge as unknown as Record<string, unknown>, {
      launchTunnel: async () => {
        launches += 1
        if (launches === 1) throw new Error('binary download failed')
        Object.assign(bridge as unknown as Record<string, unknown>, {
          tunnelInstance: {
            url: 'https://second.trycloudflare.com',
            process: {},
            stop: async () => undefined
          }
        })
      }
    })

    const failed = await bridge.toggleTunnel(true)
    expect(failed.tunnelActive).toBe(false)
    expect(failed.tunnelLoading).toBe(false)
    expect(failed.tunnelError).toBe('binary download failed')

    const retried = await bridge.toggleTunnel(true)
    expect(launches).toBe(2)
    expect(retried.tunnelActive).toBe(true)
    expect(retried.tunnelLoading).toBe(false)
  })

  it('waits for an in-flight launch during stop() and kills its tunnel', async () => {
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:3000',
      port: 0
    })
    bridges.push(bridge)
    await bridge.start()

    const stopped: string[] = []
    let releaseLaunch: (() => void) | undefined
    Object.assign(bridge as unknown as Record<string, unknown>, {
      launchTunnel: () =>
        new Promise<void>((resolve) => {
          releaseLaunch = () => {
            Object.assign(bridge as unknown as Record<string, unknown>, {
              tunnelInstance: {
                url: 'https://late.trycloudflare.com',
                process: {},
                stop: async () => {
                  stopped.push('late')
                }
              }
            })
            resolve()
          }
        })
    })

    const enabling = bridge.toggleTunnel(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const stopping = bridge.stop()
    await new Promise((resolve) => setTimeout(resolve, 20))
    releaseLaunch!()
    await Promise.all([enabling, stopping])

    expect(stopped).toEqual(['late'])
    expect(bridge.snapshot()).toEqual({ running: false, connected: false })
  })

  it('reports HTTP 409 for an enable toggle while a launch is in flight', async () => {
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:3000',
      port: 0
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()

    let releaseLaunch: (() => void) | undefined
    Object.assign(bridge as unknown as Record<string, unknown>, {
      launchTunnel: () =>
        new Promise<void>((resolve) => {
          releaseLaunch = resolve
        })
    })

    void bridge.toggleTunnel(true)
    await new Promise((resolve) => setTimeout(resolve, 20))

    const response = await fetch(`http://127.0.0.1:${snapshot.port}/desktop/tunnel/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${snapshot.port}` },
      body: JSON.stringify({ enable: true })
    })
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error).toMatch(/already in progress/i)

    releaseLaunch!()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
})
describe('LanMobileBridge shutdown with live connections', () => {
  it('resolves stop() promptly even while an authorized mobile RPC is still in flight', async () => {
    // A harness that accepts connections but never answers: the forwarded
    // session.list hangs until its 30s abort timeout.
    const unresponsiveHarness = createServer(() => {})
    await new Promise<void>((resolve) => unresponsiveHarness.listen(0, '127.0.0.1', resolve))
    harnessServers.push(unresponsiveHarness)
    const harnessPort = (unresponsiveHarness.address() as AddressInfo).port

    const bridge = new LanMobileBridge({
      harnessUrl: () => `http://127.0.0.1:${harnessPort}`
    })
    bridges.push(bridge)
    const snapshot = await bridge.start()

    // Pair one phone through the reconnect surface to get an auth cookie.
    const reconnect = await fetch(`http://127.0.0.1:${snapshot.port}/reconnect`)
    const pairingId = /let id="([^"]+)"/.exec(await reconnect.text())?.[1]
    expect(pairingId).toBeTruthy()
    await fetch(`http://127.0.0.1:${snapshot.port}/desktop/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: pairingId, approved: true })
    })
    const approved = await fetch(
      `http://127.0.0.1:${snapshot.port}/pair/status?id=${pairingId}`
    )
    expect(await approved.clone().json()).toEqual({ approved: true })
    const cookie = approved.headers.get('set-cookie')!.split(';', 1)[0]!

    void fetch(`http://127.0.0.1:${snapshot.port}/api/rpc`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'session.list', payload: {} })
    }).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 100))

    const winner = await Promise.race([
      bridge.stop().then(() => 'stopped' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3_000))
    ])
    expect(winner).toBe('stopped')
  })
})

interface DeferredGate {
  resolve: () => void
  promise: Promise<void>
}

function deferredGate(): DeferredGate {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { resolve, promise }
}

type FakeTunnelChild = TunnelChildProcess & EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
}

function fakeTunnelChild(): FakeTunnelChild {
  const child = new EventEmitter() as unknown as FakeTunnelChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.kill = vi.fn(() => {
    if (child.exitCode === null && child.signalCode === null) child.exitCode = 0
    return true
  })
  return child
}

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Waits until the fake spawn seam has produced `count` children (real fs prep can take a tick or two). */
async function waitForChildren(children: FakeTunnelChild[], count: number): Promise<void> {
  for (let i = 0; i < 500 && children.length < count; i++) await tick(2)
  expect(children.length).toBe(count)
}

describe('watchPostConnectExit', () => {
  it('reports an unexpected exit exactly once despite duplicate exit/close events', () => {
    const child = fakeTunnelChild()
    const exits: TunnelExitDetail[] = []
    watchPostConnectExit(child, {
      isHostStopped: () => false,
      onUnexpectedExit: (detail) => exits.push(detail)
    })
    child.emit('exit', 137, null)
    child.emit('close', 137, null)
    child.emit('exit', 137, null)
    expect(exits).toEqual([{ code: 137, signal: null }])
  })

  it('never reports a host-initiated death', () => {
    const child = fakeTunnelChild()
    const exits: TunnelExitDetail[] = []
    watchPostConnectExit(child, {
      isHostStopped: () => true,
      onUnexpectedExit: (detail) => exits.push(detail)
    })
    child.emit('exit', null, 'SIGTERM')
    child.emit('close', null, 'SIGTERM')
    expect(exits).toEqual([])
  })
})

describe('tunnel relaunch backoff', () => {
  it('doubles from ~500ms and caps at ~30s', () => {
    expect(TUNNEL_RELAUNCH_START_MS).toBe(500)
    expect(TUNNEL_RELAUNCH_MAX_MS).toBe(30_000)
    expect([1, 2, 3, 4, 5, 6, 7].map((attempt) => tunnelRelaunchDelayMs(attempt))).toEqual([
      500, 1000, 2000, 4000, 8000, 16000, 30000
    ])
    expect(tunnelRelaunchDelayMs(10)).toBe(30_000)
    expect(tunnelRelaunchDelayMs(12, 9000, 20_000)).toBe(20_000)
  })

  it('gives up after a bounded number of attempts', () => {
    expect(TUNNEL_RELAUNCH_MAX_ATTEMPTS).toBe(5)
  })
})

describe('cloudflared tunnel lifecycle (F3)', () => {
  interface FakeCloudflareHarness {
    instance: Awaited<ReturnType<typeof startCloudflareQuickTunnel>>
    children: FakeTunnelChild[]
    delays: number[]
    gates: DeferredGate[]
    state: TunnelRuntimeState[]
    logs: string[]
  }

  async function startFakeCloudflare(
    overrides: Partial<CloudflareQuickTunnelOptions> = {}
  ): Promise<FakeCloudflareHarness> {
    const children: FakeTunnelChild[] = []
    const delays: number[] = []
    const gates: DeferredGate[] = []
    const state: TunnelRuntimeState[] = []
    const logs: string[] = []
    const connecting = startCloudflareQuickTunnel({
      port: 39871,
      binaryPath: '/fake/cloudflared',
      timeoutMs: 100,
      spawnProcess: (command, args) => {
        expect(command).toBe('/fake/cloudflared')
        expect(args).toEqual(['tunnel', '--url', 'http://127.0.0.1:39871'])
        const child = fakeTunnelChild()
        children.push(child)
        return child
      },
      delay: (ms) => {
        delays.push(ms)
        const gate = deferredGate()
        gates.push(gate)
        return gate.promise
      },
      onStateChange: (snapshot) => state.push(snapshot),
      log: (message) => logs.push(message),
      ...overrides
    })
    await waitForChildren(children, 1)
    children[0]!.stderr.emit('data', 'INF |  https://first-try.trycloudflare.com  |')
    const instance = await connecting
    return { instance, children, delays, gates, state, logs }
  }

  it('flips to down and relaunches once when the child exits unexpectedly', async () => {
    const harness = await startFakeCloudflare()
    expect(harness.instance.url).toBe('https://first-try.trycloudflare.com')

    harness.children[0]!.emit('exit', 1, null)
    harness.children[0]!.emit('close', 1, null)
    await tick()

    expect(harness.instance.url).toBeUndefined()
    expect(harness.state.at(-1)).toMatchObject({ provider: 'cloudflare', active: false })
    expect(harness.logs.some((line) => line.includes('exited unexpectedly'))).toBe(true)
    expect(harness.delays).toEqual([500])

    harness.gates[0]!.resolve()
    await waitForChildren(harness.children, 2)
    harness.children[1]!.stderr.emit('data', 'INF https://second-try.trycloudflare.com')
    await tick()

    expect(harness.instance.url).toBe('https://second-try.trycloudflare.com')
    expect(harness.state.at(-1)).toMatchObject({
      provider: 'cloudflare',
      active: true,
      url: 'https://second-try.trycloudflare.com'
    })
    expect(harness.children.length).toBe(2)

    await harness.instance.stop()
  })

  it('does not relaunch when the host stops the tunnel', async () => {
    const harness = await startFakeCloudflare()

    await harness.instance.stop()
    expect(harness.children[0]!.kill).toHaveBeenCalledWith('SIGTERM')

    harness.children[0]!.emit('exit', null, 'SIGTERM')
    harness.children[0]!.emit('close', null, 'SIGTERM')
    await tick(20)

    expect(harness.children.length).toBe(1)
    expect(harness.gates.length).toBe(0)
    expect(harness.delays.length).toBe(0)
    expect(harness.state.at(-1)).toMatchObject({ provider: 'cloudflare', active: false })
  })

  it('keeps a single relaunch in flight when exit events arrive rapidly', async () => {
    const harness = await startFakeCloudflare()

    harness.children[0]!.emit('exit', 2, null)
    harness.children[0]!.emit('close', 2, null)
    harness.children[0]!.emit('close', 2, null)
    harness.children[0]!.emit('exit', 2, null)
    await tick()

    expect(harness.delays).toEqual([500])
    expect(harness.gates.length).toBe(1)
    expect(harness.children.length).toBe(1)

    harness.gates[0]!.resolve()
    await waitForChildren(harness.children, 2)
    expect(harness.children.length).toBe(2)

    await harness.instance.stop()
  })

  it('backs off with a cap and gives up after the attempt limit', async () => {
    const harness = await startFakeCloudflare({
      timeoutMs: 20,
      relaunchStartMs: 4000,
      relaunchMaxMs: 5000,
      maxRelaunchAttempts: 3
    })

    harness.children[0]!.emit('exit', 1, null)
    await tick()
    expect(harness.children.length).toBe(1)

    for (let attempt = 0; attempt < 3; attempt++) {
      expect(harness.gates.length).toBe(attempt + 1)
      harness.gates[attempt]!.resolve()
      await tick(40)
    }
    await tick(20)

    expect(harness.delays).toEqual([4000, 5000, 5000])
    expect(harness.children.length).toBe(4)
    expect(harness.state.at(-1)).toMatchObject({ provider: 'cloudflare', active: false })
    expect(harness.state.at(-1)?.error).toBeTruthy()
    expect(harness.logs.some((line) => line.includes('gave up after 3 relaunch attempts'))).toBe(
      true
    )

    // Settling any stray gates must not spawn further attempts.
    for (const gate of harness.gates) gate.resolve()
    await tick(40)
    expect(harness.children.length).toBe(4)

    await harness.instance.stop()
  })

  it('kills a replacement tunnel that connects after the host stopped', async () => {
    const stopped: string[] = []
    const makeInstance = (url: string): InternetTunnelInstance => ({
      provider: 'cloudflare',
      url,
      process: fakeTunnelChild(),
      stop: async () => {
        stopped.push(url)
      }
    })
    let started = 0
    let releaseStart!: (instance: InternetTunnelInstance) => void
    const start = vi.fn(
      () =>
        new Promise<InternetTunnelInstance>((resolve) => {
          releaseStart = (instance) => {
            started += 1
            resolve(instance)
          }
        })
    )
    const supervisor = superviseTunnel({
      provider: 'cloudflare',
      initial: makeInstance('https://first.trycloudflare.com'),
      start,
      delay: async () => undefined
    })

    supervisor.handleUnexpectedExit({ code: 1, signal: null })
    await tick()
    await supervisor.instance.stop()
    releaseStart(makeInstance(`https://late-${started + 1}.trycloudflare.com`))
    await tick()

    expect(start).toHaveBeenCalledTimes(1)
    // The host stop killed the current tunnel; the replacement that connected
    // afterwards must be killed too, not orphaned.
    expect(stopped).toEqual(['https://first.trycloudflare.com', 'https://late-1.trycloudflare.com'])
  })
})

describe('pinggy tunnel lifecycle (F3)', () => {
  interface FakePinggyHarness {
    instance: Awaited<ReturnType<typeof startPinggyTunnel>>
    children: FakeTunnelChild[]
    commands: string[]
    argsList: string[][]
    delays: number[]
    gates: DeferredGate[]
    state: TunnelRuntimeState[]
  }

  async function startFakePinggy(
    overrides: Partial<PinggyTunnelOptions> = {}
  ): Promise<FakePinggyHarness> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pinggy-lifecycle-'))
    const sshPath = join(dir, 'ssh')
    await writeFile(sshPath, '#!/bin/sh\nexit 0\n')
    await writeFile(join(dir, 'id'), 'key')
    const children: FakeTunnelChild[] = []
    const commands: string[] = []
    const argsList: string[][] = []
    const delays: number[] = []
    const gates: DeferredGate[] = []
    const state: TunnelRuntimeState[] = []
    const connecting = startPinggyTunnel({
      port: 39871,
      sshPath,
      knownHostsPath: join(dir, 'known-hosts'),
      identityPath: join(dir, 'id'),
      timeoutMs: 100,
      spawnProcess: (command, args) => {
        commands.push(command)
        argsList.push(args)
        const child = fakeTunnelChild()
        children.push(child)
        return child
      },
      delay: (ms) => {
        delays.push(ms)
        const gate = deferredGate()
        gates.push(gate)
        return gate.promise
      },
      onStateChange: (snapshot) => state.push(snapshot),
      ...overrides
    })
    await waitForChildren(children, 1)
    children[0]!.stderr.emit('data', 'https://lifecycle-test.a.pinggy.link')
    const instance = await connecting
    return { instance, children, commands, argsList, delays, gates, state }
  }

  it('flips to down and relaunches once when ssh exits unexpectedly', async () => {
    const harness = await startFakePinggy()
    expect(harness.instance.url).toBe('https://lifecycle-test.a.pinggy.link')
    expect(harness.commands[0]!).toMatch(/ssh$/)

    harness.children[0]!.emit('exit', 255, null)
    harness.children[0]!.emit('close', 255, null)
    await tick()

    expect(harness.instance.url).toBeUndefined()
    expect(harness.state.at(-1)).toMatchObject({ provider: 'pinggy', active: false })
    expect(harness.delays).toEqual([500])

    harness.gates[0]!.resolve()
    // Relaunching re-runs the real fs prep (mkdir/identity checks) before
    // spawning, so wait for the fake spawn seam rather than a fixed tick.
    await waitForChildren(harness.children, 2)
    harness.children[1]!.stderr.emit('data', 'https://reconnected.a.pinggy.link')
    await tick()

    expect(harness.instance.url).toBe('https://reconnected.a.pinggy.link')
    expect(harness.state.at(-1)).toMatchObject({
      provider: 'pinggy',
      active: true,
      url: 'https://reconnected.a.pinggy.link'
    })

    await harness.instance.stop()
  })

  it('does not relaunch when the host stops the tunnel', async () => {
    const harness = await startFakePinggy()

    await harness.instance.stop()
    harness.children[0]!.emit('exit', null, 'SIGTERM')
    harness.children[0]!.emit('close', null, 'SIGTERM')
    await tick(20)

    expect(harness.children.length).toBe(1)
    expect(harness.gates.length).toBe(0)
    expect(harness.delays.length).toBe(0)
    expect(harness.state.at(-1)).toMatchObject({ provider: 'pinggy', active: false })
  })
})

describe('cloudflared binary cache version keying (F7)', () => {
  function pinLinuxSha256(payload: Buffer): () => void {
    const spec = CLOUDFLARED_ASSETS['linux-x64']!
    const original = spec.sha256
    spec.sha256 = createHash('sha256').update(payload).digest('hex')
    return () => {
      spec.sha256 = original
    }
  }

  function downloadPayload(payload: Buffer) {
    return vi.fn(async (_url: string, destination: string) => {
      await writeFile(destination, payload)
    })
  }

  it('reuses the cached binary for the same version without re-downloading', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tunnel-'))
    const payload = Buffer.from('cloudflared 2026.1.1 genuine bytes')
    const restore = pinLinuxSha256(payload)
    const download = downloadPayload(payload)
    try {
      const first = await ensureCloudflaredBinary({
        cacheDir: dir,
        version: '2026.1.1',
        osPlatform: 'linux',
        osArch: 'x64',
        download,
        findOnPath: async () => null
      })
      const second = await ensureCloudflaredBinary({
        cacheDir: dir,
        version: '2026.1.1',
        osPlatform: 'linux',
        osArch: 'x64',
        download,
        findOnPath: async () => null
      })
      expect(first).toBe(join(dir, '2026.1.1', 'cloudflared'))
      expect(second).toBe(first)
      expect(download).toHaveBeenCalledTimes(1)
      expect(download.mock.calls[0]?.[0]).toContain('/2026.1.1/')
    } finally {
      restore()
    }
  })

  it('re-downloads when the version changes but keeps the old file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tunnel-'))
    const v1 = Buffer.from('cloudflared 2026.1.1 genuine bytes')
    const v2 = Buffer.from('cloudflared 2026.2.0 genuine bytes')
    const restore1 = pinLinuxSha256(v1)
    let payload = v1
    const download = vi.fn(async (_url: string, destination: string) => {
      await writeFile(destination, payload)
    })
    let restore2: () => void = () => undefined
    try {
      const first = await ensureCloudflaredBinary({
        cacheDir: dir,
        version: '2026.1.1',
        osPlatform: 'linux',
        osArch: 'x64',
        download,
        findOnPath: async () => null
      })
      expect(first).toBe(join(dir, '2026.1.1', 'cloudflared'))

      restore1()
      restore2 = pinLinuxSha256(v2)
      payload = v2
      const second = await ensureCloudflaredBinary({
        cacheDir: dir,
        version: '2026.2.0',
        osPlatform: 'linux',
        osArch: 'x64',
        download,
        findOnPath: async () => null
      })

      expect(second).toBe(join(dir, '2026.2.0', 'cloudflared'))
      expect(download).toHaveBeenCalledTimes(2)
      expect(download.mock.calls[1]?.[0]).toContain('/2026.2.0/')
      expect(existsSync(first)).toBe(true)
    } finally {
      restore1()
      restore2()
    }
  })

  it('ignores a stale binary left at the cache root by the pre-versioning layout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tunnel-'))
    await writeFile(join(dir, 'cloudflared'), 'stale root binary')
    const payload = Buffer.from('cloudflared fresh pinned bytes')
    const restore = pinLinuxSha256(payload)
    const download = downloadPayload(payload)
    try {
      const binaryPath = await ensureCloudflaredBinary({
        cacheDir: dir,
        osPlatform: 'linux',
        osArch: 'x64',
        download,
        findOnPath: async () => null
      })
      expect(binaryPath).toBe(join(dir, CLOUDFLARED_VERSION, 'cloudflared'))
      expect(download).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })
})
