#!/usr/bin/env python3
"""
Surge Profile.conf → Clash Sample.yaml 同步脚本

从 Surge/Profile.conf 和 Clash/General.yaml 生成 Clash/Sample.yaml：
  1. Clash/General.yaml 头部内容（proxies: 之前）
  2. proxies（仅内置，通常为空）
  3. proxy-providers（固定 Server 订阅块）
  4. proxy-groups（从 [Proxy Group] 转换，支持 group block 覆盖和 skip）
  5. rule-providers + rules（从 [Rule] 转换，支持 URL 映射和 skip）

映射规则见 scripts/sync-config.txt。
"""

import re
import sys
from collections import OrderedDict
from pathlib import Path

# ─── 路径配置 ─────────────────────────────────────────────────────────────────
REPO_ROOT       = Path(__file__).resolve().parent.parent
SURGE_PROFILE   = REPO_ROOT / "Surge" / "Profile.conf"
CLASH_GENERAL   = REPO_ROOT / "Clash" / "General.yaml"
CLASH_SAMPLE    = REPO_ROOT / "Clash" / "Sample.yaml"
SYNC_CONFIG_TXT = REPO_ROOT / "scripts" / "sync-config.txt"

# ─── HotKids 自动路径映射 ────────────────────────────────────────────────────
HOTKIDS_SURGE_PREFIX = "https://raw.githubusercontent.com/HotKids/Rules/master/Surge/RULE-SET/"
HOTKIDS_CLASH_PREFIX = "https://raw.githubusercontent.com/HotKids/Rules/master/Clash/RuleSet/"

# ─── Clash 不支持的 Surge 规则类型 ───────────────────────────────────────────
CLASH_UNSUPPORTED_RULE_TYPES = {"PROTOCOL", "URL-REGEX", "USER-AGENT"}

# ─── 固定 proxy-providers 块（Server 订阅） ───────────────────────────────────
PROXY_PROVIDERS_BLOCK = """\
# 服务器订阅配置
proxy-providers:
  Server:
    type: http
    path: ./Provider/Proxy/Server.yaml
    url: https://sub.hotkids.me
    interval: 3600
    proxy: DIRECT
    header:
      User-Agent:
      - "Clash/v1.18.0"
      - "mihomo/1.18.3"
    health-check:
      enable: true
      url: https://cp.cloudflare.com/generate_204
      interval: 600\
"""


# ══════════════════════════════════════════════════════════════════════════════
#  通用工具
# ══════════════════════════════════════════════════════════════════════════════

def write_if_changed(filepath: Path, content: str) -> bool:
    filepath.parent.mkdir(parents=True, exist_ok=True)
    if filepath.exists() and filepath.read_text(encoding="utf-8") == content:
        return False
    filepath.write_text(content, encoding="utf-8")
    return True


def strip_emoji(name: str) -> str:
    """去除字符串开头的 emoji 及空白，返回剩余文字部分。
    例：'🇺🇳 Server' → 'Server'
    """
    # 去除开头的 emoji（Unicode 范围涵盖旗帜、符号、表情等）
    result = name.lstrip()
    while result:
        cp = ord(result[0])
        # 国旗 emoji（区域指示符，如 🇭🇰）由两个码点组成（U+1F1E0-U+1F1FF）
        # 常规 emoji 范围：U+2000+ / U+1F000+
        if (0x1F000 <= cp <= 0x1FFFF or    # 杂项符号和象形文字
                0x2600 <= cp <= 0x27BF or   # 杂项符号
                0xFE00 <= cp <= 0xFE0F or   # 变体选择符
                0x1F1E0 <= cp <= 0x1F1FF):  # 区域指示符（旗帜）
            # 跳过当前字符（可能是多字节）
            result = result[1:].lstrip()
        else:
            break
    return result.strip()


# ══════════════════════════════════════════════════════════════════════════════
#  解析 sync-config.txt
# ══════════════════════════════════════════════════════════════════════════════

