#!/usr/bin/env python3
"""
Surge RULE-SET 同步脚本

功能：
1. 地区合集 ↔ 独立子项双向同步
2. 独立子项 → 重建 Streaming.list
3. Surge → QX / Clash / sing-box 格式转换
4. 清理已删除的规则文件
5. 拉取 Sample.yaml 外部规则 → sing-box
"""

import json
import re
import sys
import urllib.request
from collections import OrderedDict
from pathlib import Path

# ─── 目录配置 ─────────────────────────────────────────────────────────
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SURGE_DIR = REPO_ROOT / "Surge" / "RULE-SET"
QX_DIR = REPO_ROOT / "Quantumult" / "X" / "Filter"
CLASH_DIR = REPO_ROOT / "Clash" / "RuleSet"
SINGBOX_DIR = REPO_ROOT / "sing-box" / "source"
SAMPLE_YAML = REPO_ROOT / "Clash" / "Sample.yaml"

# ─── QX 不支持的规则类型 ──────────────────────────────────────────────
QX_SKIP = {"USER-AGENT", "URL-REGEX", "PROCESS-NAME", "DOMAIN-WILDCARD", "AND", "OR", "NOT"}

# ─── Clash 不支持的规则类型 ──────────────────────────────────────────
CLASH_SKIP = {"USER-AGENT", "URL-REGEX"}

# ─── sing-box 字段映射 ───────────────────────────────────────────────
SINGBOX_MAP = {
    "DOMAIN":         "domain",
    "DOMAIN-SUFFIX":  "domain_suffix",
    "DOMAIN-KEYWORD": "domain_keyword",
    "IP-CIDR":        "ip_cidr",
    "IP-CIDR6":       "ip_cidr",
    "PROCESS-NAME":   "process_name",
}

# ─── Streaming 配置 ──────────────────────────────────────────────────

# section 名 → 文件名 stem（只列特殊映射，其余 section 名即文件名）
SECTION_TO_FILE = {
    "Hulu JP":            "Hulu_JP",
    "HBO GO Asia":        "HBO_Go",
    "iQIYI Intl":         "IQ",
    "LINE TV":            "LINETV",
    "HBO Max":            "HBO_Max",
    "Amazon Prime Video": "Prime Video",
    "BBC iPlayer":        "BBC",
    "SBS On Demand":      "SBS",
}

# 反向映射（自动生成）
FILE_TO_SECTIONS = {}
for _sec, _file in SECTION_TO_FILE.items():
    FILE_TO_SECTIONS.setdefault(_file, []).append(_sec)

# 合并组：多个 section 合到一个文件
MERGE_GROUPS = {
    "KKBOX&KKTV": ["KKBOX", "KKTV"],
}

# 反向：section → 所属合并文件
MERGE_SECTION_TO_FILE = {}
for _file, _secs in MERGE_GROUPS.items():
    for _s in _secs:
        MERGE_SECTION_TO_FILE[_s] = _file

# 地区合集成员（值为文件名 stem）
REGIONAL_MEMBERS = {
    "Streaming_JP": ["AbemaTV", "FOD", "Hulu_JP", "Paravi", "TVer", "U-NEXT"],
    "Streaming_TW": ["Bahamut", "CATCHPLAY+", "friDay", "HBO_Go", "IQ",
                      "KKBOX&KKTV", "LINETV", "myVideo", "Readmoo", "Spotify"],
    "Streaming_US": ["Crunchyroll", "Discovery+", "HBO_Max", "Hulu", "Max",
                      "MGM+", "PBS", "Paramount+", "Peacock", "Roku", "T-Mobile"],
}

# Streaming.list 成员（按固定顺序，文件名 stem）
# Movies Anywhere 不在此列，内联保留
STREAMING_MEMBERS = [
    "AbemaTV", "Prime Video", "BBC", "Bahamut", "Britbox", "Crunchyroll",
    "DAZN", "Discovery+", "Disney+", "HBO_Max", "Hulu", "MGM+",
    "MUBI", "Netflix", "Paramount+", "Peacock", "SBS", "Spotify",
    "Stan", "Star+", "TVBAnywhere", "TVer", "U-NEXT", "YouTube",
]

MOVIES_ANYWHERE_SECTION = "# > Movies Anywhere\nDOMAIN-SUFFIX,moviesanywhere.com"
MOVIES_ANYWHERE_AFTER = "MGM+"  # 插入在此成员之后


# ═══════════════════════════════════════════════════════════════════════
#  通用工具
# ═══════════════════════════════════════════════════════════════════════

