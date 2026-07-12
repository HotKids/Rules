#!/usr/bin/env python3
"""
Surge RULE-SET 同步脚本

功能：
1. 拉取 sync-rules.txt 外部规则（Surge section → Surge/RULE-SET；Clash section → Clash/sing-box）
2. 地区合集 ↔ 独立子项双向同步
3. 独立子项 → 重建 Streaming.list
4. Surge → QX / Clash / sing-box 格式转换（# >> Clash 条目已由 Step 1 直接写入，跳过）
5. 清理已删除的规则文件
"""

import json
import re
import subprocess
from datetime import datetime, timezone, timedelta
from collections import defaultdict
from pathlib import Path

from _common import write_if_changed, prefetch_urls

# ─── 目录配置 ─────────────────────────────────────────────────────────
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SURGE_DIR = REPO_ROOT / "Surge" / "RULE-SET"
QX_DIR = REPO_ROOT / "Quantumult" / "X" / "Filter"
CLASH_DIR = REPO_ROOT / "Clash" / "RuleSet"
SINGBOX_DIR = REPO_ROOT / "sing-box" / "source"
SYNC_RULES_TXT = REPO_ROOT / ".github" / "scripts" / "sync-rules.txt"
_UA = "sync-rules/1.0"


def _recently_changed_files() -> set[str]:
    """Return repo-relative paths of recently changed files.

    Checks both the HEAD commit (for CI shallow clones) and the working tree
    (for local runs with uncommitted edits), so direction detection works in
    both environments.
    """
    result: set[str] = set()
    try:
        for cmd in (
            ["git", "diff-tree", "--no-commit-id", "-r", "--name-only", "HEAD"],
            ["git", "diff", "--name-only", "HEAD"],
        ):
            out = subprocess.run(
                cmd, capture_output=True, text=True, cwd=REPO_ROOT,
            ).stdout.strip()
            if out:
                result.update(out.splitlines())
    except Exception:
        pass
    return result

# ─── QX 不支持的规则类型 ──────────────────────────────────────────────
QX_SKIP = {"URL-REGEX", "AND", "OR", "NOT", "PROCESS-NAME", "PROCESS-NAME-REGEX"}

# ─── Clash 不支持的规则类型 ──────────────────────────────────────────
CLASH_SKIP = {"USER-AGENT", "URL-REGEX"}

# ─── sing-box 字段映射 ───────────────────────────────────────────────
SINGBOX_MAP = {
    "DOMAIN":              "domain",
    "DOMAIN-SUFFIX":       "domain_suffix",
    "DOMAIN-KEYWORD":      "domain_keyword",
    "IP-CIDR":             "ip_cidr",
    "IP-CIDR6":            "ip_cidr",
    "PROCESS-NAME":        "process_name",
    "PROCESS-NAME-REGEX":  "process_name_regex",
}

# ─── Clash 专属规则类型（Surge 不支持，手动维护后同步到 sing-box）────────
CLASH_PRESERVE_TYPES = {"PROCESS-NAME", "PROCESS-NAME-REGEX"}

# ─── Clash CIDR 伴生文件：stem → 伴生文件名 ──────────────────────────
# 生成与 Loyalsoldier lancidr.txt 同格式的纯 CIDR ipcidr payload（扩展名为 .txt）
CLASH_CIDR_COMPANION = {"LAN": "lancidr.txt"}

# ─── Streaming 配置 ──────────────────────────────────────────────────


# 地区合集与 Streaming.list 成员由独立文件内的占位符动态扫描得出（见 scan_streaming_placeholders）
# 占位符格式：### Streaming [REGION]
#   ### Streaming TW  → 拼入 Streaming_TW.list 及 Streaming.list
#   ### Streaming US  → 拼入 Streaming_US.list 及 Streaming.list
#   ### Streaming JP  → 拼入 Streaming_JP.list 及 Streaming.list
#   ### Streaming     → 仅拼入 Streaming.list
STREAMING_PLACEHOLDER_RE = re.compile(r"^###\s+Streaming(?:\s+([A-Z]+))?\s*$")


# 合并组：含 ### Streaming 占位符且含多个 '# > Name' 节的文件视为合并组
# 只扫描 streaming 服务文件，排除 Block.list / Unbreak.list 等多节非 streaming 文件
def _build_merge_maps() -> dict[str, str]:
    """扫描根目录各 streaming .list 文件，将含多个 '# > Name' 节的 section 名映射到其文件 stem。"""
    reverse: dict[str, str] = {}
    for p in sorted(SURGE_DIR.glob("*.list")):
        if p.stem.startswith("Streaming"):
            continue
        text = p.read_text(encoding="utf-8")
        lines = text.splitlines()
        if not any(STREAMING_PLACEHOLDER_RE.match(line.strip()) for line in lines):
            continue  # 非 streaming 服务文件，跳过
        secs = [m.group(1).strip()
                for line in lines
                if (m := re.match(r"^#\s*>\s*(.+)$", line.strip()))]
        if len(secs) > 1:
            for s in secs:
                reverse[s] = p.stem
    return reverse

MERGE_SECTION_TO_FILE = _build_merge_maps()


# ═══════════════════════════════════════════════════════════════════════
#  通用工具
# ═══════════════════════════════════════════════════════════════════════

def is_blank(line: str) -> bool:
    return not line.strip()


