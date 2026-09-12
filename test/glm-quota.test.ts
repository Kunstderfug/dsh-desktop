import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { beforeAll, afterEach, vi, it, describe, expect } from 'vitest'
import { projectRoot } from './patch-path'
import { getSnapshot, _resetCache, registerGlmQuotaIpc } from '../src/main/glm-quota'

const chatBundle = path.join(
  projectRoot,
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-chat',
  'lib',
  'client.js'
)

vi.mock('electron', () => ({
  app: { getPath: () => testHome },
  ipcMain: { handle: vi.fn() }
}))

let testHome: string

/**
 * The chat status line and the statistics sheet render the GLM Coding Plan
 * quota that the desktop main process polls from Z.AI's monitoring endpoint.
 * These tests drive the shipped bundle functions and the real IPC module.
 */

describe('chat bundle quota helpers', () => {
  let quotaCountdown: (iso: string, now: number) => string | null
  let quotaBar: (percentage: number) => string
  let quotaText: (snapshot: unknown, now: number) => string | null

  beforeAll(async () => {
    const source = await readFile(chatBundle, 'utf8')
    const take = (name: string): string => {
      const start = source.indexOf(`function ${name}(`)
      expect(start, name).toBeGreaterThan(-1)
      return source.slice(start, source.indexOf('\n\t\t}\n', start) + 4)
    }
    const factory = new Function(
      `${take('quotaCountdown')}\n${take('quotaBar')}\n${take('quotaText')}\nreturn { quotaCountdown, quotaBar, quotaText }`
    )
    ;({ quotaCountdown, quotaBar, quotaText } = factory())
  })

  it('renders an eight-cell bar clamped to 0-100%', () => {
    expect(quotaBar(0)).toBe('░░░░░░░░')
    expect(quotaBar(50)).toBe('████░░░░')
    expect(quotaBar(100)).toBe('████████')
    expect(quotaBar(-5)).toBe('░░░░░░░░')
    expect(quotaBar(200)).toBe('████████')
  })

  it('formats the reset countdown in hours and minutes', () => {
    const now = new Date('2026-09-12T12:00:00Z').getTime()
    expect(quotaCountdown('2026-09-12T14:13:00Z', now)).toBe('2h13m')
    expect(quotaCountdown('2026-09-12T12:05:00Z', now)).toBe('5m')
    expect(quotaCountdown('2026-09-12T11:00:00Z', now)).toBe('0m')
    expect(quotaCountdown('not a date', now)).toBeNull()
  })

  it('renders nothing unless the snapshot status is ok', () => {
    const now = Date.now()
    expect(quotaText(null, now)).toBeNull()
    expect(quotaText({ status: 'no-key' }, now)).toBeNull()
    expect(quotaText({ status: 'error' }, now)).toBeNull()
  })

  it('combines percentage, bar, and countdown for an ok snapshot', () => {
    const now = new Date('2026-09-12T12:00:00Z').getTime()
    const snapshot = {
      status: 'ok',
      tokens: { percentage: 41.6, nextResetTime: '2026-09-12T14:30:00Z' }
    }
    expect(quotaText(snapshot, now)).toBe('GLM ███░░░░░ 42% · 2h30m')
  })

  it('omits the separator when no reset time is known', () => {
    const now = Date.now()
    const snapshot = { status: 'ok', tokens: { percentage: 0, nextResetTime: null } }
    expect(quotaText(snapshot, now)).toBe('GLM ░░░░░░░░ 0%')
  })
})

describe('the shipped chat bundle', () => {
  it('carries the quota pill, row, and hook', async () => {
    const source = await readFile(chatBundle, 'utf8')
    expect(source).toContain('function GlmQuotaPill(')
    expect(source).toContain('function GlmQuotaRow(')
    expect(source).toContain('function useGlmQuota(')
    expect(source).toContain('(0, react_jsx_runtime.jsx)(GlmQuotaPill, {})')
    expect(source).toContain('(0, react_jsx_runtime.jsx)(GlmQuotaRow, { t })')
    expect(source).toContain('"stats.dialog.glmQuota": "GLM plan"')
    expect(source).toContain('"stats.dialog.glmQuota": "GLM 套餐"')
    // the pill must read the desktop bridge, never a raw endpoint
    expect(source).toContain('window.dshGlmQuota?.get')
    expect(source).not.toContain('api/monitor/usage/quota/limit')
    // both surfaces share the gradient meter, and it shifts hue with usage
    expect(source).toContain('function quotaMeter(')
    expect(source).toContain('linear-gradient(90deg, hsl(')
  })
})

