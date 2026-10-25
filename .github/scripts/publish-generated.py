#!/usr/bin/env python3
"""Publish validated generated files without rebasing them over changed inputs."""
from __future__ import annotations

import argparse
import fnmatch
import json
import os
from pathlib import Path
import subprocess
import sys


OUTPUTS = {
    "rules": (
        "Surge/RULE-SET/", "Surge/Module/", "Quantumult/X/Filter/",
        "Clash/RuleSet/", "sing-box/source/", "sing-box/rule-set/",
        ".github/scripts/sync-rules-owned.json",
    ),
    "config": (
        "Clash/Sample.yaml", "Clash/Mihomo.yaml", "Clash/Script/",
        "Surge/Balloon.lcf", "Quantumult/Sample.conf", "Surge/Surfboard.conf",
        "sing-box/config.json", "Surge/Module/Profile.sgmodule",
        "Surge/Module/Pannel/*.stoverride", "Surge/Module/Stash/",
    ),
    "modules-formal": ("Surge/Module/BlockAds.sgmodule",),
    "modules-beta": ("Surge/Module/BlockAdsBeta.sgmodule",),
}


class PublishError(RuntimeError):
    pass


def git(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(
            ["git", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=90, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )
    except subprocess.TimeoutExpired as exc:
        raise PublishError("Git operation exceeded its time limit; nothing was forced.") from exc
    if check and result.returncode:
        # Git errors can contain authenticated remote URLs. Do not print them.
        raise PublishError(f"git {args[0]} failed; nothing was forced.")
    return result


def output_path(path: str, kind: str) -> bool:
    return any(path.startswith(p) if p.endswith("/") else fnmatch.fnmatchcase(path, p)
               for p in OUTPUTS[kind])


def unrelated(path: str) -> bool:
    """Only explicit non-generation areas can move during publication."""
    name = path.rsplit("/", 1)[-1].lower()
    return (path.startswith(("snell-panel/", "docs/"))
            or ("/" not in path and (name.startswith("readme") or name.startswith("license")))
            or (not path.startswith(".github/")
                and Path(path).suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico"}))


def fingerprint(ref: str, kind: str) -> dict[str, str]:
    files = {}
    for entry in git("ls-tree", "-rz", "--full-tree", ref).stdout.split(b"\0"):
        if not entry:
            continue
        metadata, raw_path = entry.split(b"\t", 1)
        path = raw_path.decode("utf-8", "surrogateescape")
        # Outputs are protected even when a future output lives in a docs directory.
        if output_path(path, kind) or not unrelated(path):
            files[path] = metadata.decode("ascii")
    return files


def changed_paths() -> list[str]:
    # Treat renames as a deletion plus addition so an allowed destination can
    # never hide removal of a protected source file.
    paths = git("diff", "--no-renames", "--name-only", "-z", "HEAD").stdout.split(b"\0")
    paths += git("ls-files", "--others", "--exclude-standard", "-z").stdout.split(b"\0")
    return sorted({p.decode("utf-8", "surrogateescape") for p in paths if p})


def capture(kind: str, state: Path) -> None:
    if changed_paths():
        raise PublishError("Capture requires a clean checkout before generation.")
    head = git("rev-parse", "HEAD").stdout.decode().strip()
    state.write_text(json.dumps({"kind": kind, "head": head,
                                 "files": fingerprint(head, kind)}), encoding="utf-8")


def publish(state: Path, message: str, branch: str = "master", attempts: int = 3) -> None:
    snapshot = json.loads(state.read_text(encoding="utf-8"))
    kind, base = snapshot["kind"], snapshot["head"]
    if git("rev-parse", "HEAD").stdout.decode().strip() != base:
        raise PublishError("Checkout changed after capture; regenerate and validate again.")
    paths = changed_paths()
    unexpected = [path for path in paths if not output_path(path, kind)]
    if unexpected:
        raise PublishError("Generation changed files outside its publication scope: " + ", ".join(unexpected[:8]))
    if not paths:
        print("No generated changes to publish.")
        return
    git("check-ref-format", "--branch", branch)
    git("config", "user.name", "github-actions[bot]")
    git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com")
    git("add", "-A", "--", *paths)
    git("commit", "-m", message)
    for attempt in range(1, attempts + 1):
        git("fetch", "--no-tags", "origin", f"refs/heads/{branch}")
        remote = git("rev-parse", "FETCH_HEAD").stdout.decode().strip()
        if git("merge-base", "--is-ancestor", base, remote, check=False).returncode:
            raise PublishError("Remote history changed; regenerate from a fresh checkout.")
        current = fingerprint(remote, kind)
        if current != snapshot["files"]:
            changed = sorted(path for path in set(current) | set(snapshot["files"])
                             if current.get(path) != snapshot["files"].get(path))
            raise PublishError("Remote inputs or outputs changed; rerun generation and validation. "
                               "Stale output was not published. Changed: " + ", ".join(changed[:8]))
        # Rebase only when every generation input and output is unchanged.
        if git("merge-base", "--is-ancestor", remote, "HEAD", check=False).returncode:
            if git("rebase", remote, check=False).returncode:
                git("rebase", "--abort", check=False)
                raise PublishError("Safe publication retry conflicted; regenerate from a fresh checkout.")
            print("Preserved unrelated remote changes before publication.")
        if git("merge-base", "--is-ancestor", remote, "HEAD", check=False).returncode:
            raise PublishError("Publication must append to the validated remote history.")
        # The ancestry check permits only an append. An exact lease also rejects
        # branch advances or rewinds between validation and push.
        if git("push", f"--force-with-lease=refs/heads/{branch}:{remote}",
               "origin", f"HEAD:refs/heads/{branch}", check=False).returncode == 0:
            print("Published validated files by appending to the checked remote SHA.")
            return
        if attempt < attempts:
            print(f"Remote changed or push failed; refreshing before retry ({attempt + 1}/{attempts}).")
    raise PublishError("Publication failed after bounded retries; nothing was forced.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    start = commands.add_parser("capture")
    start.add_argument("--kind", choices=OUTPUTS, required=True)
    start.add_argument("--state", type=Path, required=True)
    finish = commands.add_parser("publish")
    finish.add_argument("--state", type=Path, required=True)
    finish.add_argument("--message", required=True)
    finish.add_argument("--branch", default="master")
    args = parser.parse_args()
    try:
        if args.command == "capture":
            capture(args.kind, args.state)
        else:
            publish(args.state, args.message, args.branch)
    except (PublishError, OSError, ValueError, KeyError) as exc:
        print(f"Publication stopped: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
