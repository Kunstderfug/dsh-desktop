#!/usr/bin/env python3
"""Final gate for the [multitask] task-card UI (issue #11).

Invoked exactly as:

    python3 scripts/gate_multitask_task_card.py --filter multitask_task_card_gate

The gate answers only to the frozen selector token ``multitask_task_card_gate``.
It runs, in order, from the repository root:

1. ``npx vitest run test/multitask-task-card.test.ts`` — source/projection contracts
2. ``node scripts/check-multitask-task-card.mjs`` — real dev-app lifecycle,
   failure, claim-badge, queue-label, lineage, and narrow-text scenario
3. ``npm test``
4. ``npm run typecheck``
5. ``npm run build``

The first failing step stops the gate with that step's exit code; a green run
exits 0.
"""

import argparse
import os
import subprocess
import sys

REQUIRED_FILTER = "multitask_task_card_gate"

STEPS = [
    ("multitask task-card tests", ["npx", "vitest", "run", "test/multitask-task-card.test.ts"]),
    ("real-app task-card scenario", ["node", "scripts/check-multitask-task-card.mjs"]),
    ("repo test suite", ["npm", "test"]),
    ("typecheck", ["npm", "run", "typecheck"]),
    ("build", ["npm", "run", "build"]),
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--filter",
        required=True,
        help="selector token; this gate only accepts 'multitask_task_card_gate'",
    )
    args = parser.parse_args()

    if args.filter != REQUIRED_FILTER:
        print(
            f"gate_multitask_task_card: unknown --filter {args.filter!r}; "
            f"this gate only answers to {REQUIRED_FILTER!r}",
            file=sys.stderr,
        )
        return 2

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(repo_root)

    for index, (name, command) in enumerate(STEPS, start=1):
        print(f"\n=== gate [{index}/{len(STEPS)}] {name}: {' '.join(command)}", flush=True)
        result = subprocess.run(command)
        if result.returncode != 0:
            print(
                f"\ngate_multitask_task_card: FAILED at step [{index}/{len(STEPS)}] "
                f"{name} (exit {result.returncode})",
                file=sys.stderr,
            )
            return result.returncode
        print(f"=== gate [{index}/{len(STEPS)}] {name}: PASSED")

    print("\ngate_multitask_task_card: all steps passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