def _mark_upstream_deleted(filepath: Path) -> None:
    """在 ### fork from 行后插入 ### upstream 404 · DATE 标记（幂等）。"""
    if not filepath.exists():
        return
    lines = filepath.read_text(encoding="utf-8").splitlines()
    if any(l.startswith("### upstream 404") for l in lines):
        return  # 已标记，不重复写
    today = datetime.now(tz=timezone(timedelta(hours=8))).strftime("%Y-%m-%d")
    new_lines = []
    for line in lines:
        new_lines.append(line)
        if line.startswith("### fork from "):
            new_lines.append(f"### upstream 404 · {today}")
    if write_if_changed(filepath, "\n".join(new_lines) + "\n"):
        print(f"  ⚠ {filepath.name} 上游已删除，已标记")


def strip_streaming_placeholders(text: str) -> str:
    """从文件内容中去除 ### Streaming * 占位符行。"""
    lines = [l for l in text.splitlines()
             if not STREAMING_PLACEHOLDER_RE.match(l.strip())]
    return "\n".join(lines)


def scan_streaming_placeholders() -> dict[str, list[str]]:
    """扫描各独立 .list 文件，收集 ### Streaming [REGION] 占位符。

    返回 {"": [仅总表 stems], "JP": [...], "TW": [...], "US": [...]}。
    聚合文件（Streaming*.list）跳过。
    """
    result: dict[str, list[str]] = {}
    for p in sorted(SURGE_DIR.glob("*.list")):
        if p.stem.startswith("Streaming"):
            continue
        for line in p.read_text(encoding="utf-8").splitlines():
            m = STREAMING_PLACEHOLDER_RE.match(line.strip())
            if m:
                region = m.group(1) or ""
                result.setdefault(region, []).append(p.stem)
                break
    return result


# ═══════════════════════════════════════════════════════════════════════
#  Step 1 & 2: Streaming 双向同步
# ═══════════════════════════════════════════════════════════════════════

def parse_sections(text: str) -> dict:
    """按 '# > Name' 分隔符拆分为 {section_name: content_lines}。"""
    sections: dict = {}
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
    """section 名 → 文件名 stem。空格与下划线等价（先查显式映射，再尝试空格→下划线）。"""
    if name in MERGE_SECTION_TO_FILE:
        return MERGE_SECTION_TO_FILE[name]
    normalized = name.replace(" ", "_")
    if (SURGE_DIR / f"{normalized}.list").exists():
        return normalized
    return name


def read_standalone(stem: str) -> str | None:
    """读取独立 .list 文件内容，不存在返回 None。"""
    p = SURGE_DIR / f"{stem}.list"
    if p.exists():
        return p.read_text(encoding="utf-8")
    return None


def _extract_streaming(streaming_path: Path, placeholders: dict[str, list[str]]) -> None:
    """总合集 → 独立子项（保留各文件的 ### Streaming 占位符）。"""
    text = streaming_path.read_text(encoding="utf-8")
    sections = parse_sections(text)
    stem_to_region = {
        stem: region
        for region, stems in placeholders.items()
        for stem in stems
    }
    for sec_name, lines in sections.items():
        stem = section_name_to_file(sec_name)
        if stem not in stem_to_region:
            print(f"  [SKIP] 无法确定 region，跳过: {sec_name}")
            continue
        region = stem_to_region[stem]
        out_lines = _inject_placeholder(lines, region) if region else lines
        if write_if_changed(SURGE_DIR / f"{stem}.list", "\n".join(out_lines) + "\n"):
            print(f"  ✓ Streaming.list → {stem}.list")


def sync_streaming() -> None:
    """Streaming 三层双向同步：总合集 ↔ 地区合集 ↔ 独立子项，以独立子项为枢纽。

    同步方向由近期有改动的文件决定（HEAD commit + 工作区未提交改动）：
    - 仅总合集有改动       → 提取到独立子项，再重建各地区合集和总合集
    - 仅某地区合集有改动   → 提取到对应独立子项，再重建所有合集
    - 独立子项有改动       → 直接重建各地区合集和总合集
    - 无改动（cron/首次）  → 从独立子项重建所有合集（或从地区合集提取首次建档）
    """
    print("\n── Step 2/3: Streaming 三层同步 ──")

    changed = _recently_changed_files()
    placeholders = scan_streaming_placeholders()
    streaming_path = SURGE_DIR / "Streaming.list"

    def rel(p: Path) -> str:
        return p.relative_to(REPO_ROOT).as_posix()

    all_stems = sorted(set().union(*placeholders.values()))

    # 各地区合集元信息
    regionals: dict[str, tuple[Path, list[str], str]] = {}
    for region_key, stems in placeholders.items():
        if not region_key:
            continue
        name = f"Streaming_{region_key}"
        path = SURGE_DIR / f"{name}.list"
        if path.exists():
            regionals[name] = (path, stems, region_key)

    member_changed     = any(rel(SURGE_DIR / f"{s}.list") in changed for s in all_stems)
    streaming_changed  = rel(streaming_path) in changed
    any_reg_changed    = any(rel(p) in changed for p, _, _ in regionals.values())

    # ── 阶段一：将"被直接编辑的上层合集"落实到独立子项 ──────────────────
    if streaming_changed and not member_changed and not any_reg_changed:
        print("  [方向] 总合集 → 独立子项")
        _extract_streaming(streaming_path, placeholders)
    else:
        for name, (path, stems, region) in regionals.items():
            existing = [s for s in stems if (SURGE_DIR / f"{s}.list").exists()]
            regional_changed     = rel(path) in changed
            this_member_changed  = any(rel(SURGE_DIR / f"{s}.list") in changed for s in existing)
            if not existing:
                # 首次运行：从地区合集提取独立子项
                print(f"  [首次] {name} → 独立子项")
                _extract_regional(path, name, stems, region)
            elif regional_changed and not this_member_changed:
                print(f"  [方向] {name} → 独立子项")
                _extract_regional(path, name, existing, region)

    # ── 阶段二：从独立子项重建所有地区合集 ──────────────────────────────
    for name, (path, stems, _region) in regionals.items():
        existing = [s for s in stems if (SURGE_DIR / f"{s}.list").exists()]
        if existing:
            _rebuild_regional(path, name, existing)

    # ── 阶段三：从独立子项重建总合集 ────────────────────────────────────
    parts = []
    for stem in all_stems:
        content = read_standalone(stem)
        if content is None:
            continue
        text = strip_streaming_placeholders(content).strip()
        if text:
            parts.append(text)
    if not parts:
        print("  [WARN] 无成员文件，跳过总合集重建")
        return
    result = "\n\n".join(parts) + "\n"
    if write_if_changed(streaming_path, result):
        print("  ✓ Streaming.list 已重建")
    else:
        print("  ✓ Streaming.list 无变化")


