#!/usr/bin/env python3
"""Final gate for [multitask] documentation + spec closeout (issue #13).

Invoked exactly as:

    python3 scripts/gate_multitask_docs.py --filter multitask_docs_gate

The gate answers only to the frozen selector token ``multitask_docs_gate``.
It runs, in order, from the repository root:

1. ``npx vitest run test/multitask-docs.test.ts`` — focused default-key and
   required-topic contracts for the user guide, README bullet, and spec
2. ``node scripts/check-multitask-docs.mjs`` — composed docs/link closeout
   at the same production seam (guide, README, spec, spike links, shipped
   ``dsh-multitask`` defaults)
3. ``npm test``
4. ``npm run typecheck``
5. ``npm run build``

The first failing step stops the gate with that step's exit code; a green run
exits 0. ``ZHIPU_API_KEY`` is unset for every step.
"""

import argparse
import os
import subprocess
import sys

REQUIRED_FILTER = "multitask_docs_gate"

STEPS = [
    ("multitask docs contracts", ["npx", "vitest", "run", "test/multitask-docs.test.ts"]),
    ("composed docs and link check", ["node", "scripts/check-multitask-docs.mjs"]),
    ("repo test suite", ["npm", "test"]),
    ("typecheck", ["npm", "run", "typecheck"]),
    ("build", ["npm", "run", "build"]),
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--filter",
        required=True,
        help="selector token; this gate only accepts 'multitask_docs_gate'",
    )
    args = parser.parse_args()

    if args.filter != REQUIRED_FILTER:
        print(
            f"gate_multitask_docs: unknown --filter {args.filter!r}; "
            f"this gate only answers to {REQUIRED_FILTER!r}",
            file=sys.stderr,
        )
        return 2

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(repo_root)

    env = os.environ.copy()
    env.pop("ZHIPU_API_KEY", None)

    for index, (name, command) in enumerate(STEPS, start=1):
        print(f"\n=== gate [{index}/{len(STEPS)}] {name}: {' '.join(command)}", flush=True)
        result = subprocess.run(command, env=env)
        if result.returncode != 0:
            print(
                f"\ngate_multitask_docs: FAILED at step [{index}/{len(STEPS)}] "
                f"{name} (exit {result.returncode})",
                file=sys.stderr,
            )
            return result.returncode
        print(f"=== gate [{index}/{len(STEPS)}] {name}: PASSED")

    print("\ngate_multitask_docs: all steps passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
