#!/usr/bin/env python3
"""Final gate for the [multitask] claims-enforcement spike (issue #2).

Invoked exactly as:

    python3 test/spikes/multitask-claims/gate.py --filter multitask_claims_spike

The gate
  1. verifies the required selector token,
  2. runs the spike's vitest integration spec from the repo root,
  3. verifies the committed findings report exists, is non-empty, contains a
     `## Verdict` section, and ends with `VERDICT: go` or `VERDICT: no-go`,

and exits nonzero on any failure. Throwaway lane; not a product script.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

REQUIRED_FILTER = "multitask_claims_spike"
REPO_ROOT = Path(__file__).resolve().parents[3]
SPEC_PATH = REPO_ROOT / "test/spikes/multitask-claims/multitask-claims-spike.test.ts"
REPORT_PATH = REPO_ROOT / "docs/superpowers/specs/2026-09-13-multitask-spike-claims.md"
VERDICT_PATTERN = re.compile(r"^VERDICT: (go|no-go)$", re.MULTILINE)


def fail(message: str) -> int:
    print(f"gate: FAIL {message}", file=sys.stderr)
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="multitask claims spike final gate")
    parser.add_argument("--filter", required=True, help="required selector token")
    args = parser.parse_args()

    if args.filter != REQUIRED_FILTER:
        return fail(f"--filter must be {REQUIRED_FILTER!r}, got {args.filter!r}")
    print(f"gate: filter token OK ({REQUIRED_FILTER})")

    if not SPEC_PATH.is_file():
        return fail(f"spike spec missing: {SPEC_PATH.relative_to(REPO_ROOT)}")

    print("gate: running vitest spec…")
    vitest = subprocess.run(
        ["npx", "vitest", "run", "test/spikes/multitask-claims/multitask-claims-spike.test.ts"],
        cwd=REPO_ROOT,
    )
    if vitest.returncode != 0:
        return fail(f"vitest exited {vitest.returncode}")
    print("gate: vitest spec OK")

    if not REPORT_PATH.is_file():
        return fail(f"findings report missing: {REPORT_PATH.relative_to(REPO_ROOT)}")
    report = REPORT_PATH.read_text(encoding="utf-8")
    if not report.strip():
        return fail("findings report is empty")
    if "## Verdict" not in report:
        return fail("findings report has no '## Verdict' section")
    verdicts = VERDICT_PATTERN.findall(report)
    if not verdicts:
        return fail("findings report has no 'VERDICT: go' / 'VERDICT: no-go' line")
    print(f"gate: report OK (verdict: {verdicts[-1]})")

    print("gate: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
