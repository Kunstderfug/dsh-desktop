import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import {
  superviseTunnel,
  watchPostConnectExit,
  type TunnelChildProcess,
  type TunnelExitDetail,
  type TunnelRuntimeState,
  type TunnelSupervisor
} from './internet-tunnel'
import type { InternetTunnelInstance } from './internet-tunnel'

const execFileAsync = promisify(execFile)
export const PINGGY_HOST = 'free.pinggy.io'
export const PINGGY_USER = 'dsh'

export interface PinggyTunnelInstance extends InternetTunnelInstance {
  provider: 'pinggy'
}

export function extractPinggyUrl(text: string): string | null {
  const matches = text.matchAll(
    /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:pinggy(?:-free)?\.link|pinggy\.online)/gi
  )
  for (const match of matches) return match[0]
  return null
}

export async function findSshOnPath(
  osPlatform: NodeJS.Platform | string = platform()
): Promise<string | null> {
  const cmd = osPlatform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileAsync(cmd, ['ssh'], { timeout: 3000 })
    const resolved = stdout.trim().split(/\r?\n/)[0]
    return resolved && existsSync(resolved) ? resolved : null
  } catch {
    return null
  }
}

export function buildPinggySshArgs(options: {
  port: number
  knownHostsPath: string
  identityPath: string
}): string[] {
  return [
    '-p',
    '443',
    '-R',
    `0:127.0.0.1:${options.port}`,
    '-i',
    options.identityPath,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    `UserKnownHostsFile=${options.knownHostsPath}`,
    '-o',
    `User=${PINGGY_USER}`,
    PINGGY_HOST
  ]
}

export function pinggyIdentityPath(knownHostsPath: string): string {
  return join(dirname(knownHostsPath), 'pinggy-id')
}

export async function ensurePinggyIdentity(options: {
  identityPath: string
  sshPath?: string
  createIdentity?: (identityPath: string) => Promise<void>
}): Promise<string> {
  if (existsSync(options.identityPath)) return options.identityPath
  await mkdir(dirname(options.identityPath), { recursive: true })
  if (options.createIdentity) {
    await options.createIdentity(options.identityPath)
  } else {
    const keygenPath = resolveSshKeygen(options.sshPath)
    await execFileAsync(keygenPath, ['-t', 'ed25519', '-f', options.identityPath, '-N', '', '-q'], {
      timeout: 10_000
    })
  }
  if (!existsSync(options.identityPath)) {
    throw new Error(`ssh-keygen did not create Pinggy identity: ${options.identityPath}`)
  }
  return options.identityPath
}

function resolveSshKeygen(sshPath?: string): string {
  if (sshPath) {
    const sibling = join(dirname(sshPath), platform() === 'win32' ? 'ssh-keygen.exe' : 'ssh-keygen')
    if (existsSync(sibling)) return sibling
  }
  return 'ssh-keygen'
}

export interface PinggyTunnelOptions {
  port: number
  knownHostsPath: string
  sshPath?: string
  identityPath?: string
  createIdentity?: (identityPath: string) => Promise<void>
  timeoutMs?: number
  log?: (message: string) => void
  /** F3: observe an unexpected child death after a successful connect. */
  onUnexpectedExit?: (detail: TunnelExitDetail) => void
  /** Lifecycle state of the supervised tunnel (up/down/reconnects). */
  onStateChange?: (state: TunnelRuntimeState) => void
  /** Injectable child-process seam: tests pass fakes, never a real ssh client. */
  spawnProcess?: (command: string, args: string[]) => TunnelChildProcess
  /** Injectable relaunch backoff wait (tests pass a controlled one). */
  delay?: (ms: number) => Promise<void>
  relaunchStartMs?: number
  relaunchMaxMs?: number
  maxRelaunchAttempts?: number
}

