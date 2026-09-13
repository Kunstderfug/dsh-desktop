#!/usr/bin/env python3
"""Final gate for the [multitask] scaffold (issue #3).

Invoked exactly as:

    python3 scripts/gate_multitask_scaffold.py --filter check_multitask_mount

The gate answers only to the frozen selector token ``check_multitask_mount``.
It runs, in order, from the repository root:

1. ``npx vitest run test/multitask-scaffold.test.ts``   — scaffold assertions
2. ``npx vitest run test/desktop-plugin-closure.test.ts`` — binding closure contract
3. ``node scripts/check-multitask-mount.mjs``           — real-app mount smoke
4. ``npm test``                                          — full repo test suite
5. ``npm run typecheck``
6. ``npm run build``

The first failing step stops the gate with that step's exit code; a green run
exits 0.
"""

import argparse
import os
import subprocess
import sys

REQUIRED_FILTER = "check_multitask_mount"

STEPS = [
    ("scaffold test", ["npx", "vitest", "run", "test/multitask-scaffold.test.ts"]),
    ("desktop plugin closure test", ["npx", "vitest", "run", "test/desktop-plugin-closure.test.ts"]),
    ("real-app mount smoke", ["node", "scripts/check-multitask-mount.mjs"]),
    ("repo test suite", ["npm", "test"]),
    ("typecheck", ["npm", "run", "typecheck"]),
    ("build", ["npm", "run", "build"]),
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--filter",
        required=True,
        help="selector token; this gate only accepts 'check_multitask_mount'",
    )
    args = parser.parse_args()

    if args.filter != REQUIRED_FILTER:
        print(
            f"gate_multitask_scaffold: unknown --filter {args.filter!r}; "
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
                f"\ngate_multitask_scaffold: FAILED at step [{index}/{len(STEPS)}] "
                f"{name} (exit {result.returncode})",
                file=sys.stderr,
            )
            return result.returncode
        print(f"=== gate [{index}/{len(STEPS)}] {name}: PASSED")

    print("\ngate_multitask_scaffold: all steps passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
