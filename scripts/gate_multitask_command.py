#!/usr/bin/env python3
"""Final gate for the [multitask] /multitask command (issue #4).

Invoked exactly as:

    python3 scripts/gate_multitask_command.py --filter multitask_command_gate

The gate answers only to the frozen selector token ``multitask_command_gate``.
It runs, in order, from the repository root:

1. ``npx vitest run test/multitask-command.test.ts``   — command handler tests
   (real CommandRuntime + real session store + real loop, in-process)
2. ``node scripts/check-multitask-command.mjs``        — real-dev-app scenario
   (composer menu, host-side execution, session log, renderer chat node)
3. ``npm test``                                        — full repo test suite
4. ``npm run typecheck``
5. ``npm run build``

The first failing step stops the gate with that step's exit code; a green run
exits 0.
"""

import argparse
import os
import subprocess
import sys

REQUIRED_FILTER = "multitask_command_gate"

STEPS = [
    ("multitask command tests", ["npx", "vitest", "run", "test/multitask-command.test.ts"]),
    ("real-app command scenario", ["node", "scripts/check-multitask-command.mjs"]),
    ("repo test suite", ["npm", "test"]),
    ("typecheck", ["npm", "run", "typecheck"]),
    ("build", ["npm", "run", "build"]),
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--filter",
        required=True,
        help="selector token; this gate only accepts 'multitask_command_gate'",
    )
    args = parser.parse_args()

    if args.filter != REQUIRED_FILTER:
        print(
            f"gate_multitask_command: unknown --filter {args.filter!r}; "
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
                f"\ngate_multitask_command: FAILED at step [{index}/{len(STEPS)}] "
                f"{name} (exit {result.returncode})",
                file=sys.stderr,
            )
            return result.returncode
        print(f"=== gate [{index}/{len(STEPS)}] {name}: PASSED")

    print("\ngate_multitask_command: all steps passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