def parse_sync_txt() -> tuple[list[tuple[str, str]], list[str], dict[str, str], dict[str, str]]:
    """解析 sync-config.txt，返回：
    - url_maps:     [(surge_side, clash_side), ...]  # 按出现顺序
    - skips:        [keyword, ...]
    - group_blocks: {name: yaml_text}               # 保留声明顺序
    - builtin_maps: {name: clash_url}               # 内置规则集（非 http URL）
    """
    url_maps: list[tuple[str, str]] = []
    skips: list[str] = []
    group_blocks: dict[str, str] = {}
    builtin_maps: dict[str, str] = {}

    if not SYNC_CONFIG_TXT.exists():
        return url_maps, skips, group_blocks, builtin_maps

    lines = SYNC_CONFIG_TXT.read_text(encoding="utf-8").splitlines()
    i = 0
    while i < len(lines):
        raw = lines[i]
        stripped = raw.strip()
        i += 1

        # 空行 / 注释
        if not stripped or stripped.startswith("#"):
            continue

        # group => <name> ... end
        if stripped.startswith("group =>"):
            name = stripped[len("group =>"):].strip()
            block_lines: list[str] = []
            while i < len(lines):
                line = lines[i]
                i += 1
                if line.strip() == "end":
                    break
                block_lines.append(line)
            group_blocks[name] = "\n".join(block_lines)
            continue

        # skip => <keyword>
        if stripped.startswith("skip =>"):
            kw = stripped[len("skip =>"):].strip()
            if kw:
                skips.append(kw)
            continue

        # X => Y
        if "=>" in stripped:
            left, _, right = stripped.partition("=>")
            left = left.strip()
            right = right.strip()
            if not left or not right:
                continue
            # 判断是否是内置规则集（左边非 http URL 且不含 /）
            # 内置：如 "LAN"；URL 映射：包含 http 或 /
            if not left.startswith("http") and "/" not in left:
                builtin_maps[left] = right
            else:
                url_maps.append((left, right))
            continue

    return url_maps, skips, group_blocks, builtin_maps


# ══════════════════════════════════════════════════════════════════════════════
#  URL 映射
# ══════════════════════════════════════════════════════════════════════════════

RAW_PREFIX = "https://raw.githubusercontent.com/"


def _expand_shorthand(s: str) -> str:
    """如果不是完整 URL，则补全为 raw.githubusercontent.com 前缀。"""
    if s.startswith("http"):
        return s
    return RAW_PREFIX + s.rstrip("/") + "/"


def map_surge_url(url: str, url_maps: list[tuple[str, str]]) -> str | None:
    """将 Surge 规则 URL 转换为 Clash URL。
    优先级：
    1. HotKids 自动映射
    2. 完整 URL 精确匹配
    3. 最长前缀匹配
    4. 仓库简写（非 http 左侧）匹配
    返回 None 表示无法映射。
    """
    # 1. HotKids 自动映射
    if HOTKIDS_SURGE_PREFIX in url:
        rest = url[url.index(HOTKIDS_SURGE_PREFIX) + len(HOTKIDS_SURGE_PREFIX):]
        # 处理 URL 编码（如 Apple%20TV.list → Apple TV.yaml）
        rest = rest.replace("%20", " ")
        if rest.endswith(".list"):
            rest = rest[:-5] + ".yaml"
        return HOTKIDS_CLASH_PREFIX + rest

    # 2 & 3. 精确 URL 或前缀匹配
    best_prefix_len = 0
    best_result: str | None = None

    for left, right in url_maps:
        if not left.startswith("http"):
            continue  # 仓库简写，留给后续处理
        if url == left:
            # 精确匹配
            return right
        if url.startswith(left):
            if len(left) > best_prefix_len:
                best_prefix_len = len(left)
                suffix = url[len(left):]
                best_result = right.rstrip("/") + "/" + suffix

    if best_result:
        return best_result

    # 4. 仓库简写：左边形如 owner/repo/branch，右边同形式
    for left, right in url_maps:
        if left.startswith("http"):
            continue
        surge_prefix = _expand_shorthand(left)
        if url.startswith(surge_prefix):
            suffix = url[len(surge_prefix):]
            return _expand_shorthand(right) + suffix

    return None


