import { mkdir, mkdtemp, readFile, writeFile, appendFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bundlesExist,
  computeSourcesHash,
  computeTemplatesHash,
  isUpToDate,
  markerPath,
  markerVersion,
  readMarker,
  runPipeline,
  steps
} from '../scripts/ppt-build.mjs'

const HEX64 = /^[0-9a-f]{64}$/u

/** Minimal pipeline-shaped workspace: every directory the guard walks exists. */
async function makeFakeRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-ppt-guard-'))
  for (const dir of [
    'scripts/ppt',
    'packages/ppt-runtime/upstream',
    'packages/ppt-runtime/core',
    'packages/ppt-runtime/adapter',
    'packages/ppt-runtime/templates/pack',
    'packages/ppt-bundles'
  ]) {
    await mkdir(path.join(root, dir), { recursive: true })
  }
  await writeFile(path.join(root, 'package.json'), '{\n  "name": "fake"\n}\n')
  await writeFile(path.join(root, 'package-lock.json'), '{\n  "lockfileVersion": 3\n}\n')
  await writeFile(path.join(root, 'scripts/ppt/helper.mjs'), 'export const x = 1\n')
  await writeFile(path.join(root, 'packages/ppt-runtime/core/runtime.mjs'), 'export const y = 2\n')
  await writeFile(path.join(root, 'packages/ppt-runtime/upstream/NOTICE'), 'upstream\n')
  await writeFile(path.join(root, 'packages/ppt-runtime/adapter/index.mjs'), 'export const z = 3\n')
  await writeFile(path.join(root, 'packages/ppt-runtime/templates/pack/page.page'), 'page: one\n')
  await writeFile(path.join(root, 'packages/ppt-runtime/artifacts.json'), JSON.stringify({
    core: { file: 'core.tgz' },
    adapter: { file: 'adapter.tgz' }
  }))
  await writeFile(path.join(root, 'packages/ppt-bundles/core.tgz'), 'core-bytes')
  await writeFile(path.join(root, 'packages/ppt-bundles/adapter.tgz'), 'adapter-bytes')
  return root
}

/** A pipeline "step" that appends one x per actual run and (re)creates the
 * bundle outputs, mirroring what the real pipeline's last step produces. */
async function makeCountingStep(root) {
  const step = path.join(root, 'counting-step.mjs')
  await writeFile(step, [
    "import { appendFile, writeFile } from 'node:fs/promises'",
    `await appendFile(${JSON.stringify(path.join(root, 'runs.log'))}, 'x')`,
    `await writeFile(${JSON.stringify(path.join(root, 'packages/ppt-bundles/core.tgz'))}, 'core-bytes')`,
    `await writeFile(${JSON.stringify(path.join(root, 'packages/ppt-bundles/adapter.tgz'))}, 'adapter-bytes')`
  ].join('\n'))
  return step
}

const runCount = async root => (await readFile(path.join(root, 'runs.log'), 'utf8')).length

describe('ppt build guard hashes', () => {
  it('produces a stable 64-hex digest for the real repository sources', async () => {
    const first = await computeSourcesHash()
    const second = await computeSourcesHash()
    expect(first).toMatch(HEX64)
    expect(second).toBe(first)
  })

  it('changes when a pipeline source changes but not when templates change', async () => {
    const root = await makeFakeRoot()
    const before = await computeSourcesHash(root)
    const templatesBefore = await computeTemplatesHash(root)

    await writeFile(path.join(root, 'packages/ppt-runtime/templates/pack/page.page'), 'page: TWO\n')
    expect(await computeTemplatesHash(root)).not.toBe(templatesBefore)
    expect(await computeSourcesHash(root)).toBe(before)

    await writeFile(path.join(root, 'scripts/ppt/helper.mjs'), 'export const x = 2\n')
    expect(await computeSourcesHash(root)).not.toBe(before)
  })

  it('ignores macOS junk files inside hashed trees', async () => {
    const root = await makeFakeRoot()
    const before = await computeSourcesHash(root)
    await writeFile(path.join(root, 'scripts/ppt/.DS_Store'), 'junk')
    await writeFile(path.join(root, 'packages/ppt-runtime/core/._runtime.mjs'), 'junk')
    expect(await computeSourcesHash(root)).toBe(before)
  })

  it('changes when a dependency manifest changes', async () => {
    const root = await makeFakeRoot()
    const before = await computeSourcesHash(root)
    await writeFile(path.join(root, 'package-lock.json'), '{\n  "lockfileVersion": 3,\n  "changed": true\n}\n')
    expect(await computeSourcesHash(root)).not.toBe(before)
  })
})

