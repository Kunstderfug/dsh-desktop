export type InternetTunnelProvider = 'cloudflare' | 'pinggy'

/**
 * Structural surface of a spawned tunnel child (cloudflared, or the Pinggy
 * ssh client). Deliberately narrow so tests can substitute EventEmitter
 * fakes instead of real processes; a real `ChildProcess` satisfies it.
 */
export interface TunnelChildProcess {
  readonly stdout?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  readonly stderr?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  once(event: 'error', listener: (error: Error) => void): unknown
  once(
    event: 'exit' | 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill(signal?: NodeJS.Signals): boolean
}

export interface InternetTunnelInstance {
  provider: InternetTunnelProvider
  /**
   * The live tunnel URL. `undefined` while the tunnel is down — the child
   * exited unexpectedly, a relaunch is pending, or relaunching gave up — so
   * every per-snapshot read stops advertising a dead URL.
   */
  url: string | undefined
  process: TunnelChildProcess
  stop: () => Promise<void>
}

export async function startTunnelWithFallback(options: {
  startCloudflare: () => Promise<InternetTunnelInstance>
  startPinggy: () => Promise<InternetTunnelInstance>
  forceCloudflareFailure?: boolean
  log?: (message: string) => void
}): Promise<InternetTunnelInstance> {
  try {
    if (options.forceCloudflareFailure) {
      throw new Error('Cloudflare failure forced by DSH_TUNNEL_FORCE_PINGGY')
    }
    return await options.startCloudflare()
  } catch (cloudflareError) {
    const cloudflareMessage = errorMessage(cloudflareError)
    options.log?.(`[tunnel] Cloudflare unavailable, falling back to Pinggy: ${cloudflareMessage}`)
    try {
      return await options.startPinggy()
    } catch (pinggyError) {
      throw new Error(
        `Unable to create an internet tunnel. Cloudflare: ${cloudflareMessage}; Pinggy: ${errorMessage(pinggyError)}`
      )
    }
  }
}

/** Automatic-relaunch policy for a tunnel whose child died unexpectedly. */
export const TUNNEL_RELAUNCH_START_MS = 500
export const TUNNEL_RELAUNCH_MAX_MS = 30_000
export const TUNNEL_RELAUNCH_MAX_ATTEMPTS = 5

/** Exponential backoff for relaunch attempt N, capped at `maxMs`. */
export function tunnelRelaunchDelayMs(
  attempt: number,
  startMs = TUNNEL_RELAUNCH_START_MS,
  maxMs = TUNNEL_RELAUNCH_MAX_MS
): number {
  return Math.min(startMs * 2 ** Math.max(0, attempt - 1), maxMs)
}

export interface TunnelExitDetail {
  code: number | null
  signal: NodeJS.Signals | null
}

/**
 * F3: after a tunnel has connected, its child's death used to be ignored and
 * the desktop kept advertising a dead URL. Watch `exit`/`close` post-connect
 * and report an unexpected death exactly once — Node fires both events for a
 * single death, and a death caused by the host's own `stop()` is never
 * unexpected.
 */
export function watchPostConnectExit(
  child: TunnelChildProcess,
  handlers: {
    isHostStopped: () => boolean
    onUnexpectedExit: (detail: TunnelExitDetail) => void
  }
): void {
  let handled = false
  const handle = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (handled || handlers.isHostStopped()) return
    handled = true
    handlers.onUnexpectedExit({ code, signal })
  }
  child.once('exit', handle)
  child.once('close', handle)
}

export interface TunnelRuntimeState {
  provider: InternetTunnelProvider
  active: boolean
  url?: string
  error?: string
}

export interface TunnelSupervisorOptions {
  provider: InternetTunnelProvider
  /** The already-connected tunnel instance to supervise. */
  initial: InternetTunnelInstance
  /** Spawns a fresh, already-connected replacement tunnel. */
  start: () => Promise<InternetTunnelInstance>
  log?: (message: string) => void
  onStateChange?: (state: TunnelRuntimeState) => void
  relaunchStartMs?: number
  relaunchMaxMs?: number
  maxRelaunchAttempts?: number
  /** Injectable wait between relaunch attempts (tests pass a controlled one). */
  delay?: (ms: number) => Promise<void>
}

