import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { patchPath, projectRoot } from './patch-path'

const chatBundle = path.join(
  projectRoot,
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-chat',
  'lib',
  'client.js'
)
const meterBundle = path.join(
  projectRoot,
  'node_modules',
  '@deepseek-ai',
  'dsh-token-meter',
  'lib',
  'index.js'
)

interface PriceWindow {
  peak: number
  offPeak: number
}
interface PriceRow {
  cacheRead: PriceWindow
  uncachedInput: PriceWindow
  cacheWrite: PriceWindow
  output: PriceWindow
}
interface Price {
  usd: number
  partial: boolean
}
interface Buckets {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}
interface Route {
  provider: string
  model: string
  peak: Buckets
  offPeak: Buckets
}
interface ChatExports {
  SESSION_PRICE_TABLE: Record<string, PriceRow>
  sessionPrice(routes: unknown): Price | null
  formatSessionPrice(price: Price): string
}

const buckets = (
  uncachedInputTokens = 0,
  outputTokens = 0,
  cacheReadTokens = 0,
  cacheWriteTokens = 0
): Buckets => ({ uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens })

const route = (
  model: string,
  peak: Buckets = buckets(),
  offPeak: Buckets = buckets(),
  provider = 'deepseek-official'
): Route => ({ provider, model, peak, offPeak })

/**
 * Load the real browser assembly and hand its factory a real `require`, so the
 * pricing fold under test is the shipped one rather than a restatement of it.
 *
 * The presentation-only packages are stubbed: the desktop root does not install
 * their transitive `clsx`, and every export the bundle touches at module scope
 * is a component it merely stores.
 */
async function chatExports(): Promise<ChatExports> {
  const source = await readFile(chatBundle, 'utf8')
  let definition: { factory(require: (id: string) => unknown): ChatExports } | undefined
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load(value: { factory(require: (id: string) => unknown): ChatExports }) {
          definition = value
        }
      }
    },
    console
  })
  if (definition === undefined) throw new Error('the chat bundle registered no module definition')

  const realRequire = createRequire(path.join(projectRoot, 'package.json'))
  const presentationOnly = new Set([
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-store',
    'react-dom'
  ])
  interface PresentationStub {
    (...args: unknown[]): unknown
  }
  const stub: PresentationStub = new Proxy(function presentationStub(): unknown { return stub }, {
    get: (_target, key) => (typeof key === 'symbol' ? undefined : stub),
    apply: () => stub,
    construct: () => stub
  })
  const require = (id: string): unknown =>
    presentationOnly.has(id) ? stub : realRequire(id)

  return definition.factory(require)
}

/** The month is September 2026: the 7th is a Monday, the 12th a Saturday. */
const utc = (day: number, hour: number) => Date.UTC(2026, 8, day, hour, 0, 0)

interface FoldRow {
  provider: string
  model: string
  peak: Buckets
  offPeak: Buckets
}
interface Fold {
  key: string
  stateVersion: number
  stateSchema: { safeParse(value: unknown): { success: boolean } }
  init(header: unknown, inheritedEventCount: number): unknown
  apply(state: unknown, event: unknown): unknown
  wire: {
    view(state: unknown): FoldRow[]
    viewSchema: { safeParse(value: unknown): { success: boolean } }
  }
}

async function routeUsageFold(): Promise<Fold> {
  const meter = (await import('@deepseek-ai/dsh-token-meter')) as unknown as {
    routeUsageProjectionDefinition: Fold
  }
  return meter.routeUsageProjectionDefinition
}

const settlement = (
  turn: number,
  step: number,
  model: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number },
  time: number
) => ({
  type: 'assistant/message',
  seq: 1,
  time,
  data: {
    turn,
    step,
    message: { source: { provider: 'deepseek-official', model } },
    usage
  }
})

