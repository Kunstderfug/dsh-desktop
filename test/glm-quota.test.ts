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
  let glmQuotaProviders: (snapshot: unknown) => string[]
  let glmQuotaApplies: (snapshot: unknown, selection: unknown) => boolean

  beforeAll(async () => {
    const source = await readFile(chatBundle, 'utf8')
    const take = (name: string): string => {
      const start = source.indexOf(`function ${name}(`)
      expect(start, name).toBeGreaterThan(-1)
      return source.slice(start, source.indexOf('\n\t\t}\n', start) + 4)
    }
    const factory = new Function(
      `${take('quotaCountdown')}\n${take('quotaBar')}\n${take('quotaText')}\n${take('glmQuotaProviders')}\n${take('glmQuotaApplies')}\nreturn { quotaCountdown, quotaBar, quotaText, glmQuotaProviders, glmQuotaApplies }`
    )
    ;({ quotaCountdown, quotaBar, quotaText, glmQuotaProviders, glmQuotaApplies } = factory())
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

  it('reads the GLM route ids only from an ok snapshot', () => {
    expect(glmQuotaProviders({ status: 'ok', providers: ['zai'] })).toEqual(['zai'])
    expect(glmQuotaProviders({ status: 'ok', providers: [] })).toEqual([])
    expect(glmQuotaProviders({ status: 'ok' })).toEqual([])
    expect(glmQuotaProviders({ status: 'no-key', providers: ['zai'] })).toEqual([])
    expect(glmQuotaProviders({ status: 'unavailable', providers: ['zai'] })).toEqual([])
    expect(glmQuotaProviders(null)).toEqual([])
    expect(glmQuotaProviders(undefined)).toEqual([])
  })

  it('shows the surfaces only for a session running a GLM route', () => {
    const ok = { status: 'ok', providers: ['zai', 'zai-coding-cn'] }
    expect(glmQuotaApplies(ok, { provider: 'zai' })).toBe(true)
    expect(glmQuotaApplies(ok, { provider: 'zai-coding-cn' })).toBe(true)
    expect(glmQuotaApplies(ok, { provider: 'deepseek-official' })).toBe(false)
    // no selection yet, or a selection without a provider, stays hidden
    expect(glmQuotaApplies(ok, null)).toBe(false)
    expect(glmQuotaApplies(ok, undefined)).toBe(false)
    expect(glmQuotaApplies(ok, {})).toBe(false)
    // a non-ok or provider-less snapshot hides even a GLM session
    expect(glmQuotaApplies({ status: 'error' }, { provider: 'zai' })).toBe(false)
    expect(glmQuotaApplies({ status: 'ok', providers: [] }, { provider: 'zai' })).toBe(false)
    expect(glmQuotaApplies({ status: 'ok' }, { provider: 'zai' })).toBe(false)
    expect(glmQuotaApplies(null, { provider: 'zai' })).toBe(false)
  })
})