# ══════════════════════════════════════════════════════════════════════════════
#  解析 Surge Profile.conf
# ══════════════════════════════════════════════════════════════════════════════

def parse_surge_profile() -> tuple[list[str], list[str], list[str]]:
    """读取 Surge/Profile.conf，返回三个 section 的有效行列表：
    proxy_lines, group_lines, rule_lines
    """
    text = SURGE_PROFILE.read_text(encoding="utf-8")
    sections: dict[str, list[str]] = {}
    current: str | None = None

    for line in text.splitlines():
        m = re.match(r"^\[(.+)\]$", line.strip())
        if m:
            current = m.group(1)
            sections[current] = []
            continue
        if current is not None:
            sections[current].append(line)

    def clean(lines: list[str]) -> list[str]:
        out = []
        for line in lines:
            s = line.strip()
            if not s:
                continue
            if s.startswith("//") or s.startswith("#"):
                continue
            out.append(s)
        return out

    proxy_lines = clean(sections.get("Proxy", []))
    group_lines = clean(sections.get("Proxy Group", []))
    rule_lines  = clean(sections.get("Rule", []))
    return proxy_lines, group_lines, rule_lines


# ══════════════════════════════════════════════════════════════════════════════
#  生成 proxies
# ══════════════════════════════════════════════════════════════════════════════

def gen_proxies(proxy_lines: list[str]) -> str:
    """生成 proxies 段落。当前 Profile.conf 只有内置 DIRECT/REJECT，输出空列表。"""
    real_proxies = []
    for line in proxy_lines:
        if "=" not in line:
            continue
        _, _, val = line.partition("=")
        val = val.strip().lower()
        if val in ("direct", "reject"):
            continue
        real_proxies.append(line)

    if not real_proxies:
        return "# 本地节点配置（订阅为空）\nproxies: []"
    # 如有真实节点，原样保留（未来扩展点）
    lines = ["proxies:"]
    for p in real_proxies:
        lines.append(f"  - {p}")
    return "\n".join(lines)


# ══════════════════════════════════════════════════════════════════════════════
#  解析 Proxy Group 行
# ══════════════════════════════════════════════════════════════════════════════

def parse_group_line(line: str) -> dict | None:
    """解析一行 Surge Proxy Group 定义。
    格式：GroupName = type,proxy1,proxy2,...,key=val,...
    返回 {name, type, proxies, params} 或 None（解析失败）。
    """
    if "=" not in line:
        return None
    name, _, rest = line.partition(" = ")
    if not _:
        # 可能是 'name= ...' 无空格情况
        name, _, rest = line.partition("=")
        if not _:
            return None
    name = name.strip()
    rest = rest.strip()

    tokens = [t.strip() for t in rest.split(",")]
    if not tokens:
        return None

    group_type = tokens[0].strip().lower()
    params: dict[str, str] = {}
    proxies: list[str] = []

    for tok in tokens[1:]:
        tok = tok.strip()
        if not tok:
            continue
        if "=" in tok:
            k, _, v = tok.partition("=")
            params[k.strip()] = v.strip()
        else:
            proxies.append(tok)

    return {"name": name, "type": group_type, "proxies": proxies, "params": params}


# ══════════════════════════════════════════════════════════════════════════════
#  生成 proxy-groups
# ══════════════════════════════════════════════════════════════════════════════

def _is_skipped(name: str, skips: list[str]) -> bool:
    return any(kw in name for kw in skips)


