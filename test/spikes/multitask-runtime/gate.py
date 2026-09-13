#!/usr/bin/env python3
"""Deterministic gate for the t1c-runtime-spike deliverables (epic #1).

Exact invocation from the repo root:

    python3 test/spikes/multitask-runtime/gate.py --filter multitask_runtime_spike

The gate (1) verifies the filter names the known multitask runtime spike,
(2) runs the real-harness vitest spec through the repo's own vitest, and
(3) checks the findings report for the required per-behavior structure and
verdict line. Any failure exits nonzero.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SPIKE_DIR = Path("test/spikes/multitask-runtime")
# filter token -> spec file the orchestrator's bundle freezes
KNOWN_FILTERS = {
    "multitask_runtime_spike": SPIKE_DIR / "multitask-runtime-spike.test.ts",
}
REPORT_PATH = Path("docs/superpowers/specs/2026-09-13-multitask-spike-runtime.md")

# Every behavior the spec demands, as a describe/it name that must appear in
# the vitest spec, plus the report section heading that must document it.
REQUIRED_BEHAVIORS = [
    "continuable child",
    "settlement notice",
    "queued followup",
    "steers the settlement notice",
    "injects the settlement notice",
    "crash-style restart",
    "graceful agent disposal",
]
REQUIRED_REPORT_MARKS = ["OBSERVED", "DEVIATES", "## Verdict"]
VERDICT_RE = re.compile(r"^VERDICT: (go|no-go)$", re.MULTILINE)


def run(cmd: list[str]) -> int:
    print(f"$ {' '.join(cmd)}", flush=True)
    completed = subprocess.run(cmd, cwd=REPO_ROOT)
    return completed.returncode


def check_filter(filter_name: str) -> list[str]:
    problems: list[str] = []
    if filter_name not in KNOWN_FILTERS:
        known = ", ".join(sorted(KNOWN_FILTERS))
        problems.append(f"unknown filter {filter_name!r} (known: {known})")
        return problems
    spec = REPO_ROOT / KNOWN_FILTERS[filter_name]
    if not spec.is_file():
        problems.append(f"missing spike spec: {spec}")
        return problems
    source = spec.read_text(encoding="utf-8")
    for behavior in REQUIRED_BEHAVIORS:
        if behavior not in source:
            problems.append(f"spec does not cover behavior: {behavior!r}")
    return problems


def check_report() -> list[str]:
    problems: list[str] = []
    report = REPO_ROOT / REPORT_PATH
    if not report.is_file():
        problems.append(f"missing findings report: {report}")
        return problems
    text = report.read_text(encoding="utf-8")
    for mark in REQUIRED_REPORT_MARKS:
        if mark not in text:
            problems.append(f"report lacks required mark: {mark!r}")
    for behavior in REQUIRED_BEHAVIORS:
        if behavior not in text:
            problems.append(f"report does not document behavior: {behavior!r}")
    if "node_modules/@deepseek-ai/" not in text:
        problems.append("report lacks file:symbol refs into node_modules/@deepseek-ai/*")
    verdicts = VERDICT_RE.findall(text)
    if not verdicts:
        problems.append("report lacks a final 'VERDICT: go' or 'VERDICT: no-go' line")
    elif not VERDICT_RE.search(text.rstrip("\n").split("\n")[-1]):
        problems.append("the VERDICT line is not the last line of the report")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description="t1c-runtime-spike gate")
    parser.add_argument("--filter", required=True, help="spike filter token")
    args = parser.parse_args()

    failures = 0

    filter_problems = check_filter(args.filter)
    if filter_problems:
        failures += 1
        for problem in filter_problems:
            print(f"FILTER FAIL: {problem}")
    else:
        print(f"FILTER OK: {args.filter} -> {KNOWN_FILTERS[args.filter]}")

    spec = KNOWN_FILTERS.get(args.filter)
    if spec is not None:
        failures += run(["npx", "vitest", "run", str(spec)])

    report_problems = check_report()
    if report_problems:
        failures += 1
        for problem in report_problems:
            print(f"REPORT FAIL: {problem}")
    else:
        print(f"REPORT OK: {REPORT_PATH}")

    if failures:
        print(f"GATE: FAIL ({failures} failing check(s))")
        return 1
    print("GATE: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