describe('ppt build guard skip decision', () => {
  it('skips only on version match, both hashes and existing bundles', () => {
    const marker = { version: markerVersion, sourcesHash: 's', outputsHash: 't' }
    expect(isUpToDate(marker, 's', 't', true)).toBe(true)
    expect(isUpToDate(marker, 'different', 't', true)).toBe(false)
    expect(isUpToDate(marker, 's', 'different', true)).toBe(false)
    expect(isUpToDate(marker, 's', 't', false)).toBe(false)
    expect(isUpToDate(null, 's', 't', true)).toBe(false)
    expect(isUpToDate({ version: 0, sourcesHash: 's', outputsHash: 't' }, 's', 't', true)).toBe(false)
    expect(isUpToDate({ version: markerVersion, sourcesHash: 's' }, 's', 't', true)).toBe(false)
  })

  it('requires both non-empty bundle files listed in artifacts.json', async () => {
    const root = await makeFakeRoot()
    expect(await bundlesExist(root)).toBe(true)

    await rm(path.join(root, 'packages/ppt-bundles/adapter.tgz'))
    expect(await bundlesExist(root)).toBe(false)

    await writeFile(path.join(root, 'packages/ppt-bundles/adapter.tgz'), '')
    expect(await bundlesExist(root)).toBe(false)

    await writeFile(path.join(root, 'packages/ppt-bundles/adapter.tgz'), 'adapter-bytes')
    expect(await bundlesExist(root)).toBe(true)

    await rm(path.join(root, 'packages/ppt-runtime/artifacts.json'))
    expect(await bundlesExist(root)).toBe(false)
  })

  it('reads the marker as null when it is missing or malformed', async () => {
    const root = await makeFakeRoot()
    expect(await readMarker(root)).toBeNull()
    await writeFile(path.join(root, markerPath), 'not json{')
    expect(await readMarker(root)).toBeNull()
  })
})

describe('ppt build guard pipeline', () => {
  it('runs the pipeline once, then skips, then rebuilds on --force', async () => {
    const root = await makeFakeRoot()
    const step = await makeCountingStep(root)

    expect(await runPipeline({ root, steps: [step] })).toEqual({ status: 0 })
    expect(await runCount(root)).toBe(1)
    const marker = await readMarker(root)
    expect(marker.version).toBe(markerVersion)
    expect(marker.sourcesHash).toBe(await computeSourcesHash(root))
    expect(marker.outputsHash).toBe(await computeTemplatesHash(root))

    expect(await runPipeline({ root, steps: [step] })).toEqual({ skipped: true })
    expect(await runCount(root)).toBe(1)

    expect(await runPipeline({ root, steps: [step], argv: ['--force'] })).toEqual({ status: 0 })
    expect(await runCount(root)).toBe(2)
  })

  it('rebuilds when templates were edited after the last successful run', async () => {
    const root = await makeFakeRoot()
    const step = await makeCountingStep(root)

    expect(await runPipeline({ root, steps: [step] })).toEqual({ status: 0 })
    expect(await runPipeline({ root, steps: [step] })).toEqual({ skipped: true })

    await writeFile(path.join(root, 'packages/ppt-runtime/templates/pack/page.page'), 'hand edit\n')
    expect(await runPipeline({ root, steps: [step] })).toEqual({ status: 0 })
    expect(await runCount(root)).toBe(2)
  })

  it('rebuilds when a bundle or the marker went missing', async () => {
    const root = await makeFakeRoot()
    const step = await makeCountingStep(root)

    expect(await runPipeline({ root, steps: [step] })).toEqual({ status: 0 })
    expect(await runPipeline({ root, steps: [step] })).toEqual({ skipped: true })

    await rm(path.join(root, 'packages/ppt-bundles/core.tgz'))
    expect(await runPipeline({ root, steps: [step] })).toEqual({ status: 0 })
    expect(await runCount(root)).toBe(2)
    expect(await runPipeline({ root, steps: [step] })).toEqual({ skipped: true })

    await rm(path.join(root, markerPath))
    expect(await runPipeline({ root, steps: [step] })).toEqual({ status: 0 })
    expect(await runCount(root)).toBe(3)
  })

  it('propagates step failure, leaves the old marker untouched, and recovers', async () => {
    const root = await makeFakeRoot()
    const goodStep = await makeCountingStep(root)

    expect(await runPipeline({ root, steps: [goodStep] })).toEqual({ status: 0 })
    const goodMarker = await readMarker(root)

    const failingStep = path.join(root, 'failing-step.mjs')
    await writeFile(failingStep, 'process.exit(3)\n')
    await rm(path.join(root, 'runs.log'))

    // Force past the guard so the failing step is actually reached.
    const outcome = await runPipeline({ root, steps: [goodStep, failingStep], argv: ['--force'] })
    expect(outcome).toEqual({ status: 3 })
    expect(await readMarker(root)).toEqual(goodMarker)
    expect(await runCount(root)).toBe(1)

    // The untouched marker still describes the last complete build, so the
    // next unforced run skips instead of re-running the broken chain.
    expect(await runPipeline({ root, steps: [goodStep] })).toEqual({ skipped: true })
    expect(await runCount(root)).toBe(1)
  })

  it('writes no marker when the first-ever pipeline run fails', async () => {
    const root = await makeFakeRoot()
    const failingStep = path.join(root, 'failing-step.mjs')
    await writeFile(failingStep, 'process.exit(2)\n')

    expect(await runPipeline({ root, steps: [failingStep], argv: ['--force'] })).toEqual({ status: 2 })
    expect(await readMarker(root)).toBeNull()
    expect(existsSync(path.join(root, 'runs.log'))).toBe(false)
  })
})

describe('ppt build guard pipeline definition', () => {
  it('spawns exactly the four scripts of the documented ppt:build chain, in order', () => {
    expect(steps).toEqual([
      'scripts/generate-zara-ppt-templates.mjs',
      'scripts/localize-ppt-templates.mjs',
      'scripts/enrich-ppt-templates.mjs',
      'scripts/build-ppt-runtime.mjs'
    ])
  })
})
