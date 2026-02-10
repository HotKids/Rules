#!/usr/bin/env python3
"""
Surge RULE-SET → Quantumult X / Clash (mihomo) / sing-box 格式同步脚本

以 Surge/RULE-SET 为唯一来源，自动转换生成：
  - Quantumult/X/Filter/*.list   (Surge 兼容格式 + 策略名)
  - Clash/RuleSet/*.yaml          (mihomo classical payload)
  - sing-box/source/*.json        (headless rule-set v2)
"""

import json
import re
import sys
from pathlib import Path

# ─── 目录配置 ─────────────────────────────────────────────────────────
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SURGE_DIR = REPO_ROOT / "Surge" / "RULE-SET"
QX_DIR = REPO_ROOT / "Quantumult" / "X" / "Filter"
CLASH_DIR = REPO_ROOT / "Clash" / "RuleSet"
SINGBOX_DIR = REPO_ROOT / "sing-box" / "source"

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


# ═══════════════════════════════════════════════════════════════════════
#  解析
# ═══════════════════════════════════════════════════════════════════════

def read_lines(filepath: Path) -> list[str]:
    """读取文件行，保留原始内容。"""
    return filepath.read_text(encoding="utf-8").splitlines()


def is_comment(line: str) -> bool:
    """判断是否为注释行（# 或 //）。"""
    s = line.strip()
    return s.startswith("#") or s.startswith("//")


def is_blank(line: str) -> bool:
    return not line.strip()


def parse_and_rule(raw: str):
    """
    解析 AND,((TYPE1,VAL1), (TYPE2,VAL2)) 格式的复合规则。
    返回子规则列表 [(type, value), ...]，失败返回 None。
    """
    m = re.match(r"AND,\(\((.+)\)\)$", raw.strip())
    if not m:
        return None
    inner = m.group(1)
    # 按 "), (" 拆分
    parts = re.split(r"\),\s*\(", inner)
    sub_rules = []
    for p in parts:
        p = p.strip().strip("()")
        pieces = p.split(",", 1)
        if len(pieces) == 2:
            sub_rules.append((pieces[0].strip(), pieces[1].strip()))
    return sub_rules if sub_rules else None


def wildcard_to_regex(pattern: str) -> str:
    """将 DOMAIN-WILDCARD 的通配符转为正则表达式。"""
    # 转义特殊字符，再替换通配符
    escaped = re.escape(pattern)
    escaped = escaped.replace(r"\*", ".*").replace(r"\?", ".")
    return f"^{escaped}$"


# ═══════════════════════════════════════════════════════════════════════
#  Quantumult X 转换
# ═══════════════════════════════════════════════════════════════════════

def convert_qx(lines: list[str], policy: str) -> str:
    """Surge → Quantumult X (Surge 兼容格式 + 策略名)。"""
    out = []
    for line in lines:
        stripped = line.strip()

        if is_blank(line):
            out.append("")
            continue

        # 保留 # 注释，跳过 // 注释
        if stripped.startswith("#"):
            out.append(stripped)
            continue
        if stripped.startswith("//"):
            continue

        parts = [p.strip() for p in stripped.split(",")]
        rule_type = parts[0] if parts else ""

        # 跳过不支持的类型
        if rule_type in QX_SKIP:
            continue

        value = parts[1] if len(parts) > 1 else ""

        # IP 规则：去掉 no-resolve，附加策略名
        if rule_type in ("IP-CIDR", "IP-CIDR6", "IP6-CIDR", "GEOIP", "IP-ASN"):
            out.append(f"{rule_type},{value},{policy}")
        elif rule_type in ("DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD"):
            out.append(f"{rule_type},{value},{policy}")
        else:
            # 未知类型原样保留 + 策略名
            if value:
                out.append(f"{rule_type},{value},{policy}")

    # 去掉末尾多余空行
    while out and not out[-1].strip():
        out.pop()
    return "\n".join(out) + "\n"


