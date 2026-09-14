#!/usr/bin/env python3
"""Final gate for the [multitask] researcher lifecycle (issue #5).

Invoked exactly as:

    python3 scripts/gate_multitask_researcher.py --filter multitask_researcher_gate

The gate answers only to the frozen selector token ``multitask_researcher_gate``.
It runs, in order, from the repository root:

1. ``npx vitest run test/multitask-researcher.test.ts`` — focused real-runtime
   composition (plugin + CommandRuntime + SubagentRuntime + persistence +
   session query + agent loop; only the model adapter is scripted)
2. ``node scripts/check-multitask-researcher.mjs`` — real composed application
   scenario at the same production seam
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

REQUIRED_FILTER = "multitask_researcher_gate"

STEPS = [
    ("multitask researcher tests", ["npx", "vitest", "run", "test/multitask-researcher.test.ts"]),
    ("real composed application scenario", ["node", "scripts/check-multitask-researcher.mjs"]),
    ("repo test suite", ["npm", "test"]),
    ("typecheck", ["npm", "run", "typecheck"]),
    ("build", ["npm", "run", "build"]),
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--filter",
        required=True,
        help="selector token; this gate only accepts 'multitask_researcher_gate'",
    )
    args = parser.parse_args()

    if args.filter != REQUIRED_FILTER:
        print(
            f"gate_multitask_researcher: unknown --filter {args.filter!r}; "
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
                f"\ngate_multitask_researcher: FAILED at step [{index}/{len(STEPS)}] "
                f"{name} (exit {result.returncode})",
                file=sys.stderr,
            )
            return result.returncode
        print(f"=== gate [{index}/{len(STEPS)}] {name}: PASSED")

    print("\ngate_multitask_researcher: all steps passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