def is_comment(line: str) -> bool:
    s = line.strip()
    return s.startswith("#") or s.startswith("//")


def is_blank(line: str) -> bool:
    return not line.strip()


def write_if_changed(filepath: Path, content: str) -> bool:
    filepath.parent.mkdir(parents=True, exist_ok=True)
    if filepath.exists():
        if filepath.read_text(encoding="utf-8") == content:
            return False
    filepath.write_text(content, encoding="utf-8")
    return True


# ═══════════════════════════════════════════════════════════════════════
#  Step 1 & 2: Streaming 双向同步
# ═══════════════════════════════════════════════════════════════════════

def parse_sections(text: str) -> OrderedDict:
    """按 '# > Name' 分隔符拆分为 {section_name: content_lines}。"""
    sections = OrderedDict()
    current = None
    buf = []
    for line in text.splitlines():
        m = re.match(r"^#\s*>\s*(.+)$", line.strip())
        if m:
            if current is not None:
                while buf and not buf[-1].strip():
                    buf.pop()
                sections[current] = buf
            current = m.group(1).strip()
            buf = [line]
        elif current is not None:
            buf.append(line)
    if current is not None:
        while buf and not buf[-1].strip():
            buf.pop()
        sections[current] = buf
    return sections


def section_name_to_file(name: str) -> str:
    """section 名 → 文件名 stem。"""
    if name in MERGE_SECTION_TO_FILE:
        return MERGE_SECTION_TO_FILE[name]
    return SECTION_TO_FILE.get(name, name)


def file_to_section_names(stem: str) -> list[str]:
    """文件名 stem → 该文件包含的 section 名列表。"""
    if stem in MERGE_GROUPS:
        return MERGE_GROUPS[stem]
    if stem in FILE_TO_SECTIONS:
        return FILE_TO_SECTIONS[stem]
    return [stem]


def read_standalone(stem: str) -> str | None:
    """读取独立 .list 文件内容，不存在返回 None。"""
    p = SURGE_DIR / f"{stem}.list"
    if p.exists():
        return p.read_text(encoding="utf-8")
    return None


def sync_regional():
    """地区合集 ↔ 独立子项双向同步。"""
    print("\n── Step 1: 地区合集 ↔ 独立子项同步 ──")

    for regional_name, members in REGIONAL_MEMBERS.items():
        regional_path = SURGE_DIR / f"{regional_name}.list"
        if not regional_path.exists():
            print(f"  [SKIP] {regional_name}.list 不存在")
            continue

        # 解析地区合集当前包含的 section
        text = regional_path.read_text(encoding="utf-8")
        sections = parse_sections(text)
        regional_stems = {section_name_to_file(s) for s in sections}

        # 检测独立文件是否被删除
        existing = [m for m in members if (SURGE_DIR / f"{m}.list").exists()]
        deleted = [m for m in members
                   if m in regional_stems and not (SURGE_DIR / f"{m}.list").exists()]

        if deleted and existing:
            # 有独立文件被删除 → 从地区合集中移除对应段落
            for d in deleted:
                print(f"  ✗ {d}.list 已删除 → 从 {regional_name} 移除")
            _rebuild_regional(regional_path, regional_name, members)
            continue

        if not existing:
            # 首次运行，全部从地区合集提取
            _extract_regional(regional_path, regional_name, members)
            continue

        # 正常 mtime 比较
        regional_mtime = regional_path.stat().st_mtime
        max_member_mtime = max(
            (SURGE_DIR / f"{m}.list").stat().st_mtime for m in existing
        )

        if regional_mtime >= max_member_mtime:
            _extract_regional(regional_path, regional_name, members)
        else:
            _rebuild_regional(regional_path, regional_name, members)


def _extract_regional(regional_path: Path, regional_name: str, members: list[str]):
    """地区合集 → 独立子项。"""
    text = regional_path.read_text(encoding="utf-8")
    sections = parse_sections(text)

    # 收集每个成员文件应得的 sections
    file_contents: dict[str, list[str]] = {}
    found_files: set[str] = set()

    for sec_name, lines in sections.items():
        stem = section_name_to_file(sec_name)
        found_files.add(stem)
        if stem not in file_contents:
            file_contents[stem] = []
        else:
            file_contents[stem].append("")  # 合并组之间空行
        file_contents[stem].extend(lines)

    for stem, lines in file_contents.items():
        content = "\n".join(lines) + "\n"
        path = SURGE_DIR / f"{stem}.list"
        if write_if_changed(path, content):
            print(f"  ✓ {regional_name} → {stem}.list")

    # 删除不再存在的成员
    for m in members:
        if m not in found_files:
            mp = SURGE_DIR / f"{m}.list"
            if mp.exists():
                mp.unlink()
                print(f"  ✗ 删除 {m}.list（已从 {regional_name} 移除）")


