import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { parse } from 'yaml'

/**
 * GLM Coding Plan quota polling.
 *
 * Z.AI exposes the plan's server-side usage windows at
 * `/api/monitor/usage/quota/limit` on the same origin the provider's API base
 * URL uses. The `TOKENS_LIMIT` entry carries the percentage consumed inside the
 * rolling 5-hour window plus the wall-clock time it resets, which is exactly
 * the progress the chat status line and the statistics sheet surface.
 *
 * The desktop reads the provider's `apiKeyEnv` indirection from the Harness
 * `settings.yaml` instead of duplicating provider configuration: whichever
 * provider entry points at api.z.ai or open.bigmodel.cn donates its host and
 * its key environment variable. The key itself never crosses the IPC boundary.
 */

export type GlmQuotaLimit = {
  percentage: number
  nextResetTime: string | null
}

export type GlmQuotaSnapshot =
  | { status: 'ok'; checkedAt: number; tokens: GlmQuotaLimit; session: GlmQuotaLimit | null }
  | { status: 'no-key'; checkedAt: number }
  | { status: 'unavailable'; checkedAt: number; reason: string }
  | { status: 'error'; checkedAt: number; reason: string }

type ProviderSettings = {
  baseURL?: string
  apiKeyEnv?: string
}

const POLL_INTERVAL_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10 * 1000
const KNOWN_QUOTA_HOSTS = ['api.z.ai', 'open.bigmodel.cn']

let cachedSnapshot: GlmQuotaSnapshot = { status: 'unavailable', checkedAt: 0, reason: 'never polled' }
let inFlightRefresh: Promise<GlmQuotaSnapshot> | null = null

function readHarnessProvider(): { origin: string; apiKey: string } | null {
  let provider: ProviderSettings | null = null
  try {
    const settings = parse(
      readFileSync(join(app.getPath('userData'), 'harness', 'settings.yaml'), 'utf8')
    ) as {
      providers?: Record<string, ProviderSettings>
      'llm-pi-ai'?: { providers?: Record<string, ProviderSettings> }
    }
    // The active provider table lives under the llm-pi-ai plugin section;
    // older installs kept it at the top level.
    const tables = [settings['llm-pi-ai']?.providers, settings.providers]
    for (const table of tables) {
      for (const candidate of Object.values(table ?? {})) {
        const base = candidate?.baseURL ?? ''
        if (KNOWN_QUOTA_HOSTS.some((host) => base.includes(host))) {
          provider = candidate
          break
        }
      }
      if (provider !== null) break
    }
  } catch {
    return null
  }
  if (provider === null) return null
  let origin: string
  try {
    origin = new URL(provider.baseURL ?? '').origin
  } catch {
    return null
  }
  const keyEnv = provider.apiKeyEnv ?? ''
  // Fall back to the well-known GLM key variables when the configured one is
  // unset — installs commonly export ZHIPU_API_KEY while settings name
  // ZAI_API_KEY (or the reverse), and they are the same credential.
  const candidates = [keyEnv, 'ZAI_API_KEY', 'ZHIPU_API_KEY'].filter(
    (name, index, all) => name !== '' && all.indexOf(name) === index
  )
  for (const name of candidates) {
    const apiKey = (process.env[name] ?? '').trim()
    if (apiKey !== '') return { origin, apiKey }
  }
  // The app's own Settings UI stores entered keys in the Harness credential
  // store (harness/.credentials.yaml) keyed by the env-var name they back.
  // Read it last so a real environment variable always wins.
  try {
    const credentials = parse(
      readFileSync(join(app.getPath('userData'), 'harness', '.credentials.yaml'), 'utf8')
    ) as { refs?: Record<string, string> }
    for (const name of candidates) {
      const apiKey = (credentials.refs?.[name] ?? '').trim()
      if (apiKey !== '') return { origin, apiKey }
    }
  } catch {
    // no credential store — fall through
  }
  return null
}

async function refreshSnapshot(): Promise<GlmQuotaSnapshot> {
  const checkedAt = Date.now()
  const provider = readHarnessProvider()
  if (provider === null) {
    return { status: 'no-key', checkedAt }
  }
  try {
    const response = await fetch(`${provider.origin}/api/monitor/usage/quota/limit`, {
      headers: { Authorization: provider.apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (!response.ok) {
      const reason = `HTTP ${response.status}`
      // 403 means the plan tier does not expose the monitoring API; treat that
      // as a stable "not available for this plan" rather than a failure.
      return { status: response.status === 403 ? 'unavailable' : 'error', checkedAt, reason }
    }
    const body = (await response.json()) as {
      success?: boolean
      code?: number
      data?: { limits?: Array<{ type?: string; percentage?: number; nextResetTime?: string | null }> }
    }
    if (body.success !== true || body.code !== 200 || body.data === undefined) {
      return { status: 'error', checkedAt, reason: `API code=${String(body.code)}` }
    }
    let tokens: GlmQuotaLimit | null = null
    let session: GlmQuotaLimit | null = null
    for (const limit of body.data.limits ?? []) {
      if (typeof limit.percentage !== 'number') continue
      if (limit.type === 'TOKENS_LIMIT') {
        tokens = { percentage: limit.percentage, nextResetTime: limit.nextResetTime ?? null }
      } else if (limit.type === 'TIME_LIMIT') {
        session = { percentage: limit.percentage, nextResetTime: limit.nextResetTime ?? null }
      }
    }
    if (tokens === null) {
      return { status: 'unavailable', checkedAt, reason: 'no TOKENS_LIMIT in response' }
    }
    return { status: 'ok', checkedAt, tokens, session }
  } catch (error) {
    return { status: 'error', checkedAt, reason: error instanceof Error ? error.message : String(error) }
  }
}

function stale(snapshot: GlmQuotaSnapshot): boolean {
  return Date.now() - snapshot.checkedAt > POLL_INTERVAL_MS
}

/**
 * Serve the cached snapshot, refreshing it in the background when older than
 * the poll interval. The renderer polls this on its own cadence, so no push
 * channel is needed and a slow quota API never blocks a render.
 */
export async function getSnapshot(): Promise<GlmQuotaSnapshot> {
  if (inFlightRefresh !== null) return inFlightRefresh
  if (stale(cachedSnapshot)) {
    inFlightRefresh = refreshSnapshot()
      .then((snapshot) => {
        cachedSnapshot = snapshot
        return snapshot
      })
      .finally(() => {
        inFlightRefresh = null
      })
    return inFlightRefresh
  }
  return cachedSnapshot
}

export function registerGlmQuotaIpc(): void {
  ipcMain.handle('glm-quota:get', () => getSnapshot())
}

/** Test hook: forget the cached snapshot and in-flight refresh. */
export function _resetCache(): void {
  cachedSnapshot = { status: 'unavailable', checkedAt: 0, reason: 'never polled' }
  inFlightRefresh = null
}