def _fmt_group_select(name: str, params: dict[str, str], proxies: list[str]) -> list[str]:
    """生成 select 类型 proxy-group 的 YAML 行列表。"""
    lines = [f'  - name: "{name}"', "    type: select"]

    icon = params.get("icon-url", "")
    if icon:
        lines.append(f"    icon: {icon}")

    # include-all-proxies=true → use: [Server]
    if params.get("include-all-proxies", "").lower() in ("true", "1"):
        lines.append("    use:")
        lines.append("      - Server")
        return lines

    # include-other-group=X → use: [strip_emoji(X)]
    other_group = params.get("include-other-group", "")
    if other_group:
        provider = strip_emoji(other_group)
        lines.append("    use:")
        lines.append(f"      - {provider}")
        return lines

    # policy-regex-filter → filter（select 也可能有）
    regex_filter = params.get("policy-regex-filter", "")
    if regex_filter:
        lines.append(f"    filter: '{regex_filter}'")

    # proxies 列表
    if proxies:
        lines.append("    proxies:")
        for p in proxies:
            lines.append(f"      - {p}")

    return lines


def _fmt_group_smart(name: str, params: dict[str, str]) -> list[str]:
    """将 smart 类型转换为带 use/filter/icon 的 select。"""
    lines = [f'  - name: "{name}"', "    type: select"]

    icon = params.get("icon-url", "")
    if icon:
        lines.append(f"    icon: {icon}")

    other_group = params.get("include-other-group", "")
    if other_group:
        provider = strip_emoji(other_group)
        lines.append("    use:")
        lines.append(f"      - {provider}")

    regex_filter = params.get("policy-regex-filter", "")
    if regex_filter:
        lines.append(f"    filter: '{regex_filter}'")

    hidden = params.get("hidden", "0")
    if hidden in ("1", "true"):
        lines.append("    hidden: true")

    return lines


def gen_proxy_groups(
    group_lines: list[str],
    skips: list[str],
    group_blocks: dict[str, str],
) -> str:
    """生成 proxy-groups 段落。"""
    out_lines = ["proxy-groups:"]
    used_blocks: set[str] = set()

    for line in group_lines:
        g = parse_group_line(line)
        if g is None:
            continue
        name = g["name"]

        # 1. group block 优先
        if name in group_blocks:
            out_lines.append(group_blocks[name])
            out_lines.append("")  # 组间空行
            used_blocks.add(name)
            continue

        # 2. skip
        if _is_skipped(name, skips):
            print(f"  [SKIP group] {name}")
            continue

        # 3. 转换
        gtype = g["type"]
        params = g["params"]
        proxies = g["proxies"]

        if gtype == "smart":
            out_lines.extend(_fmt_group_smart(name, params))
        elif gtype == "select":
            out_lines.extend(_fmt_group_select(name, params, proxies))
        else:
            # 其他类型原样尝试
            out_lines.extend(_fmt_group_select(name, params, proxies))

        out_lines.append("")  # 组间空行

    # 追加未使用的 group blocks（Clash 专属组）
    for name, block in group_blocks.items():
        if name not in used_blocks:
            out_lines.append(block)
            out_lines.append("")

    return "\n".join(out_lines)


# ══════════════════════════════════════════════════════════════════════════════
#  Skip 检查（整链路）
# ══════════════════════════════════════════════════════════════════════════════

def _should_skip(candidates: list[str], skips: list[str]) -> str | None:
    """检查候选字符串列表中是否有任何 skip 关键词命中。
    返回命中的关键词（用于日志），未命中返回 None。
    """
    for cand in candidates:
        for kw in skips:
            if kw in cand:
                return kw
    return None


# ══════════════════════════════════════════════════════════════════════════════
#  Provider 命名
# ══════════════════════════════════════════════════════════════════════════════

def _derive_provider_name(clash_url: str, seen_names: dict[str, str]) -> str:
    """从 Clash URL 的文件名 stem 派生 provider 名，处理冲突。
    seen_names: {provider_name → url}（已注册）
    """
    filename = clash_url.rstrip("/").rsplit("/", 1)[-1]
    # 去除扩展名
    stem = filename
    for ext in (".yaml", ".yml", ".txt", ".list", ".conf"):
        if stem.endswith(ext):
            stem = stem[: -len(ext)]
            break

    name = stem
    counter = 2
    while name in seen_names and seen_names[name] != clash_url:
        name = f"{stem}_{counter}"
        counter += 1
    return name