export interface TunnelSupervisor {
  /**
   * The stable instance callers keep as "the" tunnel: its `url`, `process`,
   * and `stop` always refer to the current child while the supervisor swaps
   * replacements in underneath it.
   */
  instance: InternetTunnelInstance
  /** Feed a raw instance's post-connect unexpected-exit reports in here. */
  handleUnexpectedExit: (detail: TunnelExitDetail) => void
  stop: () => Promise<void>
}

/**
 * F3: keeps one logical tunnel alive across unexpected child deaths.
 *
 * Because callers hold `instance` across relaunches, its `url` is the state
 * channel: the live URL while connected, `undefined` while down — every
 * snapshot read then stops advertising a dead URL. Relaunches are
 * single-flight with exponential backoff (500ms doubling to a 30s cap, a
 * bounded number of attempts); a host-initiated stop never relaunches, and
 * a successful relaunch resets the backoff for any future death.
 */
export function superviseTunnel(options: TunnelSupervisorOptions): TunnelSupervisor {
  const maxAttempts = options.maxRelaunchAttempts ?? TUNNEL_RELAUNCH_MAX_ATTEMPTS
  const relaunchStartMs = options.relaunchStartMs ?? TUNNEL_RELAUNCH_START_MS
  const relaunchMaxMs = options.relaunchMaxMs ?? TUNNEL_RELAUNCH_MAX_MS
  const delay = options.delay ?? defaultTunnelDelay

  let current = options.initial
  let stopped = false
  let active = true
  let relaunchInFlight = false
  let lastError: string | undefined

  const emitState = (): void => {
    options.onStateChange?.({
      provider: options.provider,
      active,
      ...(active && current.url ? { url: current.url } : {}),
      ...(lastError ? { error: lastError } : {})
    })
  }

  const instance: InternetTunnelInstance = {
    get provider() {
      return options.provider
    },
    get url() {
      return active ? current.url : undefined
    },
    get process() {
      return current.process
    },
    stop: () => stopSupervisor()
  }

  async function stopSupervisor(): Promise<void> {
    if (stopped) return
    stopped = true
    active = false
    await current.stop().catch(() => undefined)
    options.log?.(`[tunnel] ${options.provider} tunnel stopped.`)
    emitState()
  }

  function handleUnexpectedExit(detail: TunnelExitDetail): void {
    if (stopped) return
    const source = detail.signal ? `signal ${detail.signal}` : `code ${detail.code}`
    lastError = `${options.provider} tunnel process exited unexpectedly (${source})`
    active = false
    options.log?.(`[tunnel] ${lastError}; will retry.`)
    emitState()
    void relaunchLoop()
  }

  async function relaunchLoop(): Promise<void> {
    // Single-flight: duplicate exit reports or a death racing an in-flight
    // relaunch must never spawn a second replacement loop.
    if (stopped || relaunchInFlight) return
    relaunchInFlight = true
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (stopped) return
        const ms = tunnelRelaunchDelayMs(attempt, relaunchStartMs, relaunchMaxMs)
        options.log?.(
          `[tunnel] Relaunching ${options.provider} tunnel in ${ms}ms (attempt ${attempt}/${maxAttempts}).`
        )
        await delay(ms)
        if (stopped) return
        try {
          const next = await options.start()
          if (stopped) {
            // The host stopped us while the replacement was connecting; do
            // not orphan the fresh child.
            await next.stop().catch(() => undefined)
            return
          }
          current = next
          active = true
          lastError = undefined
          options.log?.(`[tunnel] ${options.provider} tunnel reconnected: ${next.url}`)
          emitState()
          return
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
          options.log?.(
            `[tunnel] ${options.provider} tunnel relaunch attempt ${attempt} failed: ${lastError}`
          )
        }
      }
      if (!stopped) {
        options.log?.(
          `[tunnel] ${options.provider} tunnel gave up after ${maxAttempts} relaunch attempts: ${lastError}`
        )
        emitState()
      }
    } finally {
      relaunchInFlight = false
    }
  }

  emitState()
  return { instance, handleUnexpectedExit, stop: stopSupervisor }
}

function defaultTunnelDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // unref: a pending backoff wait must never hold the app open at shutdown.
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