def _rebuild_regional(regional_path: Path, regional_name: str, members: list[str]):
    """独立子项 → 重建地区合集。"""
    parts = []
    for m in members:
        content = read_standalone(m)
        if content is None:
            continue
        text = content.strip()
        if text:
            parts.append(text)

    if parts:
        result = "\n\n".join(parts) + "\n"
        if write_if_changed(regional_path, result):
            print(f"  ✓ 独立子项 → {regional_name}.list")


def rebuild_streaming():
    """独立子项 → 重建 Streaming.list。"""
    print("\n── Step 2: 重建 Streaming.list ──")

    parts = []
    for stem in STREAMING_MEMBERS:
        content = read_standalone(stem)
        if content is None:
            continue
        text = content.strip()
        if text:
            parts.append(text)

        # Movies Anywhere 插入位置
        if stem == MOVIES_ANYWHERE_AFTER:
            parts.append(MOVIES_ANYWHERE_SECTION)

    if not parts:
        print("  [WARN] 无成员文件，跳过")
        return

    result = "\n\n".join(parts) + "\n"
    if write_if_changed(SURGE_DIR / "Streaming.list", result):
        print("  ✓ Streaming.list 已重建")
    else:
        print("  ✓ Streaming.list 无变化")


# ═══════════════════════════════════════════════════════════════════════
#  解析辅助
# ═══════════════════════════════════════════════════════════════════════

def parse_and_rule(raw: str):
    m = re.match(r"AND,\(\((.+)\)\)$", raw.strip())
    if not m:
        return None
    inner = m.group(1)
    parts = re.split(r"\),\s*\(", inner)
    sub_rules = []
    for p in parts:
        p = p.strip().strip("()")
        pieces = p.split(",", 1)
        if len(pieces) == 2:
            sub_rules.append((pieces[0].strip(), pieces[1].strip()))
    return sub_rules if sub_rules else None


def wildcard_to_regex(pattern: str) -> str:
    escaped = re.escape(pattern)
    escaped = escaped.replace(r"\*", ".*").replace(r"\?", ".")
    return f"^{escaped}$"


# ═══════════════════════════════════════════════════════════════════════
#  Step 3: Surge → QX / Clash / sing-box
# ═══════════════════════════════════════════════════════════════════════

def convert_qx(lines: list[str], policy: str) -> str:
    out = []
    for line in lines:
        stripped = line.strip()

        if is_blank(line):
            out.append("")
            continue
        if stripped.startswith("#"):
            out.append(stripped)
            continue
        if stripped.startswith("//"):
            continue

        parts = [p.strip() for p in stripped.split(",")]
        rule_type = parts[0] if parts else ""
        if rule_type in QX_SKIP:
            continue

        value = parts[1] if len(parts) > 1 else ""
        if rule_type in ("IP-CIDR", "IP-CIDR6", "IP6-CIDR", "GEOIP", "IP-ASN"):
            out.append(f"{rule_type},{value},{policy}")
        elif rule_type in ("DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD"):
            out.append(f"{rule_type},{value},{policy}")
        elif value:
            out.append(f"{rule_type},{value},{policy}")

    while out and not out[-1].strip():
        out.pop()
    return "\n".join(out) + "\n"


def convert_clash(lines: list[str]) -> str:
    out = ["payload:"]
    for line in lines:
        stripped = line.strip()

        # 保留空行
        if is_blank(line):
            out.append("")
            continue
        if stripped.startswith("#"):
            out.append(f"  {stripped}")
            continue
        if stripped.startswith("//"):
            continue

        parts = [p.strip() for p in stripped.split(",")]
        rule_type = parts[0] if parts else ""
        if rule_type in CLASH_SKIP:
            continue

        rule_line = ",".join(parts)
        out.append(f"  - {rule_line}")

    while out and not out[-1].strip():
        out.pop()
    return "\n".join(out) + "\n"


