#!/usr/bin/env python3
"""
Surge sgmodule 聚合脚本

读取 sync-modules.txt 中的 URL 列表，拉取并合并为单个 sgmodule。
每个来源模块以 # > NAME 分组，按名称首字符排序：数字 → 英文 → 汉字拼音。
"""

import re
import sys
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta
from pathlib import Path
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

from pypinyin import lazy_pinyin

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SYNC_TXT = Path(__file__).resolve().parent / "sync-modules.txt"
OUTPUT_FILE = REPO_ROOT / "Surge" / "Module" / "LoonKissSurge.sgmodule"

_SECTION_RE = re.compile(r"^\[(.+)\]$")
_META_FIELD_RE = re.compile(r"^#!(\w+)=(.*)$")

_MITM_BOOL_KEYS = {"skip-server-cert-verify", "h2", "tcp-connection"}

_SECTION_ORDER = ["MITM", "Rule", "Map Local", "Script", "URL Rewrite", "Header Rewrite"]


def _sort_key(name: str) -> str:
    """数字 → 英文字母 → 汉字拼音 排序键。"""
    if not name:
        return "~"
    first = name[0]
    if first.isdigit():
        return "0" + name
    if first.isascii() and first.isalpha():
        return "1" + name.lower()
    return "2" + "".join(lazy_pinyin(name))


def _encode_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    encoded_path = urllib.parse.quote(parsed.path, safe="/-_.~!$&'()*+,;=:@%")
    return urllib.parse.urlunparse(parsed._replace(path=encoded_path))


def fetch_url(url: str) -> tuple[str, str | None]:
    try:
        encoded = _encode_url(url)
        req = urllib.request.Request(encoded, headers={"User-Agent": "sync-modules/1.0"})
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


def _merge_mitm(entries: list[tuple[str, list[str]]]) -> list[str]:
    """合并多个来源的 [MITM] 块：hostname 去重合并，布尔键取 true 优先。"""
    hostnames: list[str] = []
    seen_hosts: set[str] = set()
    bool_flags: dict[str, str] = {}
    other: list[str] = []

    for _name, lines in entries:
        for line in lines:
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
                if bool_flags.get(key) != "true":
                    bool_flags[key] = val
            else:
                other.append(line)

    result = list(other)
    for k, v in bool_flags.items():
        result.append(f"{k} = {v}")
    if hostnames:
        result.append(f"hostname = %APPEND% {', '.join(hostnames)}")
    return result


def load_urls() -> list[str]:
    urls: list[str] = []
    for line in SYNC_TXT.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            urls.append(stripped)
    return urls


def read_output_meta() -> dict[str, str]:
    meta: dict[str, str] = {}
    if not OUTPUT_FILE.exists():
        return meta
    for line in OUTPUT_FILE.read_text(encoding="utf-8").splitlines():
        m = _META_FIELD_RE.match(line.strip())
        if m:
            meta[m.group(1)] = m.group(2).strip()
    return meta


def write_if_changed(path: Path, content: str) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_text(encoding="utf-8") == content:
        return False
    path.write_text(content, encoding="utf-8")
    return True


def aggregate():
    urls = load_urls()
    if not urls:
        print("[WARN] sync-modules.txt 中无 URL 条目")
        return

    existing_meta = read_output_meta()

    print(f"并发拉取 {len(urls)} 个 sgmodule …")
    results: dict[str, str | None] = {}
    with ThreadPoolExecutor(max_workers=min(8, len(urls))) as pool:
        futures = {pool.submit(fetch_url, u): u for u in urls}
        for fut in as_completed(futures):
            url, text = fut.result()
            results[url] = text

    # {section: [(name, [lines]), ...]}  按原顺序收集
    section_entries: dict[str, list[tuple[str, list[str]]]] = defaultdict(list)
    # name -> hostname 注释字符串（用于各 section 内的 # hostname = ... 提示行）
    module_hostnames: dict[str, str] = {}

    for url in urls:
        text = results.get(url)
        if not text:
            continue
        parsed = parse_sgmodule(text)
        name = parsed["meta"].get("name", url)
        # 提取该模块自身的 hostname
        mitm_lines = parsed["sections"].get("MITM", [])
        for line in mitm_lines:
            if "=" in line:
                k, _, v = line.partition("=")
                if k.strip() == "hostname":
                    v = re.sub(r"^%APPEND%\s*", "", v.strip())
                    if v:
                        module_hostnames[name] = v
                    break
        for section, lines in parsed["sections"].items():
            non_empty = [l for l in lines if l.strip()]
            if non_empty:
                section_entries[section].append((name, non_empty))
        print(f"  ✓ {name}")

    # 对每个 section 内的条目按名称排序（MITM 单独处理）
    for sec in section_entries:
        if sec != "MITM":
            section_entries[sec].sort(key=lambda x: _sort_key(x[0]))

    # 构建输出（name/desc/category 保留手动维护值，date 取当前同步时间）
    now = datetime.now(tz=timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S")
    out: list[str] = []
    out.append(f"#!name={existing_meta.get('name', 'LoonKissSurge 合集')}")
    out.append(f"#!desc={existing_meta.get('desc', '自动聚合，每日更新')}")
    out.append(f"#!category={existing_meta.get('category', '去广告')}")
    out.append(f"#!date={now}")
    out.append("")

    written_sections: set[str] = set()

    def write_section(sec: str):
        entries = section_entries.get(sec, [])
        if not entries:
            return
        out.append(f"[{sec}]")
        if sec == "MITM":
            out.extend(_merge_mitm(entries))
        else:
            first = True
            for name, lines in entries:
                if not first:
                    out.append("")
                out.append(f"# > {name}")
                if sec == "Script" and name in module_hostnames:
                    out.append(f"# hostname = {module_hostnames[name]}")
                out.extend(lines)
                first = False
        out.append("")
        written_sections.add(sec)

    for sec in _SECTION_ORDER:
        write_section(sec)

    for sec in section_entries:
        if sec not in written_sections:
            write_section(sec)

    content = "\n".join(out).rstrip("\n") + "\n"

    if write_if_changed(OUTPUT_FILE, content):
        print(f"\n✓ {OUTPUT_FILE.relative_to(REPO_ROOT)} 已更新")
    else:
        print(f"\n✓ {OUTPUT_FILE.relative_to(REPO_ROOT)} 无变化")


if __name__ == "__main__":
    aggregate()
