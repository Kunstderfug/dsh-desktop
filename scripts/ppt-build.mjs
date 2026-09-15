/**
 * Cached entry point for the PPT plugin rebuild pipeline (`npm run ppt:build`).
 *
 * The four-step pipeline is treated as a pure function of its maintained
 * inputs: the four scripts themselves, everything under `scripts/ppt/`, the
 * immutable `packages/ppt-runtime/upstream/` sources, the shipped
 * `packages/ppt-runtime/core/` and `adapter/` runtimes, and the dependency
 * manifests (`package.json`, `package-lock.json`).
 *
 * Before a run, the sources are hashed. After a fully successful run, the
 * generated `packages/ppt-runtime/templates/` tree is hashed too and both
 * hashes are recorded in a marker file next to the outputs
 * (`packages/ppt-runtime/.build-cache.json`, gitignored).
 *
 * A later run skips the pipeline ONLY when every one of these holds:
 *   - the marker exists with the current schema version,
 *   - the sources hash is unchanged,
 *   - the templates tree hash is unchanged (hand-edited templates rebuild),
 *   - both packed bundles listed in `artifacts.json` still exist and are
 *     non-empty,
 *   - `--force` was not passed.
 * Any other state — changed script, changed source, changed dependency lock,
 * missing marker (fresh clone), a previous failed run (the marker is written
 * only after all four steps succeed), missing bundles, or an explicit
 * `--force` — falls through to the full rebuild, which remains the documented
 * behavior of `npm run ppt:build`.
 *
 * The rebuild path spawns the exact same four commands, in the same order,
 * that the previous `ppt:build` chain ran, with inherited stdio, so a rebuild
 * behaves byte-for-byte like the unguarded pipeline.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** All paths below are workspace-relative and resolved against `root`. */
export const markerPath = 'packages/ppt-runtime/.build-cache.json'
export const artifactsPath = 'packages/ppt-runtime/artifacts.json'
export const templatesDir = 'packages/ppt-runtime/templates'
export const bundleDir = 'packages/ppt-bundles'
export const markerVersion = 1

/** The pipeline steps, in the exact order the old `ppt:build` chain ran them. */
export const steps = [
  'scripts/generate-zara-ppt-templates.mjs',
  'scripts/localize-ppt-templates.mjs',
  'scripts/enrich-ppt-templates.mjs',
  'scripts/build-ppt-runtime.mjs'
]

/** Single-file inputs to the pipeline. */
const sourceFiles = [...steps, 'package.json', 'package-lock.json']

/** Directory inputs to the pipeline, hashed recursively. */
const sourceTrees = [
  'scripts/ppt',
  'packages/ppt-runtime/upstream',
  'packages/ppt-runtime/core',
  'packages/ppt-runtime/adapter'
]

const isJunk = base => base === '.DS_Store' || base.startsWith('._')

async function listFiles(relDir, root) {
  let entries
  try {
    entries = await fs.readdir(path.join(root, relDir), { recursive: true, withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile() || isJunk(entry.name)) continue
    const parent = entry.parentPath ?? entry.path
    files.push(path.relative(root, path.join(parent, entry.name)))
  }
  return files.sort()
}

/**
 * SHA-256 over `path \0 fileDigest \n` for each file, in sorted order.
 * Files that do not exist are skipped: a missing input changes the hashed
 * set, so the digest still differs from any state where the file exists.
 */
async function hashFiles(relFiles, root) {
  const hash = crypto.createHash('sha256')
  for (const rel of relFiles) {
    let digest
    try {
      digest = crypto.createHash('sha256').update(await fs.readFile(path.join(root, rel))).digest('hex')
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    hash.update(rel).update('\0').update(digest).update('\n')
  }
  return hash.digest('hex')
}

/** Hash of everything the four pipeline scripts read before writing. */
export async function computeSourcesHash(root = '') {
  const files = [...sourceFiles]
  for (const tree of sourceTrees) files.push(...(await listFiles(tree, root)))
  return hashFiles(files.sort(), root)
}

/** Hash of the generated templates tree (an output, and step 4's input). */
export async function computeTemplatesHash(root = '') {
  return hashFiles(await listFiles(templatesDir, root), root)
}

export async function readMarker(root = '') {
  try {
    return JSON.parse(await fs.readFile(path.join(root, markerPath), 'utf8'))
  } catch {
    return null
  }
}

/** Both packed bundles from artifacts.json must exist and be non-empty. */
export async function bundlesExist(root = '') {
  let artifacts
  try {
    artifacts = JSON.parse(await fs.readFile(path.join(root, artifactsPath), 'utf8'))
  } catch {
    return false
  }
  for (const name of ['core', 'adapter']) {
    const file = artifacts[name]?.file
    if (typeof file !== 'string') return false
    try {
      const stat = await fs.stat(path.join(root, bundleDir, file))
      if (!stat.isFile() || stat.size === 0) return false
    } catch {
      return false
    }
  }
  return true
}

export function isUpToDate(marker, sourcesHash, templatesHash, bundles) {
  return Boolean(
    marker &&
    marker.version === markerVersion &&
    typeof marker.outputsHash === 'string' &&
    marker.sourcesHash === sourcesHash &&
    marker.outputsHash === templatesHash &&
    bundles
  )
}

/**
 * Run (or skip) the pipeline. Returns `{ skipped: true }`, or
 * `{ status: exitCode }` — nonzero when a step failed, in which case the
 * marker is deliberately left untouched so the next run rebuilds.
 */
export async function runPipeline({ root = '', steps: pipelineSteps = steps, argv = [] } = {}) {
  const force = argv.includes('--force')
  const sourcesHash = await computeSourcesHash(root)
  if (!force) {
    const [marker, templatesHash, bundles] = await Promise.all([
      readMarker(root),
      computeTemplatesHash(root),
      bundlesExist(root)
    ])
    if (isUpToDate(marker, sourcesHash, templatesHash, bundles)) {
      return { skipped: true }
    }
  }
  for (const step of pipelineSteps) {
    const result = spawnSync(process.execPath, [step], { stdio: 'inherit', cwd: root || process.cwd() })
    if (result.status !== 0) {
      console.error(`ppt:build: ${step} exited with status ${result.status ?? 'error'}; rebuild marker not updated.`)
      return { status: result.status ?? 1 }
    }
  }
  const marker = {
    version: markerVersion,
    sourcesHash,
    outputsHash: await computeTemplatesHash(root),
    builtAt: new Date().toISOString()
  }
  await fs.mkdir(path.dirname(path.join(root, markerPath)), { recursive: true })
  await fs.writeFile(path.join(root, markerPath), JSON.stringify(marker, null, 2) + '\n')
  return { status: 0 }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const outcome = await runPipeline({ argv: process.argv.slice(2) })
  if (outcome.skipped) {
    console.log('ppt:build: inputs unchanged since the last successful build; skipping. Run `npm run ppt:build -- --force` to rebuild.')
  } else if (outcome.status === 0) {
    console.log(`ppt:build: full rebuild complete; marker written to ${markerPath}.`)
  }
  if (outcome.status) process.exit(outcome.status)
}
