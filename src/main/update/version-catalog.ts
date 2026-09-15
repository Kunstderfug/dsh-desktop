import type { AvailableRelease } from '../../shared/contracts'

export type { AvailableRelease }

export const STABLE_FEED_URL = 'https://dshdesktop.com/updates/latest/'
export const VERSION_INDEX_URL = 'https://dshdesktop.com/updates/versions.json'

const INDEX_TIMEOUT_MS = 8_000
// The version picker refetches on every open; a short-TTL cache keeps rapid
// opens from hammering versions.json while staying fresh for real picks.
export const VERSION_INDEX_TTL_MS = 60_000

type CachedVersionIndex = {
  currentVersion: string
  releases: AvailableRelease[]
  fetchedAt: number
}

let indexCache: CachedVersionIndex | undefined

/** Test hook: forget the cached version index. */
export function _resetVersionIndexCache(): void {
  indexCache = undefined
}

export function archiveFeedUrl(version: string): string {
  return `https://dshdesktop.com/updates/archive/${version}/`
}

/** Split "1.2.3-rc.1" into ([1,2,3], "rc.1"). Non-numeric segments read as 0. */
function splitVersion(value: string): { nums: number[]; pre: string } {
  const [core = '', ...preParts] = value.trim().split('-')
  const nums = core.split('.').map((part) => {
    const parsed = Number.parseInt(part, 10)
    return Number.isFinite(parsed) ? parsed : 0
  })
  while (nums.length < 3) nums.push(0)
  return { nums, pre: preParts.join('-') }
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = splitVersion(a)
  const right = splitVersion(b)
  for (let i = 0; i < Math.max(left.nums.length, right.nums.length); i += 1) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return comparePrerelease(left.pre, right.pre)
}

/**
 * Semver-style prerelease precedence once the numeric core is equal. A release
 * (no prerelease) sorts above any prerelease; dot-separated identifiers
 * compare with numeric identifiers numerically and below alphanumeric ones,
 * and fewer identifiers sort below more ("alpha" < "alpha.1"). Plain string
 * comparison would order "rc.10" below "rc.9", mis-sorting the archive index
 * (and the picker/downgrade split in the preload) once a prerelease counter
 * reaches two digits.
 */
function comparePrerelease(left: string, right: string): -1 | 0 | 1 {
  if (left === right) return 0
  if (!left) return 1 // release > prerelease
  if (!right) return -1
  const l = left.split('.')
  const r = right.split('.')
  const length = Math.max(l.length, r.length)
  for (let i = 0; i < length; i += 1) {
    const x = l[i]
    const y = r[i]
    if (x === undefined) return -1 // fewer identifiers sorts below
    if (y === undefined) return 1
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      // Compare without Number() so leading-zero forms and large counters do
      // not lose precision.
      const nx = x.replace(/^0+/, '') || '0'
      const ny = y.replace(/^0+/, '') || '0'
      if (nx.length !== ny.length) return nx.length < ny.length ? -1 : 1
      if (nx !== ny) return nx < ny ? -1 : 1
      continue
    }
    if (xn) return -1 // numeric identifiers sort below alphanumeric ones
    if (yn) return 1
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}

function isRelease(value: unknown): value is AvailableRelease {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.version === 'string' &&
    record.version.length > 0 &&
    typeof record.tag === 'string' &&
    record.tag.length > 0 &&
    typeof record.archiveUrl === 'string' &&
    record.archiveUrl.length > 0
  )
}

export function parseVersionIndex(raw: unknown): AvailableRelease[] {
  if (typeof raw !== 'object' || raw === null) return []
  const versions = (raw as { versions?: unknown }).versions
  if (!Array.isArray(versions)) return []
  return versions.filter(isRelease)
}

/**
 * List the releases the picker offers for `currentVersion`, newest first.
 * Served from a short-TTL in-memory cache: a hit never touches the network,
 * and when a refresh fails while a cached index exists — fresh or stale — the
 * cache is served instead of throwing so a transient blip cannot empty the
 * version picker. A cache only ever answers for the same `currentVersion`, and
 * `options.ttlMs` overrides the TTL for tests.
 */
export async function fetchAvailableReleases(
  currentVersion: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  options: { ttlMs?: number } = {}
): Promise<AvailableRelease[]> {
  const ttlMs = options.ttlMs ?? VERSION_INDEX_TTL_MS
  const cached = indexCache
  if (
    cached !== undefined &&
    cached.currentVersion === currentVersion &&
    Date.now() - cached.fetchedAt < ttlMs
  ) {
    return cached.releases
  }
  try {
    const releases = await fetchVersionIndex(currentVersion, fetchImpl)
    indexCache = { currentVersion, releases, fetchedAt: Date.now() }
    return releases
  } catch (error) {
    if (cached !== undefined && cached.currentVersion === currentVersion) {
      console.warn('[updates] version index refresh failed; serving cached index', error)
      return cached.releases
    }
    throw error
  }
}

async function fetchVersionIndex(
  currentVersion: string,
  fetchImpl: typeof fetch
): Promise<AvailableRelease[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), INDEX_TIMEOUT_MS)
  try {
    const response = await fetchImpl(VERSION_INDEX_URL, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`Version index request failed: ${response.status}`)
    }
    const releases = parseVersionIndex(await response.json())
    return releases
      .filter((release) => compareVersions(release.version, currentVersion) !== 0)
      .sort((a, b) => compareVersions(b.version, a.version))
  } finally {
    clearTimeout(timer)
  }
}
