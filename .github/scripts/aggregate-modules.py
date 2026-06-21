#!/usr/bin/env python3
"""
Surge sgmodule 聚合脚本

读取 aggregate-modules.txt 中的 URL 列表，拉取并合并为单个 sgmodule。
"""

import re
import sys
import urllib.request
import urllib.parse
from pathlib import Path
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
AGGREGATE_TXT = Path(__file__).resolve().parent / "aggregate-modules.txt"
OUTPUT_FILE = REPO_ROOT / "Surge" / "Module" / "ThirdParty.sgmodule"

# 从 txt 文件头注释中读取输出元信息
_META_RE = re.compile(r"^#\s*(#!(?:name|desc)=.+)$")
_SECTION_RE = re.compile(r"^\[(.+)\]$")
_META_FIELD_RE = re.compile(r"^#!(\w+)=(.*)$")

# [MITM] 中需要逐字段合并而非直接拼接的键
_MITM_BOOL_KEYS = {"skip-server-cert-verify", "h2", "tcp-connection"}

# 节的输出顺序
_SECTION_ORDER = ["Rule", "Script", "Map Local", "URL Rewrite", "Header Rewrite", "MITM"]


def _encode_url(url: str) -> str:
    """对 URL 中的非 ASCII 字符进行路径编码，保留合法分隔符。"""
    parsed = urllib.parse.urlparse(url)
    encoded_path = urllib.parse.quote(parsed.path, safe="/-_.~!$&'()*+,;=:@%")
    return urllib.parse.urlunparse(parsed._replace(path=encoded_path))


def fetch_url(url: str) -> tuple[str, str | None]:
    try:
        encoded = _encode_url(url)
        req = urllib.request.Request(encoded, headers={"User-Agent": "aggregate-modules/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return url, resp.read().decode("utf-8")
    except Exception as e:
        print(f"  [ERR] 下载失败: {url}\n        {e}", file=sys.stderr)
        return url, None


def parse_sgmodule(text: str) -> dict:
    """解析 sgmodule，返回 {meta: {k:v}, sections: {name: [lines]}}。"""
    meta: dict[str, str] = {}
    sections: dict[str, list[str]] = defaultdict(list)
    current = None

    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        m = _META_FIELD_RE.match(stripped)
        if m:
            meta[m.group(1)] = m.group(2).strip()
            continue
        m = _SECTION_RE.match(stripped)
        if m:
            current = m.group(1)
            continue
        if current is not None:
            sections[current].append(stripped)

    return {"meta": meta, "sections": sections}


def _merge_mitm(all_mitm_lines: list[str]) -> list[str]:
    """合并多个 [MITM] 块：hostname 去重合并，布尔键取 true 优先，其余保留唯一。"""
    hostnames: list[str] = []
    seen_hosts: set[str] = set()
    bool_flags: dict[str, str] = {}
    other: list[str] = []

    for line in all_mitm_lines:
        if not line.strip():
            continue
        if "=" not in line:
            other.append(line)
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip()

        if key == "hostname":
            val = re.sub(r"^%APPEND%\s*", "", val)
            for h in val.split(","):
                h = h.strip()
                if h and h not in seen_hosts:
                    seen_hosts.add(h)
                    hostnames.append(h)
        elif key in _MITM_BOOL_KEYS:
            # true 优先
            if bool_flags.get(key) != "true":
                bool_flags[key] = val
        else:
            other.append(line)

    result = list(other)
    for k, v in bool_flags.items():
        result.append(f"{k} = {v}")
    if hostnames:
        result.append(f"hostname = {', '.join(hostnames)}")
    return result


def load_config() -> tuple[dict[str, str], list[str]]:
    """从 aggregate-modules.txt 读取元信息注释和 URL 列表。"""
    meta: dict[str, str] = {}
    urls: list[str] = []

    for line in AGGREGATE_TXT.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        m = _META_RE.match(stripped)
        if m:
            field = _META_FIELD_RE.match(m.group(1))
            if field:
                meta[field.group(1)] = field.group(2).strip()
            continue
        if stripped.startswith("#"):
            continue
        urls.append(stripped)

    return meta, urls


def write_if_changed(path: Path, content: str) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_text(encoding="utf-8") == content:
        return False
    path.write_text(content, encoding="utf-8")
    return True


def aggregate():
    meta, urls = load_config()
    if not urls:
        print("[WARN] aggregate-modules.txt 中无 URL 条目")
        return

    print(f"并发拉取 {len(urls)} 个 sgmodule …")
    results: dict[str, str | None] = {}
    with ThreadPoolExecutor(max_workers=min(8, len(urls))) as pool:
        futures = {pool.submit(fetch_url, u): u for u in urls}
        for fut in as_completed(futures):
            url, text = fut.result()
            results[url] = text

    # 按原顺序处理，保证输出稳定
    section_lines: dict[str, list[str]] = defaultdict(list)
    source_names: list[str] = []

    for url in urls:
        text = results.get(url)
        if not text:
            continue
        parsed = parse_sgmodule(text)
        name = parsed["meta"].get("name", "")
        if name:
            source_names.append(name)
        for section, lines in parsed["sections"].items():
            if lines:
                if section_lines[section]:
                    section_lines[section].append("")  # 不同模块间空行分隔
                section_lines[section].extend(lines)
        print(f"  ✓ {name or url}")

    if "MITM" in section_lines:
        section_lines["MITM"] = _merge_mitm(section_lines["MITM"])

    # 构建输出
    out: list[str] = []
    out.append(f"#!name={meta.get('name', '第三方 sgmodule 合集')}")
    out.append(f"#!desc={meta.get('desc', '自动聚合，每日更新')}")
    out.append("")

    written_sections: set[str] = set()
    for sec in _SECTION_ORDER:
        if sec in section_lines and section_lines[sec]:
            out.append(f"[{sec}]")
            out.extend(section_lines[sec])
            out.append("")
            written_sections.add(sec)

    for sec, lines in section_lines.items():
        if sec not in written_sections and lines:
            out.append(f"[{sec}]")
            out.extend(lines)
            out.append("")

    content = "\n".join(out).rstrip("\n") + "\n"

    if write_if_changed(OUTPUT_FILE, content):
        print(f"\n✓ {OUTPUT_FILE.relative_to(REPO_ROOT)} 已更新")
    else:
        print(f"\n✓ {OUTPUT_FILE.relative_to(REPO_ROOT)} 无变化")


if __name__ == "__main__":
    aggregate()
