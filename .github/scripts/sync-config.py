#!/usr/bin/env python3
"""
Surge Profile.conf → 多平台配置同步脚本

从 sync-config.txt + Surge/Profile.conf + Clash/General.yaml 生成：
  Clash/Sample.yaml（当前实现）
  Quantumult/Sample.conf, Surge/Balloon.lcf（占位，待扩展）

sync-config.txt 格式（平台块 + 子分区）：
  # Platform        平台块
  >>  path          文件路径
  # > Skip          跳过关键词
  # > Builtin       静态注入（proxy-providers + proxy-groups + 锚点）
  # > Mapping       URL / 规则集映射
"""

import re
import sys
from collections import OrderedDict
from pathlib import Path

# ─── 路径配置 ─────────────────────────────────────────────────────────────────
REPO_ROOT       = Path(__file__).resolve().parent.parent.parent
SURGE_PROFILE   = REPO_ROOT / "Surge" / "Profile.conf"
CLASH_GENERAL   = REPO_ROOT / "Clash" / "General.yaml"
CLASH_SAMPLE    = REPO_ROOT / "Clash" / "Sample.yaml"
SYNC_CONFIG_TXT = REPO_ROOT / ".github" / "scripts" / "sync-config.txt"

# ─── HotKids 自动路径映射 ────────────────────────────────────────────────────
HOTKIDS_SURGE_PREFIX = "https://raw.githubusercontent.com/HotKids/Rules/master/Surge/RULE-SET/"
HOTKIDS_CLASH_PREFIX = "https://raw.githubusercontent.com/HotKids/Rules/master/Clash/RuleSet/"

# ─── Clash 不支持的 Surge 规则类型 ───────────────────────────────────────────
CLASH_UNSUPPORTED_RULE_TYPES = {"PROTOCOL", "URL-REGEX", "USER-AGENT"}


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

def _process_builtin(lines: list[str]) -> tuple[str, dict | None]:
    """从 Builtin 分区的原始行提取 proxy-providers 块和 proxy-groups 注入配置。

    返回：
      proxy_providers  str       proxy-providers: 之前的注释 + 该段完整文本
      pg_inject        dict|None {anchor, block, names} 或 None
        anchor  str|None  注入锚点（插入到该组之后）
        block   str       清理后的 YAML 注入文本（不含 proxy-groups: 行）
        names   set[str]  块中定义的组名（用于在 Surge 转换时跳过）
    """
    pp_lines: list[str] = []
    pg_lines: list[str] = []
    in_pg = False

    for line in lines:
        if re.match(r"^proxy-groups:", line):
            in_pg = True
            continue  # 丢弃 'proxy-groups:' 标题行本身
        if in_pg:
            pg_lines.append(line)
        else:
            pp_lines.append(line)

    proxy_providers = "\n".join(l.rstrip() for l in pp_lines).rstrip()

    pg_inject: dict | None = None
    if pg_lines:
        anchor: str | None = None
        cleaned: list[str] = []
        for line in pg_lines:
            s = line.strip()
            if s.startswith("#") and "//" in s and anchor is None:
                # 提取锚点名：// 之后到第一个中文字符或行尾
                m = re.search(r"//\s*(.+?)(?=\s+[\u4e00-\u9fff]|\s*$)", s)
                if m:
                    anchor = m.group(1).strip()
                # 清理锚点标记，保留描述文字
                clean_comment = re.sub(r"\s*//.*$", "", s).rstrip()
                if clean_comment and clean_comment != "#":
                    cleaned.append(re.sub(r"\s*//.*$", "", line).rstrip())
                # 仅有 // 标记的注释行（无描述）直接丢弃
                continue
            cleaned.append(line.rstrip())

        names: set[str] = set(re.findall(r'- name:\s*"([^"]+)"', "\n".join(pg_lines)))
        block = "\n".join(cleaned).rstrip()
        pg_inject = {"anchor": anchor, "block": block, "names": names}

    return proxy_providers, pg_inject