/**
 * Start a Pinggy tunnel that survives unexpected child deaths.
 *
 * The public starter supervises the connected ssh child (F3): an unexpected
 * exit flips the instance to down and relaunches single-flight with
 * exponential backoff, while `url` on the returned instance always reflects
 * the live tunnel. Only the first successful connect is awaited; relaunches
 * happen in the background. Host-initiated stops never relaunch.
 */
export async function startPinggyTunnel(options: PinggyTunnelOptions): Promise<PinggyTunnelInstance> {
  let supervisor: TunnelSupervisor | undefined
  const spawnOnce = (): Promise<PinggyTunnelInstance> =>
    startPinggyTunnelOnce({
      ...options,
      onUnexpectedExit: (detail) => supervisor?.handleUnexpectedExit(detail)
    })
  const initial = await spawnOnce()
  supervisor = superviseTunnel({
    provider: 'pinggy',
    initial,
    start: spawnOnce,
    log: options.log,
    onStateChange: options.onStateChange,
    delay: options.delay,
    relaunchStartMs: options.relaunchStartMs,
    relaunchMaxMs: options.relaunchMaxMs,
    maxRelaunchAttempts: options.maxRelaunchAttempts
  })
  return supervisor.instance as PinggyTunnelInstance
}

async function startPinggyTunnelOnce(options: PinggyTunnelOptions): Promise<PinggyTunnelInstance> {
  const { port, knownHostsPath, timeoutMs = 30_000, log } = options
  const sshPath = options.sshPath ?? (await findSshOnPath())
  if (!sshPath) {
    throw new Error(`OpenSSH client was not found for ${platform()}-${arch()}`)
  }
  if (!existsSync(sshPath)) throw new Error(`OpenSSH client does not exist: ${sshPath}`)

  await mkdir(dirname(knownHostsPath), { recursive: true })
  const identityPath = await ensurePinggyIdentity({
    identityPath: options.identityPath ?? pinggyIdentityPath(knownHostsPath),
    sshPath,
    createIdentity: options.createIdentity
  })

  const spawnChild =
    options.spawnProcess ??
    ((command: string, args: string[]) =>
      spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }))

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    let stoppedByHost = false
    let output = ''
    const child = spawnChild(sshPath, buildPinggySshArgs({ port, knownHostsPath, identityPath }))

    const cleanup = () => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM')
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
          }, 2000).unref?.()
        }
      } catch {}
    }

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      cleanup()
      rejectPromise(error)
    }

    const timeoutTimer = setTimeout(() => {
      const detail = lastOutputLine(output)
      fail(
        new Error(
          `Pinggy Tunnel timed out after ${timeoutMs / 1000}s${detail ? `: ${detail}` : ''}`
        )
      )
    }, timeoutMs)

    const handleOutput = (chunk: Buffer | string) => {
      output = `${output}${chunk.toString()}`.slice(-16_384)
      const capturedUrl = extractPinggyUrl(output)
      if (!capturedUrl || settled) return
      settled = true
      clearTimeout(timeoutTimer)
      log?.(`[pinggy] Tunnel online: ${capturedUrl}`)
      // F3: a post-connect exit used to be ignored here — the desktop kept
      // advertising the dead URL. The supervisor watches from now on.
      watchPostConnectExit(child, {
        isHostStopped: () => stoppedByHost,
        onUnexpectedExit: (detail) => options.onUnexpectedExit?.(detail)
      })
      resolvePromise({
        provider: 'pinggy',
        url: capturedUrl,
        process: child,
        stop: async () => {
          stoppedByHost = true
          cleanup()
        }
      })
    }

    child.stdout?.on('data', handleOutput)
    child.stderr?.on('data', handleOutput)
    child.once('error', (error) => fail(error))
    child.once('close', (code, signal) => {
      const detail = lastOutputLine(output)
      fail(
        new Error(
          `Pinggy exited unexpectedly with code ${code}, signal ${signal}${detail ? `: ${detail}` : ''}`
        )
      )
    })
  })
}

function lastOutputLine(output: string): string {
  const lines = output
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return (lines.at(-1) ?? '').slice(0, 300)
}