def _inject_placeholder(lines: list[str], region: str) -> list[str]:
    """在 lines 的第一个 '# > Name' 行之后插入 '### Streaming REGION'（若尚不存在）。"""
    placeholder = f"### Streaming {region}"
    if any(STREAMING_PLACEHOLDER_RE.match(l.strip()) for l in lines):
        return lines
    result = []
    inserted = False
    for line in lines:
        result.append(line)
        if not inserted and re.match(r"^#\s*>\s*(.+)$", line.strip()):
            result.append(placeholder)
            inserted = True
    return result


def _extract_regional(regional_path: Path, regional_name: str, members: list[str], region: str):
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
        lines = _inject_placeholder(lines, region)
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
        text = strip_streaming_placeholders(content).strip()
        if text:
            parts.append(text)

    if parts:
        result = "\n\n".join(parts) + "\n"
        if write_if_changed(regional_path, result):
            print(f"  ✓ 独立子项 → {regional_name}.list")


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


# ═══════════════════════════════════════════════════════════════════════
#  Step 3: Surge → QX / Clash / sing-box
# ═══════════════════════════════════════════════════════════════════════

class PendingSection:
    """缓冲 '# > Section' 与 '# >> Sub' 头部，等到真的有规则 emit 才刷出。

    push_section('# > X') 会清空 pending sub（新 section 重置子结构）。
    push_sub('# >> Y') 只替换 pending sub。
    flush() 返回当前持有行并清空。规则/普通 # 注释被 skip 时不做任何事 ——
    pending 自然保留到下一次 emit 或被新同级 header 覆盖，整节全 skip 时自然丢弃。
    """

    __slots__ = ("section", "sub")

    def __init__(self) -> None:
        self.section: str | None = None
        self.sub: str | None = None

    def push_section(self, line: str) -> None:
        self.section = line
        self.sub = None

    def push_sub(self, line: str) -> None:
        self.sub = line

    def flush(self) -> list[str]:
        out = [x for x in (self.section, self.sub) if x is not None]
        self.section = None
        self.sub = None
        return out


def _split_inline_comment(rule: str) -> tuple[str, str]:
    """拆出 Surge 行内 // 注释。返回 (规则体, 注释文本)；无注释则注释为空串。"""
    idx = rule.find("//")
    if idx == -1:
        return rule.rstrip(), ""
    return rule[:idx].rstrip().rstrip(","), rule[idx + 2:].strip()


def _emit_with_prelude(
    out: list[str],
    line: str,
    ps: PendingSection,
    pending_blank: bool,
    head_guard: int = 0,
) -> bool:
    """真正 emit 时统一处理：空行分隔 + flush pending section/sub + 追加 line。
    返回新的 pending_blank (总是 False)。head_guard 指 out 初始非空内容行数
    （Clash 的 'payload:' 为 1，QX 为 0），用于避免紧跟头插入空行。
    """
    if pending_blank and len(out) > head_guard:
        out.append("")
    out.extend(ps.flush())
    out.append(line)
    return False


def convert_qx(lines: list[str], policy: str) -> str:
    out: list[str] = []
    ps = PendingSection()
    pending_blank = False

    for line in lines:
        stripped = line.strip()

        if is_blank(line):
            pending_blank = True
            continue
        if stripped.startswith("# >>"):
            ps.push_sub(stripped)
            continue
        if stripped.startswith("# >"):
            ps.push_section(stripped)
            continue
        if stripped.startswith("//"):
            pending_blank = _emit_with_prelude(out, f"# {stripped[2:].strip()}", ps, pending_blank)
            continue
        if STREAMING_PLACEHOLDER_RE.match(stripped):
            continue
        if stripped.startswith("#"):
            pending_blank = _emit_with_prelude(out, stripped, ps, pending_blank)
            continue

        body, inline = _split_inline_comment(stripped)
        parts = [p.strip() for p in body.split(",")]
        rule_type = parts[0] if parts else ""
        if rule_type in QX_SKIP:
            continue

        value = parts[1] if len(parts) > 1 else ""
        no_resolve = len(parts) > 2 and parts[2].lower() == "no-resolve"

        if rule_type in ("IP-CIDR", "IP-CIDR6", "IP6-CIDR", "GEOIP", "IP-ASN"):
            # QX uses IP6-CIDR instead of Surge/Clash's IP-CIDR6
            qx_type = "IP6-CIDR" if rule_type == "IP-CIDR6" else rule_type
            suffix = ",no-resolve" if no_resolve else ""
            rule_line = f"{qx_type},{value},{policy}{suffix}"
        elif rule_type in ("DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD"):
            rule_line = f"{rule_type},{value},{policy}"
        elif value:
            rule_line = f"{rule_type},{value},{policy}"
        else:
            continue

        if inline:
            rule_line = f"{rule_line}  // {inline}"

        pending_blank = _emit_with_prelude(out, rule_line, ps, pending_blank)

    while out and not out[-1].strip():
        out.pop()
    return "\n".join(out) + "\n"


