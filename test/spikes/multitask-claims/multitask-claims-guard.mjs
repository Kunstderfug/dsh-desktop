/**
 * Scratch guard plugin for the [multitask] claims-enforcement spike (issue #2).
 *
 * This file is the `npm run dev` lane of the throwaway spike: it is loaded into
 * the REAL dev-app harness composition through the web profile's user patch
 * layer (`profiles/web/cordis.patch.yml`, env-gated, restored after the
 * observation) and denies all writes to ONE hard-coded probe path exactly as
 * spec §5.5 tier 2 proposes. It ships no product behavior and must never be
 * mounted in a production profile.
 *
 * Shape template: @deepseek-ai/dsh-fs-observation-policy (spec §4.4.3) —
 * event-only listeners, no service, config-read at apply time.
 */
import { resolve } from 'node:path'

/** Stable cordis plugin name (loader diagnostics). */
const name = 'multitask-claims-guard'

/** Hard-coded probe path fallback; the dev run passes the exact path via config. */
const DEFAULT_PROBE_PATH = '/tmp/multitask-claims-spike-probe.txt'

/** The actionable denial reason §5.5 tier 2 prescribes for a claimed path. */
const CLAIM_REASON = 'path held by task MT-2; ask the orchestrator or claim a different path'

/** Model-facing mutating tools this tier claims against, and their path argument. */
const PATH_ARGUMENTS = {
  write: 'file_path',
  edit: 'file_path',
  str_replace_editor: 'path'
}

function isClaimedPath(path, probePath) {
  if (typeof path !== 'string' || path.trim().length === 0) return false
  try {
    return resolve(path) === probePath
  } catch {
    return false
  }
}

/**
 * Mount the tier-2 claim guard on one harness composition.
 * @param ctx - cordis context the loader applies this plugin at.
 * @param config - optional `{ probePath }` from the patch row.
 */
function apply(ctx, config) {
  const probePath = resolve(String(config?.probePath ?? DEFAULT_PROBE_PATH))
  let preExecuteHits = 0
  let writeIntentHits = 0
  let editIntentHits = 0

  // Tier-2 primary seam: deny mutating tool calls (model-direct AND PTC
  // sub-dispatched) before dispatch. This spike registers globally, so the
  // denial applies to every agent in the dev composition.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const argument = PATH_ARGUMENTS[exec.name]
    if (argument === undefined) return next()
    if (!isClaimedPath(exec.arguments?.[argument], probePath)) return next()
    preExecuteHits += 1
    console.log(
      `[multitask-claims-guard] pre-execute deny #${preExecuteHits} tool=${exec.name} ` +
      `nested=${exec.parent !== undefined} path=${probePath}`
    )
    return { kind: 'deny', reason: CLAIM_REASON }
  })

  // Tier-2 exact fs seam. NOTE (documented in the spike report): when this
  // plugin loads from the user patch layer it registers AFTER
  // dsh-fs-observation-policy, whose single-slot intent listeners never call
  // next() — so these listeners are shadowed in the real-app composition.
  // Kept here (with live counters) to document that finding.
  ctx.on('fs/write-intent', async (target, _actor, next) => {
    writeIntentHits += 1
    if (!isClaimedPath(target.displayPath, probePath) && String(target.targetKey) !== probePath) return next()
    console.log(`[multitask-claims-guard] fs/write-intent deny (hit #${writeIntentHits}) path=${probePath}`)
    throw new Error(`fs/write-intent: ${CLAIM_REASON}`)
  })
  ctx.on('fs/edit-intent', async (target, _actor, next) => {
    editIntentHits += 1
    if (!isClaimedPath(target.displayPath, probePath) && String(target.targetKey) !== probePath) return next()
    console.log(`[multitask-claims-guard] fs/edit-intent deny (hit #${editIntentHits}) path=${probePath}`)
    throw new Error(`fs/edit-intent: ${CLAIM_REASON}`)
  })

  console.log(`[multitask-claims-guard] mounted; probe path ${probePath}`)
}

export { name, apply }