describe('the shipped chat bundle', () => {
  it('carries the quota pill, row, and hook', async () => {
    const source = await readFile(chatBundle, 'utf8')
    expect(source).toContain('function GlmQuotaPill(')
    expect(source).toContain('function GlmQuotaRow(')
    expect(source).toContain('function useGlmQuota(')
    expect(source).toContain('(0, react_jsx_runtime.jsx)(GlmQuotaPill, { quota })')
    expect(source).toContain('(0, react_jsx_runtime.jsx)(GlmQuotaRow, { t, quota })')
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

  it('reads the key from the Harness credential store when no env var is set', async () => {
    writeFileSync(
      path.join(testHome, 'harness', '.credentials.yaml'),
      'version: 1\nrecords: {}\nrefs:\n  ZAI_API_KEY: credstore-key-value\n'
    )
    setup(settingsYaml, new Response('{"success":true,"code":200,"data":{"limits":[{"type":"TOKENS_LIMIT","percentage":9}]}}', { status: 200 }))
    const snapshot = await handler() as { status: string }
    expect(snapshot.status).toBe('ok')
  })

  it('prefers an environment variable over the credential store', async () => {
    writeFileSync(
      path.join(testHome, 'harness', '.credentials.yaml'),
      'version: 1\nrecords: {}\nrefs:\n  ZAI_API_KEY: credstore-key-value\n'
    )
    setup(settingsYaml, new Response('{"success":true,"code":200,"data":{"limits":[{"type":"TOKENS_LIMIT","percentage":9}]}}', { status: 200 }))
    process.env.ZAI_API_KEY = 'env-key-wins'
    const snapshot = await handler() as { status: string }
    expect(snapshot.status).toBe('ok')
  })

  it('publishes the provisioning route id of every GLM provider', async () => {
    setup(
      settingsYaml,
      new Response('{"success":true,"code":200,"data":{"limits":[{"type":"TOKENS_LIMIT","percentage":3}]}}', { status: 200 })
    )
    process.env.ZAI_API_KEY = 'test-key'
    const snapshot = (await handler()) as { status: string; providers: string[] }
    expect(snapshot.status).toBe('ok')
    expect(snapshot.providers).toEqual(['zai'])
  })

  it('publishes every GLM route id and skips non-GLM providers', async () => {
    setup(
      'llm-pi-ai:\n  providers:\n    zai:\n      baseURL: https://api.z.ai/api/coding/paas/v4\n      apiKeyEnv: ZAI_API_KEY\n    zai-coding-cn:\n      baseURL: https://open.bigmodel.cn/api/coding/paas/v4\n      apiKeyEnv: ZAI_API_KEY\n    deepseek-official:\n      baseURL: https://api.deepseek.com\n      apiKeyEnv: DEEPSEEK_API_KEY\n',
      new Response('{"success":true,"code":200,"data":{"limits":[{"type":"TOKENS_LIMIT","percentage":3}]}}', { status: 200 })
    )
    process.env.ZAI_API_KEY = 'test-key'
    const snapshot = (await handler()) as { status: string; providers: string[] }
    expect(snapshot.status).toBe('ok')
    expect(snapshot.providers).toEqual(['zai', 'zai-coding-cn'])
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

  it('treats an unparsable settings file as no-key instead of failing the poll', async () => {
    setup('providers: [unclosed\n  bad: :::\n', new Error('should not fetch'))
    const snapshot = (await handler()) as { status: string }
    expect(snapshot.status).toBe('no-key')
  })

  it('resolves through async file reads with the exact snapshot shape', async () => {
    const body = {
      success: true,
      code: 200,
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', percentage: 41.6, nextResetTime: '2026-09-12T14:30:00Z' },
          { type: 'TIME_LIMIT', percentage: 12, nextResetTime: null }
        ]
      }
    }
    setup(settingsYaml, new Response(JSON.stringify(body), { status: 200 }))
    process.env.ZAI_API_KEY = 'test-key'
    const pending = handler()
    // The provider read is asynchronous: callers get a promise immediately
    // instead of blocking the main process on disk I/O.
    expect(typeof (pending as Promise<unknown>).then).toBe('function')
    expect(await pending).toEqual({
      status: 'ok',
      checkedAt: expect.any(Number),
      providers: ['zai'],
      tokens: { percentage: 41.6, nextResetTime: '2026-09-12T14:30:00Z' },
      session: { percentage: 12, nextResetTime: null }
    })
  })

  it('reads the harness files off the synchronous main-process path', async () => {
    const source = await readFile(path.join(projectRoot, 'src', 'main', 'glm-quota.ts'), 'utf8')
    expect(source).not.toContain('readFileSync')
    expect(source).toContain('await readFile(')
  })
})

describe('the preload bridge', () => {
  it('exposes dshGlmQuota.get over the context bridge', async () => {
    const source = await readFile(path.join(projectRoot, 'src', 'preload', 'index.ts'), 'utf8')
    expect(source).toContain('dshGlmQuota')
    expect(source).toContain("ipcRenderer.invoke('glm-quota:get')")
  })
})