def convert_singbox(lines: list[str]) -> str | None:
    groups: dict[str, list[str]] = {}
    logical_rules: list[dict] = []

    for line in lines:
        stripped = line.strip()
        if is_blank(line) or is_comment(line):
            continue

        parts = [p.strip() for p in stripped.split(",")]
        rule_type = parts[0]

        if rule_type == "AND":
            sub_rules = parse_and_rule(stripped)
            if sub_rules:
                nested = []
                for st, sv in sub_rules:
                    sb_type = SINGBOX_MAP.get(st)
                    if sb_type:
                        nested.append({sb_type: [sv]})
                if len(nested) >= 2:
                    logical_rules.append({
                        "type": "logical",
                        "mode": "and",
                        "rules": nested,
                    })
            continue

        if rule_type == "DOMAIN-WILDCARD" and len(parts) > 1:
            groups.setdefault("domain_regex", []).append(
                wildcard_to_regex(parts[1])
            )
            continue

        sb_type = SINGBOX_MAP.get(rule_type)
        if not sb_type:
            continue
        value = parts[1] if len(parts) > 1 else ""
        if value:
            groups.setdefault(sb_type, []).append(value)

    if not groups and not logical_rules:
        return None

    rules: list[dict] = []
    type_order = ["domain", "domain_suffix", "domain_keyword", "domain_regex",
                  "ip_cidr", "process_name"]
    for key in type_order:
        if key in groups:
            rules.append({key: sorted(set(groups[key]))})

    rules.extend(logical_rules)
    if not rules:
        return None

    result = {"version": 2, "rules": rules}
    return json.dumps(result, indent=2, ensure_ascii=False) + "\n"


def process_file(surge_file: Path) -> int:
    lines = surge_file.read_text(encoding="utf-8").splitlines()
    stem = surge_file.stem
    updated = 0

    # QX
    qx_content = convert_qx(lines, stem)
    if write_if_changed(QX_DIR / f"{stem}.list", qx_content):
        print(f"    ✓ QX:      {stem}.list")
        updated += 1

    # Clash
    clash_content = convert_clash(lines)
    if write_if_changed(CLASH_DIR / f"{stem}.yaml", clash_content):
        print(f"    ✓ Clash:   {stem}.yaml")
        updated += 1

    # sing-box
    sb_content = convert_singbox(lines)
    if sb_content:
        if write_if_changed(SINGBOX_DIR / f"{stem}.json", sb_content):
            print(f"    ✓ sing-box: {stem}.json")
            updated += 1

    return updated


def convert_all():
    """遍历 Surge/RULE-SET 所有 .list（含子目录），逐文件转换。"""
    print("\n── Step 3: Surge → QX / Clash / sing-box ──")

    surge_files = sorted(SURGE_DIR.rglob("*.list"))
    if not surge_files:
        print("  未找到 Surge 规则文件")
        return

    total = 0
    for sf in surge_files:
        rel = sf.relative_to(SURGE_DIR)
        print(f"  [{rel}]")
        total += process_file(sf)

    print(f"  更新 {total} 个文件")


# ═══════════════════════════════════════════════════════════════════════
#  Step 4: 清理已删除的文件
# ═══════════════════════════════════════════════════════════════════════

def cleanup_stale():
    """QX/Clash/sing-box 中存在但 Surge 中已无对应源的文件 → 删除。"""
    print("\n── Step 4: 清理已删除的文件 ──")

    surge_stems = set()
    for sf in SURGE_DIR.rglob("*.list"):
        surge_stems.add(sf.stem)

    # 外部规则名也需保留（Step 5 生成的 sing-box 文件）
    external_stems = {p["name"] for p in parse_sample_providers()}
    keep = surge_stems | external_stems

    deleted = 0
    for target_dir, ext in [(QX_DIR, ".list"), (CLASH_DIR, ".yaml"), (SINGBOX_DIR, ".json")]:
        if not target_dir.exists():
            continue
        for f in sorted(target_dir.iterdir()):
            if f.suffix == ext and f.stem not in keep:
                f.unlink()
                print(f"  ✗ 删除 {f.relative_to(REPO_ROOT)}")
                deleted += 1

    if not deleted:
        print("  无需清理")


# ═══════════════════════════════════════════════════════════════════════
#  Step 5: Sample.yaml 外部规则 → sing-box
# ═══════════════════════════════════════════════════════════════════════