def convert_clash(lines: list[str]) -> str:
    out: list[str] = ["payload:"]
    ps = PendingSection()
    pending_blank = False

    for line in lines:
        stripped = line.strip()

        if is_blank(line):
            pending_blank = True
            continue
        if stripped.startswith("# >>"):
            ps.push_sub(f"  {stripped}")
            continue
        if stripped.startswith("# >"):
            ps.push_section(f"  {stripped}")
            continue
        if stripped.startswith("//"):
            pending_blank = _emit_with_prelude(out, f"  # {stripped[2:].strip()}", ps, pending_blank, head_guard=1)
            continue
        if STREAMING_PLACEHOLDER_RE.match(stripped):
            continue
        if stripped.startswith("#"):
            pending_blank = _emit_with_prelude(out, f"  {stripped}", ps, pending_blank, head_guard=1)
            continue

        body, inline = _split_inline_comment(stripped)
        parts = [p.strip() for p in body.split(",")]
        rule_type = parts[0] if parts else ""
        if rule_type in CLASH_SKIP:
            continue

        if rule_type == "AND":
            sub_rules = parse_and_rule(body) or []
            if any(st in CLASH_SKIP for st, sv in sub_rules):
                continue

        rule_line = f"  - {','.join(parts)}"
        if inline:
            rule_line = f"{rule_line}  # {inline}"

        pending_blank = _emit_with_prelude(out, rule_line, ps, pending_blank, head_guard=1)

    while out and not out[-1].strip():
        out.pop()
    return "\n".join(out) + "\n"


_SINGBOX_TYPE_ORDER = [
    "domain", "domain_suffix", "domain_keyword", "domain_regex",
    "ip_cidr", "process_name", "process_name_regex",
]


def _groups_to_singbox_rules(
    groups: dict[str, list[str]],
    logical_rules: list[dict] | None = None,
) -> list[dict]:
    """将 {sb_type: [values]} 分组 + logical_rules 列表转换为 sing-box rules 数组。"""
    rules: list[dict] = []
    for key in _SINGBOX_TYPE_ORDER:
        if key in groups:
            rules.append({key: sorted(set(groups[key]))})
    if logical_rules:
        rules.extend(logical_rules)
    return rules


def convert_qx_domainset(lines: list[str], policy: str) -> str:
    """DOMAIN-SET 文件 → QX filter（QX 无 domain-set 概念，展开为带类型的规则行）：
    `.foo` →（含自身与子域）DOMAIN-SUFFIX,foo,policy；裸域名 → DOMAIN,foo,policy。"""
    out: list[str] = []
    for line in lines:
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            out.append(s)
        elif s.startswith("."):
            out.append(f"DOMAIN-SUFFIX,{s[1:]},{policy}")
        else:
            out.append(f"DOMAIN,{s},{policy}")
    return "\n".join(out) + "\n"


def convert_clash_domainset(lines: list[str]) -> str:
    """DOMAIN-SET 文件 → Clash domain-behavior payload：`.foo` → '+.foo'，裸域名原样。"""
    out = ["payload:"]
    for line in lines:
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            out.append(f"  {s}")
        elif s.startswith("."):
            out.append(f"  - '+.{s[1:]}'")
        else:
            out.append(f"  - {s}")
    return "\n".join(out) + "\n"


def convert_domain_payload_to_singbox(text: str) -> str | None:
    """Clash domain-behavior payload → sing-box JSON（domain / domain_suffix）。"""
    groups: dict[str, list[str]] = {}
    for line in _iter_clash_payload_rules(text):
        if line.startswith("#") or line.startswith("//"):
            continue
        v = line.strip().strip("'\"")
        if not v:
            continue
        if v.startswith("+."):
            groups.setdefault("domain_suffix", []).append(v[2:])
        else:
            groups.setdefault("domain", []).append(v)
    if not groups:
        return None
    rules = _groups_to_singbox_rules(groups)
    return json.dumps({"version": 2, "rules": rules}, indent=2, ensure_ascii=False) + "\n"