# ══════════════════════════════════════════════════════════════════════════════
#  生成 rule-providers + rules
# ══════════════════════════════════════════════════════════════════════════════

# Surge flags that have no meaning in Clash rule lines
_SURGE_FLAGS = {"extended-matching", "force-remote-dns", "no-alert"}


def gen_rules_and_providers(
    rule_lines: list[str],
    skips: list[str],
    url_maps: list[tuple[str, str]],
    builtin_maps: dict[str, str],
) -> str:
    """生成 rule-providers + rules 的完整 YAML 文本。"""
    # url → {name, behavior}
    providers: OrderedDict[str, dict] = OrderedDict()
    seen_names: dict[str, str] = {}   # provider_name → url
    rules_out: list[str] = []

    def _register_provider(clash_url: str, behavior: str) -> str:
        """注册 provider（幂等），返回 provider name。"""
        if clash_url in providers:
            return providers[clash_url]["name"]
        name = _derive_provider_name(clash_url, seen_names)
        providers[clash_url] = {"name": name, "behavior": behavior}
        seen_names[name] = clash_url
        return name

    for line in rule_lines:
        s = line.strip()
        if not s or s.startswith("#"):
            continue

        parts = [p.strip() for p in s.split(",")]
        rule_type = parts[0].upper()

        # ── 不支持的类型 ──────────────────────────────────────────────────
        if rule_type in CLASH_UNSUPPORTED_RULE_TYPES:
            print(f"  [SKIP rule] 不支持类型: {s}")
            continue

        # ── FINAL → MATCH ─────────────────────────────────────────────────
        if rule_type == "FINAL":
            policy = parts[1] if len(parts) > 1 else "🔰 Proxy"
            rules_out.append(f"  - MATCH,{policy}")
            continue

        # ── DEST-PORT ─────────────────────────────────────────────────────
        if rule_type == "DEST-PORT":
            # 保留原样（去掉 Surge 专属 flag）
            keep = [p for p in parts if p not in _SURGE_FLAGS]
            rules_out.append("  - " + ",".join(keep))
            continue

        # ── IP-CIDR / IP-CIDR6 ───────────────────────────────────────────
        if rule_type in ("IP-CIDR", "IP-CIDR6"):
            keep = [p for p in parts if p not in _SURGE_FLAGS]
            rules_out.append("  - " + ",".join(keep))
            continue

        # ── GEOIP / GEOSITE ──────────────────────────────────────────────
        if rule_type in ("GEOIP", "GEOSITE"):
            keep = [p for p in parts if p not in _SURGE_FLAGS]
            rules_out.append("  - " + ",".join(keep))
            continue

        # ── RULE-SET / DOMAIN-SET ─────────────────────────────────────────
        if rule_type in ("RULE-SET", "DOMAIN-SET"):
            if len(parts) < 3:
                print(f"  [WARN] 解析失败（字段不足）: {s}")
                continue

            url_or_builtin = parts[1]
            policy = parts[2]
            if rule_type == "DOMAIN-SET":
                behavior = "domain"
            else:
                behavior = "classical"

            # ── 内置规则集（非 http URL）────────────────────────────────
            if not url_or_builtin.startswith("http"):
                builtin_name = url_or_builtin
                if builtin_name not in builtin_maps:
                    print(f"  [SKIP rule] 内置规则集无映射: {builtin_name}")
                    continue
                clash_url = builtin_maps[builtin_name]
                # 内置一般是 IP 段，behavior 覆盖为 ipcidr
                behavior_b = "ipcidr"
                pname = _register_provider(clash_url, behavior_b)
                skip_kw = _should_skip([builtin_name, clash_url, pname, policy], skips)
                if skip_kw:
                    print(f"  [SKIP rule] skip={skip_kw}: {builtin_name} -> {policy}")
                    if clash_url in providers:
                        del providers[clash_url]
                        del seen_names[pname]
                    continue
                rules_out.append(f"  - RULE-SET,{pname},{policy}")
                continue

            # ── 外部 URL ─────────────────────────────────────────────────
            # skip 前置检查（URL 层面）
            pre_skip = _should_skip([url_or_builtin, policy], skips)
            if pre_skip:
                print(f"  [SKIP rule] skip={pre_skip}: {url_or_builtin}")
                continue

            clash_url = map_surge_url(url_or_builtin, url_maps)
            if clash_url is None:
                print(f"  [WARN] 无 Clash URL 映射，跳过: {url_or_builtin}")
                continue

            # 如果 URL 文件名含 "cidr"（大小写不敏感），行为改为 ipcidr
            clash_filename = clash_url.rstrip("/").rsplit("/", 1)[-1].lower()
            if behavior == "classical" and "cidr" in clash_filename:
                behavior = "ipcidr"

            pname = _register_provider(clash_url, behavior)

            # skip 后置检查（provider 名层面）
            post_skip = _should_skip([pname, clash_url], skips)
            if post_skip:
                print(f"  [SKIP rule] skip={post_skip}: {clash_url}")
                if clash_url in providers:
                    del providers[clash_url]
                    seen_names.pop(pname, None)
                continue

            rules_out.append(f"  - RULE-SET,{pname},{policy}")
            continue

        # ── 其他规则（原样保留，去 Surge flags） ─────────────────────────
        keep = [p for p in parts if p not in _SURGE_FLAGS]
        rules_out.append("  - " + ",".join(keep))

    # ── 生成 rule-providers ───────────────────────────────────────────────
    rp_lines = ["# 关于 Rule Provider 请查阅：https://lancellc.gitbook.io/clash/clash-config-file/rule-provider", "", "rule-providers:"]
    for clash_url, info in providers.items():
        pname = info["name"]
        behavior = info["behavior"]
        path = f"./Provider/RuleSet/{pname}.yaml"
        rp_lines.append(f"  {pname}:")
        rp_lines.append(f"    type: http")
        rp_lines.append(f"    behavior: {behavior}")
        rp_lines.append(f"    path: {path}")
        rp_lines.append(f"    url: {clash_url}")
        rp_lines.append(f"    interval: 86400")
        rp_lines.append("")

    # ── 生成 rules ────────────────────────────────────────────────────────
    rules_block = ["# 规则", "rules:"] + rules_out

    return "\n".join(rp_lines) + "\n" + "\n".join(rules_block) + "\n"