describe('session price in the statistics sheet', () => {
  it('publishes the DeepSeek list rates in USD per million tokens', async () => {
    const { SESSION_PRICE_TABLE: table } = await chatExports()

    expect(table.deepseekFlash).toEqual({
      cacheRead: { peak: 0.006, offPeak: 0.003 },
      uncachedInput: { peak: 0.3, offPeak: 0.15 },
      cacheWrite: { peak: 0.3, offPeak: 0.15 },
      output: { peak: 1.2, offPeak: 0.6 }
    })
    expect(table.deepseekPro).toEqual({
      cacheRead: { peak: 0.044, offPeak: 0.022 },
      uncachedInput: { peak: 1.32, offPeak: 0.66 },
      cacheWrite: { peak: 1.32, offPeak: 0.66 },
      output: { peak: 3.96, offPeak: 1.98 }
    })
  })

  it('prices each route in its own billing window and sums them', async () => {
    const { sessionPrice } = await chatExports()

    const price = sessionPrice([
      route('deepseek-v4-pro', buckets(1_000_000, 1_000_000), buckets(1_000_000, 0, 1_000_000)),
      route('deepseek-flash', buckets(1_000_000))
    ])

    // pro peak 1.32 + 3.96, pro off-peak 0.66 + 0.022, flash peak 0.3
    expect(price?.usd).toBeCloseTo(5.28 + 0.682 + 0.3, 10)
    expect(price?.partial).toBe(false)
  })

  it('bills the retired Flash ids at the Flash rate', async () => {
    const { sessionPrice } = await chatExports()

    for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
      expect(sessionPrice([route(model, buckets(1_000_000))])?.usd).toBeCloseTo(0.3, 10)
    }
  })

  it('reports a lower bound when a route has no published price', async () => {
    const { sessionPrice } = await chatExports()

    const price = sessionPrice([
      route('deepseek-flash', buckets(1_000_000)),
      route('other-model', buckets(1_000_000), buckets(), 'openrouter')
    ])

    expect(price).toEqual({ usd: 0.3, partial: true })
  })

  it('shows nothing before anything is billed', async () => {
    const { sessionPrice } = await chatExports()

    expect(sessionPrice(undefined)).toBeNull()
    expect(sessionPrice([])).toBeNull()
    expect(sessionPrice([route('deepseek-flash')])).toBeNull()
  })

  it('keeps small amounts legible and marks a partial total', async () => {
    const { formatSessionPrice } = await chatExports()

    expect(formatSessionPrice({ usd: 0, partial: false })).toBe('$0.0000')
    expect(formatSessionPrice({ usd: 0.003, partial: false })).toBe('$0.0030')
    expect(formatSessionPrice({ usd: 0.3, partial: true })).toBe('≥$0.3000')
    expect(formatSessionPrice({ usd: 12.3, partial: false })).toBe('$12.30')
  })

  it('renders the price row after the tokens-per-second row of the sheet', async () => {
    const chat = await readFile(chatBundle, 'utf8')

    expect(chat).toContain('useProjection("routeUsage")')
    expect(chat).toContain('"stats.dialog.price"')

    const details = chat.slice(chat.indexOf('"data-session-stats-details": true'))
    const speed = details.indexOf('stats.dialog.speed')
    const price = details.indexOf('stats.dialog.price')
    expect(speed).toBeGreaterThanOrEqual(0)
    expect(price).toBeGreaterThan(speed)
  })

  it('carries the pricing and projection in the reproducible dependency patches', async () => {
    const [chatPatch, meterPatch] = await Promise.all([
      readFile(patchPath('@deepseek-ai/dsh-client-ui-chat'), 'utf8'),
      readFile(patchPath('@deepseek-ai/dsh-token-meter'), 'utf8')
    ])

    expect(chatPatch).toContain('stats.dialog.price')
    expect(chatPatch).toContain('sessionPrice')
    expect(meterPatch).toContain('routeUsageProjectionDefinition')
    expect(meterPatch).toContain('register(routeUsageProjectionDefinition)')
  })
})

describe('durable per-route usage projection', () => {
  it('splits one settlement into its provider/model row and billing window', async () => {
    const fold = await routeUsageFold()
    let state = fold.init(undefined, 0)

    state = fold.apply(state, settlement(1, 1, 'deepseek-v4-pro', { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500 }, utc(7, 2)))
    state = fold.apply(state, settlement(1, 2, 'deepseek-flash', { inputTokens: 2000, outputTokens: 200 }, utc(12, 2)))

    expect(fold.wire.view(state)).toEqual([
      {
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        peak: buckets(1000, 100, 500),
        offPeak: buckets()
      },
      {
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        peak: buckets(),
        offPeak: buckets(2000, 200)
      }
    ])
    expect(fold.wire.viewSchema.safeParse(fold.wire.view(state)).success).toBe(true)
    expect(fold.stateSchema.safeParse(state).success).toBe(true)
  })

  it('replaces a re-settled attempt instead of double counting it', async () => {
    const fold = await routeUsageFold()
    let state = fold.init(undefined, 0)

    state = fold.apply(state, settlement(1, 1, 'deepseek-flash', { inputTokens: 2000, outputTokens: 200 }, utc(7, 2)))
    state = fold.apply(state, settlement(1, 1, 'deepseek-flash', { inputTokens: 3000, outputTokens: 300 }, utc(7, 2)))

    expect(fold.wire.view(state)).toEqual([
      {
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        peak: buckets(3000, 300),
        offPeak: buckets()
      }
    ])
  })

  it('adds a retried attempt after the retry closes the replacement slot', async () => {
    const fold = await routeUsageFold()
    let state = fold.init(undefined, 0)

    state = fold.apply(state, settlement(1, 1, 'deepseek-flash', { inputTokens: 2000, outputTokens: 200 }, utc(7, 2)))
    state = fold.apply(state, { type: 'llm/retry-started', seq: 2, time: utc(7, 2), data: { turn: 1, step: 1 } })
    state = fold.apply(state, settlement(1, 1, 'deepseek-flash', { inputTokens: 500, outputTokens: 50 }, utc(7, 4)))

    expect(fold.wire.view(state)).toEqual([
      {
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        peak: buckets(2000, 200),
        offPeak: buckets(500, 50)
      }
    ])
  })

  it('leaves unrelated events and unchanged samples without downstream work', async () => {
    const fold = await routeUsageFold()
    let state = fold.init(undefined, 0)

    expect(fold.apply(state, { type: 'turn/start', seq: 1, time: utc(7, 2), data: { turn: 1 } })).toBe(state)

    state = fold.apply(state, settlement(1, 1, 'deepseek-flash', { inputTokens: 10, outputTokens: 1 }, utc(7, 2)))
    const view = fold.wire.view(state)
    expect(fold.apply(state, settlement(1, 1, 'deepseek-flash', { inputTokens: 10, outputTokens: 1 }, utc(7, 2)))).toBe(state)
    expect(fold.wire.view(state)).toBe(view)
  })

  it('registers the unit with the session projection seam', async () => {
    const meter = await readFile(meterBundle, 'utf8')

    expect(meter).toContain('key: "routeUsage"')
    expect(meter).toContain('ctx.sessionProjections.register(routeUsageProjectionDefinition)')
  })
})