def process_file(surge_file: Path, clash_override: set[str] | None = None,
                 domainset_stems: set[str] | None = None) -> int:
    text = surge_file.read_text(encoding="utf-8")
    lines = text.splitlines()
    stem = surge_file.stem                                           # 文件名，用作输出文件名及 QX policy
    rel  = str(surge_file.relative_to(SURGE_DIR).with_suffix(""))  # 含子目录，用于 clash_override 匹配
    updated = 0
    # sync-rules.txt # >> Clash 条目已由 Step 1 直接写入 Clash/sing-box，跳过自动转换
    skip_clash_singbox = clash_override is not None and rel in clash_override
    # sync-rules.txt # >> Surge Domain-Set 条目：镜像保持 DOMAIN-SET 原格式，按 domain 语义派生
    is_domainset = domainset_stems is not None and stem in domainset_stems

    # QX / Clash / sing-box 输出全部摊平（不保留子目录结构）
    qx_content = (convert_qx_domainset if is_domainset else convert_qx)(lines, stem)
    if write_if_changed(QX_DIR / f"{stem}.list", qx_content):
        print(f"    ✓ QX:      {stem}.list")
        updated += 1

    if not skip_clash_singbox:
        if is_domainset:
            # domain-behavior payload：纯域名，无 Clash 专属 preserve / CIDR 伴生可言
            clash_body = convert_clash_domainset(lines)
        else:
            # 读取现有 Clash YAML 中手动添加的 Clash 专属规则（PROCESS-NAME / PROCESS-NAME-REGEX）
            preserved = _extract_preserved_clash_rules(CLASH_DIR / f"{stem}.yaml")

            # Surge → Clash：只追加 Surge 源中没有的手动规则（末尾），防止重复
            clash_body = convert_clash(lines)
            if preserved:
                existing = {l.strip()[2:].strip() for l in clash_body.splitlines()
                            if l.strip().startswith("- ")}
                extra = [(t, v) for t, v in preserved if f"{t},{v}" not in existing]
                if extra:
                    lines_extra = "\n".join(f"  - {t},{v}" for t, v in extra)
                    clash_body = clash_body.rstrip("\n") + "\n" + lines_extra + "\n"
        if write_if_changed(CLASH_DIR / f"{stem}.yaml", clash_body):
            print(f"    ✓ Clash:   {stem}.yaml")
            updated += 1

        # Clash CIDR 伴生文件（如 LAN → lancidr.txt）：仅提取 IP-CIDR，输出 ipcidr payload
        companion = None if is_domainset else CLASH_CIDR_COMPANION.get(stem)
        if companion:
            cidr_body = convert_ipcidr_to_clash(text)
            if cidr_body and write_if_changed(CLASH_DIR / companion, cidr_body):
                print(f"    ✓ Clash:   {companion}")
                updated += 1

        # Clash → sing-box：从最终 Clash YAML 派生，保留规则自然包含在内
        sb_content = (convert_domain_payload_to_singbox if is_domainset
                      else convert_classical_payload_to_singbox)(clash_body)
        if sb_content:
            if write_if_changed(SINGBOX_DIR / f"{stem}.json", sb_content):
                print(f"    ✓ sing-box: {stem}.json")
                updated += 1

    return updated


def convert_all():
    """遍历 Surge/RULE-SET 所有 .list（含子目录），逐文件转换。"""
    print("\n── Step 4: Surge → QX / Clash / sing-box ──")

    # # >> Clash 条目优先级高于 Surge 自动转换（Clash/sing-box 已由 Step 1 写入）
    rules_txt = parse_sync_rules()
    clash_override = {e["name"] for e in rules_txt["clash"]}
    # # >> Surge Domain-Set 条目按 domain 语义派生（文件名 stem 匹配，与输出摊平规则一致）
    domainset_stems = {e["name"].rsplit("/", 1)[-1] for e in rules_txt["surge_domainset"]}

    surge_files = sorted(SURGE_DIR.rglob("*.list"))
    if not surge_files:
        print("  未找到 Surge 规则文件")
        return

    total = 0
    for sf in surge_files:
        rel = sf.relative_to(SURGE_DIR)
        print(f"  [{rel}]")
        total += process_file(sf, clash_override, domainset_stems)

    print(f"  更新 {total} 个文件")


# ═══════════════════════════════════════════════════════════════════════
#  Step 4: 清理已删除的文件
# ═══════════════════════════════════════════════════════════════════════

def cleanup_stale():
    """QX/Clash/sing-box 中存在但 Surge 中已无对应源的文件 → 删除。
    同时清理 Surge/RULE-SET/ 中以前由 # >> Surge 拉取、现已从 sync-rules.txt 移除的文件
    （通过 '### fork from' 首行识别为外部来源）。
    """
    print("\n── Step 5: 清理已删除的文件 ──")

    sync_rules = parse_sync_rules()
    # 当前 sync-rules.txt 管理的 stems（含 Domain-Set 段）
    surge_managed = {e["name"] for e in sync_rules["surge"] + sync_rules["surge_domainset"]}
    clash_managed = {e["name"] for e in sync_rules["clash"]}

    # 清理 Surge/RULE-SET/ 中不再被 # >> Surge 管理的外部拉取文件
    for sf in sorted(SURGE_DIR.rglob("*.list")):
        rel = str(sf.relative_to(SURGE_DIR).with_suffix(""))
        if rel in surge_managed:
            continue
        try:
            first_line = sf.read_text(encoding="utf-8").splitlines()[0].strip()
        except (IndexError, OSError):
            continue
        if first_line.startswith("### fork from "):
            sf.unlink()
            print(f"  ✗ 删除 {sf.relative_to(REPO_ROOT)}（已从 sync-rules.txt 移除）")

    # QX / Clash / sing-box：保留有 Surge 源（摊平，用 stem）或 # >> Clash 管理（保留路径）的文件
    surge_stems = {sf.stem for sf in SURGE_DIR.rglob("*.list")}
    keep = surge_stems | clash_managed

    deleted = 0
    for target_dir, ext in [(QX_DIR, ".list"), (CLASH_DIR, ".yaml"), (SINGBOX_DIR, ".json")]:
        if not target_dir.exists():
            continue
        for f in sorted(target_dir.rglob(f"*{ext}")):
            rel = str(f.relative_to(target_dir).with_suffix(""))
            if rel not in keep:
                f.unlink()
                print(f"  ✗ 删除 {f.relative_to(REPO_ROOT)}")
                deleted += 1

    if not deleted:
        print("  无需清理")