def parse_sample_providers() -> list[dict]:
    """解析 Clash/Sample.yaml 中的外部 rule-providers。"""
    if not SAMPLE_YAML.exists():
        return []

    text = SAMPLE_YAML.read_text(encoding="utf-8")
    providers = []
    current_name = None
    current = {}

    in_providers = False
    for line in text.splitlines():
        stripped = line.strip()

        if stripped == "rule-providers:":
            in_providers = True
            continue
        if in_providers and line and not line[0].isspace() and not stripped.startswith("#"):
            break
        if not in_providers:
            continue
        if not stripped or stripped.startswith("#"):
            continue

        # provider name（2 空格缩进）
        m = re.match(r"^  (\S.*?):\s*$", line)
        if m:
            if current_name and current.get("url"):
                current["name"] = current_name
                providers.append(current)
            current_name = m.group(1)
            current = {}
            continue

        # 属性
        m = re.match(r"^\s+(url|behavior):\s*(.+)$", line)
        if m:
            current[m.group(1)] = m.group(2).strip()

    if current_name and current.get("url"):
        current["name"] = current_name
        providers.append(current)

    # 只保留外部（非本仓库）
    return [p for p in providers if "HotKids/Rules" not in p.get("url", "")]


def fetch_url(url: str) -> str | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "sync-rules/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8")
    except Exception as e:
        print(f"    [ERR] 下载失败: {url} ({e})")
        return None


def convert_domain_list_to_singbox(text: str) -> str | None:
    """behavior: domain → sing-box JSON。"""
    domains = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("//"):
            continue
        if line.startswith("+."):
            line = line[2:]
        domains.append(line)
    if not domains:
        return None
    result = {"version": 2, "rules": [{"domain_suffix": sorted(set(domains))}]}
    return json.dumps(result, indent=2, ensure_ascii=False) + "\n"


def convert_ipcidr_list_to_singbox(text: str) -> str | None:
    """behavior: ipcidr → sing-box JSON。"""
    cidrs = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("//"):
            continue
        cidrs.append(line)
    if not cidrs:
        return None
    result = {"version": 2, "rules": [{"ip_cidr": sorted(set(cidrs))}]}
    return json.dumps(result, indent=2, ensure_ascii=False) + "\n"


def convert_classical_yaml_to_singbox(text: str) -> str | None:
    """Clash classical payload → sing-box JSON。"""
    lines = []
    in_payload = False
    for raw in text.splitlines():
        stripped = raw.strip()
        if stripped == "payload:":
            in_payload = True
            continue
        if in_payload and stripped.startswith("- "):
            lines.append(stripped[2:].strip())

    if not lines:
        return None

    groups: dict[str, list[str]] = {}
    for line in lines:
        if line.startswith("#") or line.startswith("//"):
            continue
        parts = [p.strip() for p in line.split(",")]
        rule_type = parts[0]
        sb_type = SINGBOX_MAP.get(rule_type)
        if sb_type and len(parts) > 1:
            groups.setdefault(sb_type, []).append(parts[1])

    if not groups:
        return None

    rules: list[dict] = []
    for key in ["domain", "domain_suffix", "domain_keyword", "ip_cidr", "process_name"]:
        if key in groups:
            rules.append({key: sorted(set(groups[key]))})

    if not rules:
        return None

    result = {"version": 2, "rules": rules}
    return json.dumps(result, indent=2, ensure_ascii=False) + "\n"


def fetch_external_rules():
    """拉取 Sample.yaml 外部规则 → sing-box。"""
    print("\n── Step 5: 外部规则 → sing-box ──")

    providers = parse_sample_providers()
    if not providers:
        print("  无外部 rule-provider")
        return

    for p in providers:
        name = p["name"]
        url = p["url"]
        behavior = p.get("behavior", "classical")

        print(f"  [{name}] {behavior} ← {url}")
        text = fetch_url(url)
        if text is None:
            continue

        if behavior == "domain":
            content = convert_domain_list_to_singbox(text)
        elif behavior == "ipcidr":
            content = convert_ipcidr_list_to_singbox(text)
        else:
            content = convert_classical_yaml_to_singbox(text)

        if content:
            if write_if_changed(SINGBOX_DIR / f"{name}.json", content):
                print(f"    ✓ sing-box: {name}.json")
            else:
                print(f"    ✓ {name}.json 无变化")
        else:
            print(f"    [WARN] {name} 转换结果为空")


# ═══════════════════════════════════════════════════════════════════════
#  Main
# ═══════════════════════════════════════════════════════════════════════

def main():
    print("=" * 60)
    print("  Rules 同步脚本")
    print("=" * 60)

    # Step 1: 地区合集 ↔ 独立子项
    sync_regional()

    # Step 2: 独立子项 → Streaming.list
    rebuild_streaming()

    # Step 3: Surge → QX / Clash / sing-box
    convert_all()

    # Step 4: 清理
    cleanup_stale()

    # Step 5: 外部规则 → sing-box
    fetch_external_rules()

    print(f"\n{'=' * 60}")
    print("  完成")
    print("=" * 60)


if __name__ == "__main__":
    main()
