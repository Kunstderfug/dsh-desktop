#!/usr/bin/env python3
"""Upload signed test installers and notify only after public downloads exist."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import time
import urllib.request
from pathlib import Path
from urllib.parse import quote

from feishu_release_notes import send_feishu_notification

INSTALLERS = {
    "macos": [
        ("macOS Apple Silicon", "dsh-desktop-mac-arm64.dmg"),
        ("macOS Intel", "dsh-desktop-mac-x64.dmg"),
    ],
    "windows": [("Windows x64", "dsh-desktop-windows-x64-setup.exe")],
}


def installer_paths(directory: Path, target: str) -> list[tuple[str, Path]]:
    platforms = ["macos", "windows"] if target == "all" else [target]
    installers = [(label, directory / name) for platform in platforms for label, name in INSTALLERS[platform]]
    for _, file in installers:
        if not file.is_file() or file.stat().st_size == 0:
            raise ValueError(f"Missing or empty signed installer: {file.name}")
    return installers


def test_prefix(version: str, run_id: str) -> str:
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version):
        raise ValueError("signed_version must be a non-v semver")
    if not re.fullmatch(r"[1-9]\d*", run_id):
        raise ValueError("run_id must be a positive integer")
    return f"test/{version}/{run_id}"


def download_url(repo_id: str, prefix: str, name: str) -> str:
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo_id):
        raise ValueError("Invalid ModelScope repository ID")
    return f"https://modelscope.cn/models/{repo_id}/resolve/master/{quote(prefix + '/' + name, safe='/')}"


def verify_download(url: str, expected_size: int) -> None:
    # Read only one byte: checking a large installer must not download it again.
    request = urllib.request.Request(url, headers={"Range": "bytes=0-0"})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                content_range = response.headers.get("Content-Range")
                # ModelScope's CDN can return a valid range with HTTP 200.
                if content_range:
                    valid = response.status in (200, 206) and content_range == f"bytes 0-0/{expected_size}"
                else:
                    valid = response.status == 200 and response.headers.get("Content-Length") == str(expected_size)
                if not valid or len(response.read(1)) != 1:
                    raise ValueError(f"Unexpected download response: status={response.status}, range={content_range}, length={response.headers.get('Content-Length')}")
            return
        except Exception as error:
            if attempt == 5:
                raise RuntimeError(f"ModelScope test installer is not publicly downloadable: {url}") from error
            time.sleep(10)


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True, encoding="utf-8").strip()


def build_test_changes(repository_url: str) -> str:
    if git("rev-parse", "--is-shallow-repository") == "true":
        raise ValueError("Signed test changelog requires complete git history and tags")
    head = git("rev-parse", "HEAD")
    release_tag = re.compile(r"[vV]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?")
    tags = [tag for tag in git("tag", "--merged", head).splitlines() if release_tag.fullmatch(tag)]
    # When dispatched on a tag itself, compare that release to the preceding tag.
    earlier = [tag for tag in tags if git("rev-parse", f"refs/tags/{tag}^{{commit}}") != head]
    previous = git("describe", "--tags", "--abbrev=0", *[f"--match={tag}" for tag in earlier], head) if earlier else ""
    revision = f"{previous}..{head}" if previous else head
    raw = git("log", "--no-merges", "--reverse", "--format=%s%x00%b%x00", revision)
    sections: dict[str, list[str]] = {"功能": [], "修复": [], "性能与改进": [], "其他变更": []}
    fields = raw.split("\0")

    def markdown(text: str) -> str:
        return re.sub(r"([\\`*\[\]<>_])", r"\\\1", text)

    for index in range(0, len(fields) - 1, 2):
        subject, body = fields[index].strip(), fields[index + 1].strip()
        match = re.match(r"(feat|fix|perf|refactor|build|ci|docs|test|chore)(?:\(([^)]+)\))?!?:\s*(.+)", subject, re.DOTALL)
        category = "其他变更"
        title = subject
        if match:
            kind, scope, title = match.groups()
            category = {"feat": "功能", "fix": "修复", "perf": "性能与改进", "refactor": "性能与改进"}.get(kind, category)
            if scope:
                title = f"{scope}: {title}"
        item = f"- {markdown(title)}"
        if body:
            item += "\n" + "\n".join(f"  {markdown(line)}" for line in body.splitlines())
        sections[category].append(item)
    baseline = f"上一个 tag：`{previous}`" if previous else "无历史版本 tag，列出首次提测变更。"
    parts = ["**本次提测变更**", baseline, f"构建提交：`{head[:12]}`", "以下列表与说明来自该范围的提交记录，供提测核对。"]
    if previous:
        parts.append(f"[完整代码比较]({repository_url}/compare/{quote(previous, safe='')}...{head})")
    for title, items in sections.items():
        if items:
            parts.extend([f"**{title}**", "\n".join(items)])
    if not any(sections.values()):
        parts.append("该范围没有非合并提交。")
    return "\n\n".join(parts)


def build_notification(version: str, installers: list[tuple[str, Path]], repo_id: str, prefix: str, run_url: str, changes: str = "") -> str:
    links = "\n".join(f"- [{label}]({download_url(repo_id, prefix, file.name)})" for label, file in installers)
    checks = []
    if any(label.startswith("macOS") for label, _ in installers):
        checks.append("macOS 安装包已通过签名与公证检查。")
    if any(label.startswith("Windows") for label, _ in installers):
        checks.append("Windows 安装包已通过签名安装 smoke。")
    if len(changes) > 9000:
        changes = changes[:8500].rsplit("\n", 1)[0] + "\n\n变更较多，完整列表与说明请查看下方文件。"
    change_link = download_url(repo_id, prefix, "test-changes.md")
    details = f"\n\n{changes}\n\n[完整提测变更说明]({change_link})" if changes else ""
    return (
        f"**DSH Desktop {version} 测试打包完成**\n\n"
        "本次为签名测试安装包，用于安装和功能验收，请手动下载安装。\n"
        + "\n".join(checks)
        + details
        + f"\n\n**下载地址**\n{links}\n\n[CI 构建详情]({run_url})"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--target", choices=["all", "macos", "windows"], required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    prefix = test_prefix(args.version, args.run_id)
    repo_id = os.environ["MODELSCOPE_REPO_ID"]
    token = os.environ["MODELSCOPE_TOKEN"]
    webhook = os.environ["FEISHU_RELEASE_WEBHOOK"]
    if not token or not webhook:
        raise ValueError("ModelScope token and Feishu webhook are required for signed test builds")
    installers = installer_paths(args.directory, args.target)
    repository_url = f"{os.environ['GITHUB_SERVER_URL']}/{os.environ['GITHUB_REPOSITORY']}"
    changes = build_test_changes(repository_url)
    changes_file = args.directory / "test-changes.md"
    changes_file.write_text(f"# DSH Desktop {args.version} 提测说明\n\n{changes}\n", encoding="utf-8")
    # Import the SDK only for uploads; the notification and selection logic is independently testable.
    from modelscope.hub.api import HubApi

    api = HubApi()
    for _, file in [*installers, ("提测说明", changes_file)]:
        url = download_url(repo_id, prefix, file.name)
        api.upload_file(
            repo_id=repo_id,
            path_or_fileobj=str(file),
            path_in_repo=f"{prefix}/{file.name}",
            commit_message=f"Signed test build {args.version} run {args.run_id}",
            token=token,
        )
        verify_download(url, file.stat().st_size)
        print(f"Verified signed test installer: {file.name}")
    run_url = f"{os.environ['GITHUB_SERVER_URL']}/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{args.run_id}"
    notes = build_notification(args.version, installers, repo_id, prefix, run_url, changes)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as stream:
            stream.write(notes + "\n")
    send_feishu_notification(webhook, args.version, notes, test_build=True)


if __name__ == "__main__":
    main()