# ═══════════════════════════════════════════════════════════════════════
#  Step 1: sync-rules.txt 外部规则拉取
# ═══════════════════════════════════════════════════════════════════════

def parse_sync_rules() -> dict:
    """解析 sync-rules.txt，返回 {"surge": [...], "surge_domainset": [...], "clash": [...], "module": [...]}，
    条目均为 {url, name, overrides}。# >> Surge 段内以 `DOMAIN-SET,` 前缀标注的条目
    为 DOMAIN-SET 格式来源（裸域名 / `.` 前缀域名），落库保持原格式、
    Step 4 按各平台原生 domain 语义派生；无前缀条目为 RULE-SET 格式来源。"""
    result: dict[str, list[dict]] = {"surge": [], "surge_domainset": [], "clash": [], "module": []}
    if not SYNC_RULES_TXT.exists():
        return result
    section = None
    for line in SYNC_RULES_TXT.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s == "# >> Surge":
            section = "surge"
        elif s == "# >> Clash":
            section = "clash"
        elif s == "# >> Module":
            section = "module"
        elif section and s and not s.startswith("#") and "," in s:
            is_domainset = False
            if section in ("surge", "clash") and s.upper().startswith("DOMAIN-SET,"):
                is_domainset, s = True, s[len("DOMAIN-SET,"):].strip()
            section_key = "surge_domainset" if (section == "surge" and is_domainset) else section
            url, rest = s.split(",", 1)
            # rest = "name" 或 "name #!key=value #!key=value ..."（空格+#! 分隔）
            parts = rest.split(" #!")
            name = parts[0].strip()
            overrides = {}
            for part in parts[1:]:
                if "=" in part:
                    k, v = part.split("=", 1)
                    overrides[k.strip()] = v.strip()
            entry = {"url": url.strip(), "name": name, "overrides": overrides}
            if section == "clash":
                entry["domainset"] = is_domainset
            result[section_key].append(entry)
    return result


def _is_clash_payload(text: str) -> bool:
    """检测文本是否为 Clash payload: 格式（前 10 行内含 'payload:'）。"""
    for line in text.splitlines()[:10]:
        if line.strip() == "payload:":
            return True
    return False


def normalize_surge_rules(text: str) -> str | None:
    """规范化 Surge 规则文本为项目风格。
    保留 '# > Section' header，剥掉其他来源注释，输出干净规则行。
    """
    out = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("//"):
            out.append(f"# {stripped[2:].strip()}")
            continue
        if stripped.startswith("#"):
            # 仅保留 '# > Name' section header（排除 '# >>' 配置标记）
            if re.match(r"^#\s*>(?!>)\s*\S", stripped):
                out.append(stripped)
            continue
        out.append(stripped)
    return ("\n".join(out) + "\n") if out else None


def _extract_preserved_clash_rules(path: Path) -> list[tuple[str, str]]:
    """从已有 Clash YAML 中提取 CLASH_PRESERVE_TYPES 规则，返回 [(rule_type, value), ...]。
    用于在 Surge 自动转换覆盖 Clash 文件前保留手动添加的 Clash 专属规则。
    """
    if not path.exists():
        return []
    result = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped.startswith("- "):
            continue
        rule = stripped[2:].strip()
        parts = rule.split(",", 1)
        if len(parts) == 2 and parts[0].strip() in CLASH_PRESERVE_TYPES:
            result.append((parts[0].strip(), parts[1].strip()))
    return result


def _iter_clash_payload_rules(text: str):
    """从 Clash payload: 文本中逐行 yield 规则字符串（去掉 '  - ' 前缀和引号）。"""
    in_payload = False
    for raw in text.splitlines():
        stripped = raw.strip()
        if stripped == "payload:":
            in_payload = True
            continue
        if not in_payload:
            continue
        if stripped.startswith("- "):
            rule = stripped[2:].strip().strip("'\"")
            if rule and not rule.startswith("#"):
                yield rule


def normalize_clash_payload(text: str) -> str | None:
    """规范化 Clash payload 格式：提取规则行，剥掉内嵌元数据注释，重新格式化输出。"""
    rules = list(_iter_clash_payload_rules(text))
    if not rules:
        return None
    out = ["payload:"] + [f"  - {r}" for r in rules]
    return "\n".join(out) + "\n"


def _clash_body_rules(text: str) -> list[str]:
    """将原始下载文本转换为规则字符串列表（去掉 '  - ' 前缀），供同名条目合并使用。"""
    if _is_clash_payload(text):
        body = normalize_clash_payload(text) or ""
    else:
        body = convert_clash(text.splitlines())
    rules = []
    for line in body.splitlines():
        s = line.strip()
        if s.startswith("- "):
            rules.append(s[2:].strip())
    return rules


def convert_clash_payload_to_surge(text: str) -> str | None:
    """Clash classical payload: → Surge RULE-SET .list 格式（仅规则行，无注释）。"""
    out = list(_iter_clash_payload_rules(text))
    return ("\n".join(out) + "\n") if out else None


# ── ipcidr behavior ──────────────────────────────────────────────────

def _extract_cidrs(text: str) -> list[str]:
    """从 Surge RULE-SET 或纯 CIDR 列表中提取 IP CIDR 字符串。"""
    cidrs = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("//"):
            continue
        parts = [p.strip() for p in line.split(",")]
        if parts[0].upper() in ("IP-CIDR", "IP-CIDR6", "IP6-CIDR") and len(parts) > 1:
            cidrs.append(parts[1])
        elif "/" in line and "," not in line:
            # 纯 CIDR 行（无规则类型前缀）
            cidrs.append(line)
    return cidrs