describe('main-process quota poller', () => {
  beforeAll(() => {
    testHome = mkdtempSync(path.join(tmpdir(), 'dsh-glm-quota-'))
    mkdirSync(path.join(testHome, 'harness'), { recursive: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.ZAI_API_KEY
    vi.clearAllMocks()
  })

  let handler: () => Promise<{ status: string }>

  function setup(settings: string, fetchResult: Response | Error): void {
    writeFileSync(path.join(testHome, 'harness', 'settings.yaml'), settings)
    vi.stubGlobal(
      'fetch',
      vi.fn(() => (fetchResult instanceof Error ? Promise.reject(fetchResult) : Promise.resolve(fetchResult)))
    )
    _resetCache()
    handler = () => getSnapshot()
  }
  const settingsYaml = 'providers:\n  zai:\n    baseURL: https://api.z.ai/api/coding/paas/v4\n    apiKeyEnv: ZAI_API_KEY\n'

  it('reports no-key when no GLM provider is configured', async () => {
    setup('locale:\n  preference: en\n', new Error('should not fetch'))
    const snapshot = (await handler()) as { status: string }
    expect(snapshot.status).toBe('no-key')
  })

  it('reports no-key when the key environment variable is unset', async () => {
    setup(settingsYaml, new Error('should not fetch'))
    const snapshot = (await handler()) as { status: string }
    expect(snapshot.status).toBe('no-key')
  })

  it('reads the provider from the llm-pi-ai section and falls back to ZHIPU_API_KEY', async () => {
    setup(
      'llm-pi-ai:\n  providers:\n    zai:\n      baseURL: https://api.z.ai/api/coding/paas/v4\n      apiKeyEnv: ZAI_API_KEY\n',
      new Response('{"success":true,"code":200,"data":{"limits":[{"type":"TOKENS_LIMIT","percentage":7}]}}', { status: 200 })
    )
    process.env.ZHIPU_API_KEY = 'zhipu-fallback-key'
    const snapshot = await handler() as { status: string }
    expect(snapshot.status).toBe('ok')
    delete process.env.ZHIPU_API_KEY
  })

  it('maps a plan without monitoring access to unavailable', async () => {
    setup(settingsYaml, new Response('{}', { status: 403 }))
    process.env.ZAI_API_KEY = 'test-key'
    const snapshot = (await handler()) as { status: string }
    expect(snapshot.status).toBe('unavailable')
  })

  it('parses the 5-hour token window and session window from an ok response', async () => {
    const body = {
      success: true,
      code: 200,
      data: {
        level: 'glm-coding-pro',
        limits: [
          { type: 'TOKENS_LIMIT', percentage: 41.6, nextResetTime: '2026-09-12T14:30:00Z' },
          { type: 'TIME_LIMIT', percentage: 12, nextResetTime: null }
        ]
      }
    }
    setup(settingsYaml, new Response(JSON.stringify(body), { status: 200 }))
    process.env.ZAI_API_KEY = 'test-key'
    const snapshot = (await handler()) as { status: string; tokens: { percentage: number }; session: unknown }
    expect(snapshot.status).toBe('ok')
    expect(snapshot.tokens.percentage).toBe(41.6)
    expect(snapshot.session).not.toBeNull()
  })

  it('surfaces network errors as error snapshots instead of throwing', async () => {
    setup(settingsYaml, new Error('connect ECONNREFUSED'))
    process.env.ZAI_API_KEY = 'test-key'
    const snapshot = (await handler()) as { status: string; reason: string }
    expect(snapshot.status).toBe('error')
    expect(snapshot.reason).toContain('ECONNREFUSED')
  })

  it('never sends the API key to the renderer', async () => {
    setup(
      settingsYaml,
      new Response('{"success":true,"code":200,"data":{"limits":[{"type":"TOKENS_LIMIT","percentage":1}]}}', {
        status: 200
      })
    )
    process.env.ZAI_API_KEY = 'super-secret-key'
    const snapshot = (await handler()) as Record<string, unknown>
    expect(JSON.stringify(snapshot)).not.toContain('super-secret-key')
  })
})

describe('the preload bridge', () => {
  it('exposes dshGlmQuota.get over the context bridge', async () => {
    const source = await readFile(path.join(projectRoot, 'src', 'preload', 'index.ts'), 'utf8')
    expect(source).toContain('dshGlmQuota')
    expect(source).toContain("ipcRenderer.invoke('glm-quota:get')")
  })
})