def parse_sync_txt() -> dict:
    """解析 sync-config.txt（平台块格式），返回所有平台配置。

    分区格式：
      # Platform         平台块（Surge / Clash / Quantumult X / Loon）
      >>  path           文件路径
      # > Skip           跳过关键词（Surge 块 = 全局；平台块 = 仅该平台）
      # > Builtin        静态注入块
      # > Mapping        URL / 规则集映射（X => Y）

    返回结构：
    {
      'global_skips': [...],
      'Clash': {
        'output': 'Clash/Sample.yaml',
        'skips':  [...],
        'url_maps': [...],
        'builtin_rule_maps': {...},
        'proxy_providers': str,
        'pg_inject': {anchor, block, names} | None,
      },
      'Quantumult X': {...},
      'Loon': {...},
    }
    """
    result: dict = {"global_skips": []}

    if not SYNC_CONFIG_TXT.exists():
        return result

    lines = SYNC_CONFIG_TXT.read_text(encoding="utf-8").splitlines()

    # 当前状态
    current_platform: str = ""      # "Surge" | "Clash" | ...
    current_section:  str = ""      # "Skip" | "Builtin" | "Mapping"
    builtin_buf:  list[str] = []    # 收集 Builtin 分区的原始行

    def _flush_builtin() -> None:
        """将已收集的 Builtin 行解析并写入当前平台配置。"""
        if current_section == "Builtin" and current_platform and current_platform != "Surge":
            plat = result.setdefault(current_platform, _empty_plat())
            pp, pg = _process_builtin(builtin_buf)
            plat["proxy_providers"] = pp
            plat["pg_inject"] = pg
        builtin_buf.clear()

    def _empty_plat() -> dict:
        return {
            "output": None,
            "skips": [],
            "url_maps": [],
            "builtin_rule_maps": {},
            "proxy_providers": "",
            "pg_inject": None,
        }

    for raw in lines:
        stripped = raw.strip()

        # ── 平台块标题：# Platform（不含 >） ─────────────────────────────
        m_plat = re.match(r"^#\s+([A-Za-z][\w\s/]*)$", stripped)
        if m_plat:
            _flush_builtin()
            current_platform = m_plat.group(1).strip()
            current_section = ""
            if current_platform not in ("Surge",):
                result.setdefault(current_platform, _empty_plat())
            continue

        # ── 子分区：# > SubSection ─────────────────────────────────────
        m_sec = re.match(r"^#\s+>\s+(.+)$", stripped)
        if m_sec:
            _flush_builtin()
            current_section = m_sec.group(1).strip()
            continue

        # ── 空行（Builtin 分区内保留，用于 YAML 块结构）─────────────────
        if not stripped:
            if current_section == "Builtin":
                builtin_buf.append(raw)
            continue

        # ── 注释（Builtin 分区内保留）───────────────────────────────────
        if stripped.startswith("#"):
            if current_section == "Builtin":
                builtin_buf.append(raw)
            continue

        # ── 文件路径指令：>>  path ──────────────────────────────────────
        if stripped.startswith(">>"):
            path = stripped[2:].strip()
            if current_platform and current_platform != "Surge":
                result.setdefault(current_platform, _empty_plat())["output"] = path
            continue

        # ── 内容行（按分区路由）─────────────────────────────────────────
        if current_section == "Builtin":
            builtin_buf.append(raw)

        elif current_section == "Skip":
            if current_platform == "Surge":
                result["global_skips"].append(stripped)
            elif current_platform:
                result.setdefault(current_platform, _empty_plat())["skips"].append(stripped)

        elif current_section == "Mapping" and current_platform and current_platform != "Surge":
            if "=>" in stripped:
                left, _, right = stripped.partition("=>")
                left, right = left.strip(), right.strip()
                if not left or not right:
                    continue
                plat = result.setdefault(current_platform, _empty_plat())
                if not left.startswith("http") and "/" not in left:
                    plat["builtin_rule_maps"][left] = right
                else:
                    plat["url_maps"].append((left, right))

    _flush_builtin()
    return result


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
    pg_inject: dict | None,
) -> str:
    """生成 proxy-groups 段落。

    pg_inject（来自 Builtin 分区）：
      anchor  str|None  将注入块插入到该组之后；None = 追加到末尾
      block   str       要注入的 YAML 文本
      names   set[str]  块中已定义的组名 → 从 Surge 转换中跳过
    """
    out_lines = ["proxy-groups:"]
    inject_names: set[str] = pg_inject["names"] if pg_inject else set()
    injected = False

    for line in group_lines:
        g = parse_group_line(line)
        if g is None:
            continue
        name = g["name"]

        # 1. 在 pg_inject 中已定义 → 由注入块处理，跳过 Surge 转换
        if name in inject_names:
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
            out_lines.extend(_fmt_group_select(name, params, proxies))

        out_lines.append("")  # 组间空行

        # 4. 锚点命中 → 在该组之后注入
        if pg_inject and not injected and pg_inject["anchor"] == name:
            out_lines.append(pg_inject["block"])
            out_lines.append("")
            injected = True

    # 未命中锚点（或无锚点）→ 追加到末尾
    if pg_inject and not injected:
        out_lines.append(pg_inject["block"])
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

    # 解析 sync-config.txt
    config       = parse_sync_txt()
    clash        = config.get("Clash", {})
    skips        = config.get("global_skips", []) + clash.get("skips", [])
    url_maps     = clash.get("url_maps", [])
    builtin_maps = clash.get("builtin_rule_maps", {})
    pp_block     = clash.get("proxy_providers", "")
    pg_inject    = clash.get("pg_inject")

    print(f"  映射: {len(url_maps)} 条 URL 规则 | skip: {skips}")
    if pg_inject:
        print(f"  pg_inject: anchor={pg_inject['anchor']} | names={pg_inject['names']}")

    # 解析 Surge Profile
    proxy_lines, group_lines, rule_lines = parse_surge_profile()
    print(f"  Surge: {len(proxy_lines)} proxies, {len(group_lines)} groups, {len(rule_lines)} rules")

    # 生成各段
    header        = CLASH_GENERAL.read_text(encoding="utf-8").rstrip()
    proxies_yaml  = gen_proxies(proxy_lines)
    groups_yaml   = gen_proxy_groups(group_lines, skips, pg_inject)
    rp_rules_yaml = gen_rules_and_providers(rule_lines, skips, url_maps, builtin_maps)

    parts = [header, proxies_yaml]
    if pp_block:
        parts.append(pp_block)
    parts += [groups_yaml, rp_rules_yaml]

    output = "\n\n".join(parts) + "\n"

    changed = write_if_changed(CLASH_SAMPLE, output)
    if changed:
        print("  ✓ Clash/Sample.yaml 已更新")
    else:
        print("  ✓ Clash/Sample.yaml 无变化")


if __name__ == "__main__":
    main()