def convert_ipcidr_to_clash(text: str) -> str | None:
    """Surge IP-CIDR 规则列表 → Clash ipcidr YAML。"""
    cidrs = _extract_cidrs(text)
    if not cidrs:
        return None
    out = ["payload:"]
    for c in sorted(set(cidrs)):
        out.append(f"  - '{c}'")
    return "\n".join(out) + "\n"


# ── classical behavior ───────────────────────────────────────────────

def convert_classical_payload_to_singbox(text: str) -> str | None:
    """Clash classical payload: → sing-box JSON（外部规则已是 Clash 格式时使用）。"""
    groups: dict[str, list[str]] = {}
    logical_rules: list[dict] = []
    for line in _iter_clash_payload_rules(text):
        if line.startswith("#") or line.startswith("//"):
            continue
        # 剥掉 YAML 行内注释（`  # ...`），避免 "domain  # comment" 混入值
        hash_idx = line.find("#")
        if hash_idx > 0:
            line = line[:hash_idx].rstrip().rstrip(",")
        line = line.strip()

        if line.startswith("AND,"):
            # 逻辑规则 → sing-box type:logical/mode:and（version 2 起即支持）。
            # 所有子条件均为 sing-box 支持的类型才转换；含 USER-AGENT 等不支持
            # 子类型则整条跳过（与 Clash preserve / QX 的处理一致）。
            sub = parse_and_rule(line)
            if not sub:
                continue
            sb_sub = [{SINGBOX_MAP[t]: [v]} for t, v in sub if t in SINGBOX_MAP]
            if sb_sub and len(sb_sub) == len(sub):
                logical_rules.append({"type": "logical", "mode": "and", "rules": sb_sub})
            continue

        parts = [p.strip() for p in line.split(",")]
        sb_type = SINGBOX_MAP.get(parts[0])
        if sb_type and len(parts) > 1:
            groups.setdefault(sb_type, []).append(parts[1])

    if not groups and not logical_rules:
        return None

    rules = _groups_to_singbox_rules(groups, logical_rules)
    return (json.dumps({"version": 2, "rules": rules}, indent=2, ensure_ascii=False) + "\n"
            if rules else None)


def fetch_external_rules():
    """拉取 sync-rules.txt 外部规则。

    # >> Surge  → Surge/RULE-SET/<name>.list（首行加 fork header，Step 4 正常转换）
    # >> Clash  → Clash/RuleSet/<name>.yaml + sing-box/source/<name>.json（直接写入，
                  Step 4 对同名 Surge 文件跳过 Clash/sing-box 输出）
    """
    print("\n── Step 1: 拉取外部规则 ──")
    rules = parse_sync_rules()

    if not rules["surge"] and not rules["surge_domainset"] and not rules["clash"]:
        print("  sync-rules.txt 无规则条目")
        return

    # 预先并发拉取所有 URL（去重后并发，避免同 URL 重复下载）
    all_urls = list({e["url"] for e in rules["surge"] + rules["surge_domainset"] + rules["clash"]})
    if all_urls:
        print(f"  并发下载 {len(all_urls)} 个 URL …")
    prefetched = prefetch_urls(all_urls, _UA) if all_urls else {}

    # ── # >> Surge / # >> Surge Domain-Set section（同名多 URL 合并去重）──
    surge_groups: dict[str, list[str]] = defaultdict(list)
    for e in rules["surge"] + rules["surge_domainset"]:
        surge_groups[e["name"]].append(e["url"])
    domainset_names = {e["name"] for e in rules["surge_domainset"]}

    for name, urls in surge_groups.items():
        fork_urls: list[str] = []
        rule_lines: list[str] = []
        seen_rules: set[str] = set()
        section_names: list[str] = []  # 各来源的 # > Name，最终拼成 A & B

        for url in urls:
            print(f"  [Surge] {name} ← {url}")
            text = prefetched.get(url)
            if text is None:
                continue
            if name not in domainset_names and _is_clash_payload(text):
                text = convert_clash_payload_to_surge(text)
                if text is None:
                    print(f"    [WARN] {name} Clash→Surge 转换为空，跳过")
                    continue
            normalized = normalize_surge_rules(text)
            if not normalized:
                continue
            fork_urls.append(url)
            for line in normalized.splitlines():
                if re.match(r"^#\s*>(?!>)\s*\S", line):
                    display = re.sub(r"^#\s*>\s*", "", line).strip()
                    if display not in section_names:
                        section_names.append(display)
                elif line not in seen_rules:
                    seen_rules.add(line)
                    rule_lines.append(line)

        if not rule_lines:
            print(f"    [WARN] {name} 全部来源为空，跳过")
            _mark_upstream_deleted(SURGE_DIR / f"{name}.list")
            continue
        header = " & ".join(section_names) if section_names else name.rsplit("/", 1)[-1]
        rule_lines.insert(0, f"# > {header}")

        content = "### fork from " + " & ".join(fork_urls) + "\n" + "\n".join(rule_lines) + "\n"
        if write_if_changed(SURGE_DIR / f"{name}.list", content):
            print(f"    ✓ Surge/RULE-SET/{name}.list")
        else:
            print(f"    ✓ {name}.list 无变化")

    # ── # >> Clash section（同名多 URL 合并去重）──────────────────────
    clash_groups: dict[str, list[str]] = defaultdict(list)
    clash_domainset_names = {e["name"] for e in rules["clash"] if e.get("domainset")}
    for e in rules["clash"]:
        clash_groups[e["name"]].append(e["url"])

    for name, urls in clash_groups.items():
        fork_urls = []
        all_rules: list[str] = []
        seen_rules = set()

        for url in urls:
            print(f"  [Clash] {name} ← {url}")
            text = prefetched.get(url)
            if text is None:
                continue
            fork_urls.append(url)
            for rule in _clash_body_rules(text):
                if rule not in seen_rules:
                    seen_rules.add(rule)
                    all_rules.append(rule)

        if not all_rules:
            print(f"    [WARN] {name} Clash 转换为空，跳过")
            continue

        body = "payload:\n" + "\n".join(f"  - {r}" for r in all_rules) + "\n"
        clash_content = "### fork from " + " & ".join(fork_urls) + "\n" + body
        if write_if_changed(CLASH_DIR / f"{name}.yaml", clash_content):
            print(f"    ✓ Clash:    {name}.yaml")
        else:
            print(f"    ✓ Clash:    {name}.yaml 无变化")

        # DOMAIN-SET, 前缀条目为 domain payload（裸域名 / +. 前缀），按 domain 语义转换
        sb_convert = (convert_domain_payload_to_singbox if name in clash_domainset_names
                      else convert_classical_payload_to_singbox)
        sb_content = sb_convert(body)
        if sb_content:
            if write_if_changed(SINGBOX_DIR / f"{name}.json", sb_content):
                print(f"    ✓ sing-box: {name}.json")
            else:
                print(f"    ✓ sing-box: {name}.json 无变化")
        else:
            print(f"    [WARN] {name} sing-box 转换为空，跳过")


