# Upstream report: `/compact` misreports a busy agent as an active compaction

Posted as [deepseek-ai/deepseek-harness#6223](https://github.com/deepseek-ai/deepseek-harness/discussions/6223) (category Q&A) on 2026-09-10.

DeepSeek Harness declines external pull requests in its CONTRIBUTING, so a GitHub Discussion is the contribution channel. The findings below were verified against `master` @ `c291e7961a515f6d7af9304e7fd1d257929aef26` (the 0.1.5-rc.2 era), where the behaviour is still present. Our own fix for this repository ships as [#381](https://github.com/dataelement/dsh-desktop/pull/381).

The body between the rules below is what was posted, verbatim.

---

**Summary.** A manual `/compact` that arrives while the agent is still finishing a turn is refused with a message that names the wrong cause — and the error classification makes the two cases indistinguishable for every consumer, not just `/compact`.

Found on DSH Desktop (harness 0.1.2-rc.1). The same code path is still present on `master`, so I'm reporting it rather than assuming it is known.

**What the user sees**

> Compaction is unavailable because this process has an active compaction, or the agent is not idle.

That is the single `busy` arm of `expectedFailure` in `packages/compaction/command-compact/src/index.ts:29`.

**Why the message is wrong for this case.** The refusal users actually hit is the agent loop rejecting the maintenance claim:

```ts
// packages/core/agent-loop/src/agent.ts:158
if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
```

`compactNow` catches everything and reports one code for all of it:

```ts
// packages/compaction/compaction-basic/src/index.ts:414
} catch (error: unknown) {
  throw new ManualCompactionError(
    'busy',
    'manual compaction requires an idle agent with no waking queued work',
    { cause: error },
  )
}
```

So "another compaction is in progress" (what the copy leads with), "the agent is not idle" (vague, but the real cause), a live unmatched bracket, and an unavailable admission all arrive as `busy`. The message leads with the case a user is least likely to have hit.

**Evidence from a real session log** (`session.jsonl.zstd`, `ts` in epoch ms):

| event | ts | delta |
| --- | --- | --- |
| last `step/end` of the answered turn | 1789070593953 | — |
| `command/run compact` | 1789070596493 | +2.5 s |
| `command/done` kind=error | 1789070596498 | +5 ms |
| next `turn/start` | 1789070640640 | +45 s |

The refusal landed 2.5 s after the turn's final step and 45 s before the next turn began: `phase.kind` was still `running`. Worth adding *why* the user thought the agent was idle — `agent/turn-stopping` hooks (title generation) run before `turn/end`, so the response visibly ends tens of seconds before the phase does. That window is exactly when someone reaches for `/compact`, and exactly when the message is wrong.

**Suggested change.** Classify at the boundary, then let each consumer name its own cause:

```ts
function isAgentWorkingError(error: unknown): boolean {
  return /already has active work$/u.test(errorMessage(error))
}

// in compactNow's catch
if (isAgentWorkingError(error)) {
  throw new ManualCompactionError(
    'agent-busy',
    'manual compaction did not start: the agent was still working',
    { cause: error },
  )
}
throw new ManualCompactionError(/* existing busy */)
```

`command-compact` gains an `agent-busy` arm — "the agent is still working on this session. Wait for the turn to finish, then run /compact again." — and `busy` narrows to the claim conflicts it already describes.

**Tests that currently encode the conflation** (these need updating, not just adding alongside):

- `packages/compaction/compaction-basic/tests/manual-compaction.spec.ts:213` — the fake agent throws the agent-loop string verbatim: `if (release === undefined) throw new Error('agent already has active work')`. The testkit comment calls it "a fake idle agent whose maintenance claim is scripted per test", so the string is effectively a contract.
- `…/manual-compaction.spec.ts:345` — `reports busy without summarizing when a prompt already owns the next turn`, asserting `code === 'busy'` at `:354`; also the cases at `:710` (`{ name: 'busy', …, release: undefined }`) and `:884`.
- `packages/compaction/command-compact/tests/command-compact.spec.ts:209` — pins the current user-facing string in a table.

**Working implementation, if useful.** I implemented this against the 0.1.2-rc.1 published artifacts, shipped it in our desktop shell, and added a test pinning the classifier, both refusal messages, and the patch: https://github.com/dataelement/dsh-desktop/pull/381

**Out of scope / open question.** This fixes only the diagnosis — `/compact` still will not start mid-turn. Making it wait for idle changes `runMaintenance` semantics for every maintenance caller (the scheduler currently defers when the claim is busy), so it reads like a separate product decision. Which direction would you prefer?

---

## Status

Posted 2026-09-10, awaiting a maintainer response.

Still open on our side: whether `/compact` should wait for an idle agent rather than refuse. That is the deeper fix and was deliberately left out of #381, because it changes `runMaintenance` semantics for every maintenance caller, including the scheduler.