# ══════════════════════════════════════════════════════════════════════════════
#  主函数
# ══════════════════════════════════════════════════════════════════════════════

def main() -> None:
    print("── sync-config: Surge Profile → Clash Sample.yaml ──")

    # 解析映射表
    url_maps, skips, group_blocks, builtin_maps = parse_sync_txt()
    print(f"  映射: {len(url_maps)} 条 URL 规则 | skip: {skips} | group blocks: {list(group_blocks)}")

    # 解析 Surge Profile
    proxy_lines, group_lines, rule_lines = parse_surge_profile()
    print(f"  Surge: {len(proxy_lines)} proxies, {len(group_lines)} groups, {len(rule_lines)} rules")

    # 生成各段
    header        = CLASH_GENERAL.read_text(encoding="utf-8").rstrip()
    proxies_yaml  = gen_proxies(proxy_lines)
    groups_yaml   = gen_proxy_groups(group_lines, skips, group_blocks)
    rp_rules_yaml = gen_rules_and_providers(rule_lines, skips, url_maps, builtin_maps)

    output = "\n\n".join([
        header,
        proxies_yaml,
        PROXY_PROVIDERS_BLOCK,
        groups_yaml,
        rp_rules_yaml,
    ]) + "\n"

    changed = write_if_changed(CLASH_SAMPLE, output)
    if changed:
        print("  ✓ Clash/Sample.yaml 已更新")
    else:
        print("  ✓ Clash/Sample.yaml 无变化")


if __name__ == "__main__":
    main()