# ═══════════════════════════════════════════════════════════════════════
#  Main
def fetch_external_modules():
    """拉取 sync-rules.txt # >> Module 节，写入 Surge/Module/<name>.sgmodule。"""
    print("\n── Step 1b: 拉取外部 sgmodule ──")
    rules = parse_sync_rules()
    entries = rules.get("module", [])
    if not entries:
        print("  sync-rules.txt 无 Module 条目")
        return

    module_dir = REPO_ROOT / "Surge" / "Module"
    module_dir.mkdir(parents=True, exist_ok=True)

    module_urls = [e["url"] for e in entries]
    prefetched = prefetch_urls(module_urls, _UA, encode=True)

    for e in entries:
        orig_url, name = e["url"], e["name"]
        overrides: dict = e["overrides"]
        text = prefetched.get(orig_url)
        if text is None:
            _mark_upstream_deleted(module_dir / f"{name}.sgmodule")
            continue
        out = module_dir / f"{name}.sgmodule"
        lines = text.splitlines()
        # 应用 overrides：替换匹配的 #!key= 行
        if overrides:
            key_positions: dict[str, int] = {}  # override key → 在 new_lines 中的行号
            new_lines = []
            for line in lines:
                if line.startswith("#!") and "=" in line:
                    key = line[2:].split("=", 1)[0]
                    if key in overrides:
                        key_positions[key] = len(new_lines)
                        new_lines.append(f"#!{key}={overrides[key]}")
                        continue
                new_lines.append(line)
            # 缺失的 override 键：按 override 列表顺序，插到前一个已放置 key 的正下方
            override_keys = list(overrides.keys())
            for i, key in enumerate(override_keys):
                if key in key_positions:
                    continue
                val = overrides[key]
                # 找前面最近的已放置 override key
                predecessor_pos = None
                for prev_key in reversed(override_keys[:i]):
                    if prev_key in key_positions:
                        predecessor_pos = key_positions[prev_key]
                        break
                if predecessor_pos is not None:
                    insert_at = predecessor_pos + 1
                else:
                    # 无前驱，插到第一个 [Section] 之前
                    insert_at = next(
                        (j for j, l in enumerate(new_lines) if re.match(r"^\[.+\]$", l.strip())),
                        len(new_lines),
                    )
                new_lines.insert(insert_at, f"#!{key}={val}")
                # 插入后，更新所有受影响的行号
                for k in key_positions:
                    if key_positions[k] >= insert_at:
                        key_positions[k] += 1
                key_positions[key] = insert_at
            lines = new_lines
        last_meta = max((i for i, l in enumerate(lines) if l.startswith("#!")), default=-1)
        if last_meta >= 0:
            lines[last_meta + 1:last_meta + 1] = ["", f"### fork from {orig_url}"]
        else:
            lines.insert(0, f"### fork from {orig_url}")
        content = "\n".join(lines) + "\n"
        if write_if_changed(out, content):
            print(f"  ✓ {name}.sgmodule 已更新")
        else:
            print(f"  · {name}.sgmodule 无变化")


# ═══════════════════════════════════════════════════════════════════════

def main():
    print("=" * 60)
    print("  Rules 同步脚本")
    print("=" * 60)

    # Step 1: 拉取外部规则（Surge 文件 + Clash 直转）
    fetch_external_rules()

    # Step 1b: 拉取外部 sgmodule
    fetch_external_modules()

    # Step 2/3: Streaming 三层双向同步
    sync_streaming()

    # Step 4: Surge → QX / Clash / sing-box
    convert_all()

    # Step 5: 清理
    cleanup_stale()

    print(f"\n{'=' * 60}")
    print("  完成")
    print("=" * 60)


if __name__ == "__main__":
    main()