# ═══════════════════════════════════════════════════════════════════════
#  Clash / mihomo 转换
# ═══════════════════════════════════════════════════════════════════════

def convert_clash(lines: list[str]) -> str:
    """Surge → Clash/mihomo (classical YAML payload)。"""
    out = ["payload:"]
    for line in lines:
        stripped = line.strip()

        if is_blank(line):
            continue

        # # 注释 → 缩进保留
        if stripped.startswith("#"):
            out.append(f"  {stripped}")
            continue
        # // 注释 → 跳过
        if stripped.startswith("//"):
            continue

        parts = [p.strip() for p in stripped.split(",")]
        rule_type = parts[0] if parts else ""

        # 跳过不支持的类型
        if rule_type in CLASH_SKIP:
            continue

        # 原样拼接（mihomo 支持 AND、DOMAIN-WILDCARD 等）
        # 去掉每个 part 的多余空格
        rule_line = ",".join(parts)
        out.append(f"  - {rule_line}")

    return "\n".join(out) + "\n"


# ═══════════════════════════════════════════════════════════════════════
#  sing-box 转换
# ═══════════════════════════════════════════════════════════════════════

def convert_singbox(lines: list[str]) -> str | None:
    """Surge → sing-box rule-set (JSON v2)。"""
    groups: dict[str, list[str]] = {}
    logical_rules: list[dict] = []

    for line in lines:
        stripped = line.strip()
        if is_blank(line) or is_comment(line):
            continue

        parts = [p.strip() for p in stripped.split(",")]
        rule_type = parts[0]

        # AND 复合规则
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

        # DOMAIN-WILDCARD → domain_regex
        if rule_type == "DOMAIN-WILDCARD" and len(parts) > 1:
            groups.setdefault("domain_regex", []).append(
                wildcard_to_regex(parts[1])
            )
            continue

        # 常规规则
        sb_type = SINGBOX_MAP.get(rule_type)
        if not sb_type:
            continue
        value = parts[1] if len(parts) > 1 else ""
        if value:
            groups.setdefault(sb_type, []).append(value)

    if not groups and not logical_rules:
        return None

    # 构建 rules 数组：每种类型一个对象（同类 OR，异类在不同对象间 OR）
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


# ═══════════════════════════════════════════════════════════════════════
#  文件处理
# ═══════════════════════════════════════════════════════════════════════

def write_if_changed(filepath: Path, content: str) -> bool:
    """仅在内容有变化时写入。"""
    filepath.parent.mkdir(parents=True, exist_ok=True)
    if filepath.exists():
        existing = filepath.read_text(encoding="utf-8")
        if existing == content:
            return False
    filepath.write_text(content, encoding="utf-8")
    return True


def process_file(surge_file: Path) -> int:
    """处理单个 Surge 规则文件，返回更新的文件数。"""
    lines = read_lines(surge_file)
    stem = surge_file.stem
    updated = 0

    # Quantumult X
    qx_content = convert_qx(lines, stem)
    if write_if_changed(QX_DIR / f"{stem}.list", qx_content):
        print(f"    ✓ QX:      {stem}.list")
        updated += 1

    # Clash / mihomo
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


def main():
    print("=" * 60)
    print("  Surge RULE-SET → QX / Clash / sing-box 同步")
    print("=" * 60)

    # 收集所有 .list 文件（含子目录）
    surge_files = sorted(SURGE_DIR.rglob("*.list"))
    if not surge_files:
        print("未找到 Surge 规则文件")
        sys.exit(1)

    print(f"\n源文件: {len(surge_files)} 个\n")

    total_updated = 0
    for sf in surge_files:
        rel = sf.relative_to(SURGE_DIR)
        print(f"  [{rel}]")
        total_updated += process_file(sf)

    print(f"\n{'=' * 60}")
    if total_updated:
        print(f"  完成: 更新了 {total_updated} 个文件")
    else:
        print("  完成: 所有文件已是最新，无需更新")
    print("=" * 60)


if __name__ == "__main__":
    main()
