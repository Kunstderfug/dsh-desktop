# Multitask

Use `/multitask` to start a second objective without interrupting the Agent that is already working. DSH Desktop researches the new work in the background, then the same conversation becomes the orchestrator: it reads the research, claims files, and dispatches a writer. You can run a complete flow from this guide alone.

## Enter `/multitask`

In the session input, type the slash command and an objective:

```text
/multitask add a dark-mode toggle to the settings page
```

The slash menu lists `multitask` as **queue a multitask objective: research, then implementation**. Choose it or type the command yourself. An objective is required: `/multitask` with no text returns `Usage: /multitask <objective>`.

The same command works while the Agent is idle. The followup wakes the orchestrator immediately instead of waiting on a busy turn.

## What happens to the running task

`/multitask` is a host-side command. It does **not** send the slash line to the model, does **not** steer or abort the open turn, and does **not** replace the running task.

The current turn keeps working on its original objective. The command:

1. Mints a per-session task id `MT-n` (the next unused ordinal in this session's log).
2. If the parent is already busy on an earlier multitask task, pre-claims that task's recently touched workspace paths so the new work cannot overwrite them.
3. Starts a **researcher** subagent immediately. The researcher is read-biased: write, edit, and `str_replace_editor` are denied.
4. Queues one orchestrator handoff for the new task. The running turn is untouched; the handoff becomes the next turn's input when that turn finishes.

A task card appears in the conversation with the minted id, the objective, and the research phase.

## Research, then implementation

After the running turn ends, the main Agent continues in **orchestrator mode** in the same session:

1. It inspects the researcher. If research has already settled, the parent notice carries a summary; the orchestrator retrieves the full structured report (goal, affected paths, plan, risks, recommended claim set).
2. If the first researcher attempt fails, the host retries once. A second failure publishes a visible failed task card.
3. The orchestrator claims the report's paths for `MT-n`. A path already held by another live task is refused.
4. It dispatches a **writer** subagent with the research report, the implementation brief, and the live claim table. The writer claims before it edits and releases when it finishes.
5. The orchestrator reviews the handoff (done / concerns / deviations), releases leftover claims, and reports back in this conversation. Orchestrator mode stays active while any multitask tasks remain open.

Resume and fork restore the same tasks and claims by folding the session log. Claims whose owner subagent is no longer running expire.

## Claim system

Writers share the parent checkout. Exclusive **file claims** keep them from colliding:

- The orchestrator and writers claim workspace-relative paths with `claim_files`, inspect the table with `list_file_claims`, and free paths with `release_files`.
- The host enforces claims on native `write`, `edit`, and `str_replace_editor` calls, and on filesystem write/edit intents. A writer that touches a path held by another live task is denied with an actionable reason: *path held by task MT-n; ask the orchestrator or claim a different path*.
- Claiming the same path again for the same task is idempotent. Host-side release-on-settle frees a writer's claims when that child finishes, including failure, so stuck claims do not depend on the model.
- The live claim table is included in every orchestrator handoff.

Claims are the v1 collision story. They do not isolate writers onto separate worktrees.

## Guardrails and config

Two shipped defaults bound cost. They are plugin config on `dsh-multitask` and must match the constants in that package:

| Key | Shipped default | Constant | What it bounds |
| --- | --- | --- | --- |
| `multitask.maxWriters` | 2 | `DEFAULT_MAX_WRITERS` | Live descendant writers plus dispatch reservations. Researchers do not consume a slot. A further writer `subagent` call is refused with `WRITER_CAP` until a slot frees or a later round runs. |
| Shared driver bound (`maxConsecutiveWakes`) | 3 | `DEFAULT_MAX_CONSECUTIVE_WAKES` | Consecutive automatic orchestrator wakes after researcher/writer settlement. User input resets the counter. At the bound, settlement no longer re-wakes the parent. |

Omit either field to keep the shipped default. `multitask.maxWriters` must be a positive safe integer; invalid values fail closed. The driver bound is the same shared wake budget the writer-cap refusal narrates — do not invent a second counter.

To raise or lower a value, set it on the `dsh-multitask` plugin config (the insert row in the desktop profile patch, or an equivalent profile overlay). Example:

```yaml
config:
  maxWriters: 2
  maxConsecutiveWakes: 3
```

## Limitations

- **Bash writes are not covered by today's claim guard (tier 2).** Native write/edit tools are denied at the tool and filesystem seams. A shell command can still write a claimed path. Torn writes are still prevented by the built-in per-target lock and stale-version check, and the orchestrator should review the writer diff. Treat bash as convention-plus-review, not as an enforced claim boundary.
- **Tier 3 is future work.** Kernel-grade sandbox path deny-lists and worktree-per-writer isolation are not shipped. They would also cover shell writes on confined deployments; they stay inert under `danger-full-access`.
- Parallel writers above `multitask.maxWriters` are refused, not silently started. Rapid `/multitask` submissions still mint tasks; capacity is enforced when a writer is dispatched.
- Children inherit the parent's sandbox mode and run with approval policy `never`. Approvals stay on the parent conversation; review the writer handoff there.

## See also

- [What DSH Desktop adds](../README.md#what-dsh-desktop-adds) in the project README
- Research spec (implemented): [2026-09-13-multitask-orchestrator-mode-research.md](superpowers/specs/2026-09-13-multitask-orchestrator-mode-research.md)
