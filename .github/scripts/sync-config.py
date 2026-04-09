#!/usr/bin/env python3
"""Surge Profile → Clash Sample.yaml 同步脚本

从 sync-config.txt + Surge/Profile.conf + Clash/General.yaml 生成 Clash/Sample.yaml。

sync-config.txt 格式（平台块 + 子分区）：
  # Platform    平台块（Surge / Clash / Quantumult X / Loon）
  >> path       文件路径（Surge 块为源文件；其他为输出目标）
  # > Skip      跳过关键词（Surge 块 = 全局；平台块 = 仅该平台）
  # > Builtin   静态注入块（proxy-providers / proxy-groups / << include）
  # > Mapping   URL 映射（X => Y）与内置规则集映射
"""

import re
from collections import OrderedDict
from pathlib import Path

# ---------------------------------------------------------------------------
# 路径配置
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SURGE_PROFILE = REPO_ROOT / "Surge" / "Profile.conf"
CLASH_SAMPLE = REPO_ROOT / "Clash" / "Sample.yaml"
SYNC_CONFIG_TXT = REPO_ROOT / ".github" / "scripts" / "sync-config.txt"

HOTKIDS_SURGE_PREFIX = "https://raw.githubusercontent.com/HotKids/Rules/master/Surge/RULE-SET/"
HOTKIDS_CLASH_PREFIX = "https://raw.githubusercontent.com/HotKids/Rules/master/Clash/RuleSet/"

CLASH_UNSUPPORTED_RULE_TYPES = {"PROTOCOL", "URL-REGEX", "USER-AGENT"}
_SURGE_FLAGS = {"extended-matching", "force-remote-dns", "no-alert"}
RAW_PREFIX = "https://raw.githubusercontent.com/"

# ---------------------------------------------------------------------------
# 通用工具
# ---------------------------------------------------------------------------

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
    result = name.lstrip()
    while result:
        cp = ord(result[0])
        if (
            0x1F000 <= cp <= 0x1FFFF  # 杂项符号和象形文字
            or 0x2600 <= cp <= 0x27BF  # 杂项符号
            or 0xFE00 <= cp <= 0xFE0F  # 变体选择符
            or 0x1F1E0 <= cp <= 0x1F1FF  # 区域指示符（国旗）
        ):
            result = result[1:].lstrip()
        else:
            break
    return result.strip()

# ---------------------------------------------------------------------------
# 解析 sync-config.txt
# ---------------------------------------------------------------------------

def _process_builtin(lines: list[str]) -> tuple[str, dict | None, dict | None]:
    """从 Builtin 分区的原始行提取 proxy-providers、proxy-groups 和 rules 注入配置。

    返回：
      proxy_providers  str        proxy-providers: 之前的注释 + 该段完整文本
      pg_inject        dict|None  {anchor, block, names}
        anchor  str|None   注入到该 group 之后；None = 追加
        block   str        清理后的 YAML 文本
        names   set[str]   块中定义的组名
      rules_inject     dict|None  {anchor, rules}
        anchor  str|None   注入到含该字符串的 rule 之后；None = 追加
        rules   list[str]  要注入的规则字符串列表
    """
    pp_lines: list[str] = []
    pg_lines: list[str] = []
    rules_lines: list[str] = []
    mode = "pp"  # pp | pg | rules

    for line in lines:
        if re.match(r"^proxy-groups:", line):
            mode = "pg"
            continue
        if re.match(r"^rules:", line):
            mode = "rules"
            continue
        if mode == "pp":
            pp_lines.append(line)
        elif mode == "pg":
            pg_lines.append(line)
        elif mode == "rules":
            rules_lines.append(line)

    proxy_providers = "\n".join(l.rstrip() for l in pp_lines).rstrip()

    # proxy-groups 注入
    pg_inject: dict | None = None
    if pg_lines:
        anchor: str | None = None
        cleaned: list[str] = []
        for line in pg_lines:
            s = line.strip()
            if s.startswith("#") and "//" in s and anchor is None:
                m = re.search(r"//\s*(.+?)(?=\s+[\u4e00-\u9fff]|\s*$)", s)
                if m:
                    anchor = m.group(1).strip()
                clean_comment = re.sub(r"\s*//.*$", "", s).rstrip()
                if clean_comment and clean_comment != "#":
                    cleaned.append(re.sub(r"\s*//.*$", "", line).rstrip())
                continue
            cleaned.append(line.rstrip())
        names: set[str] = set(re.findall(r'- name:\s*"([^"]+)"', "\n".join(pg_lines)))
        pg_inject = {"anchor": anchor, "block": "\n".join(cleaned).rstrip(), "names": names}

    # rules 注入
    rules_inject: dict | None = None
    if rules_lines:
        anchor_r: str | None = None
        rules: list[str] = []
        for line in rules_lines:
            s = line.strip()
            if not s:
                continue
            if s.startswith("#"):
                if "//" in s and anchor_r is None:
                    m = re.search(r"//\s*(.+?)(?=\s+[\u4e00-\u9fff]|\s*$)", s)
                    if m:
                        anchor_r = m.group(1).strip()
                continue
            # "  - RULE,..." → extract rule string
            if s.startswith("-"):
                rules.append(s[1:].strip())
        rules_inject = {"anchor": anchor_r, "rules": rules}

    return proxy_providers, pg_inject, rules_inject


def _empty_plat() -> dict:
    return {
        "output": None,
        "include_file": None,
        "skips": [],
        "url_maps": [],
        "builtin_rule_maps": {},
        "proxy_providers": "",
        "pg_inject": None,
        "rules_inject": None,
    }


def parse_sync_txt() -> dict:
    """解析 sync-config.txt（平台块格式），返回所有平台配置。

    返回结构：
    {
      'global_skips': [...],
      'Clash': {
        'output': 'Clash/Sample.yaml',
        'include_file': 'Clash/General.yaml',
        'skips': [...],
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

    current_platform = ""
    current_section = ""
    builtin_buf: list[str] = []

    def flush_builtin() -> None:
        if current_section == "Builtin" and current_platform and current_platform != "Surge":
            plat = result.setdefault(current_platform, _empty_plat())
            pp, pg, ri = _process_builtin(builtin_buf)
            plat["proxy_providers"] = pp
            plat["pg_inject"] = pg
            plat["rules_inject"] = ri
        builtin_buf.clear()

    for raw in lines:
        stripped = raw.strip()

        # 平台块标题：# Platform（不含 >）
        m = re.match(r"^#\s+([A-Za-z][\w\s/]*)$", stripped)
        if m:
            flush_builtin()
            current_platform = m.group(1).strip()
            current_section = ""
            if current_platform != "Surge":
                result.setdefault(current_platform, _empty_plat())
            continue

        # 子分区：# > SubSection
        m = re.match(r"^#\s+>\s+(.+)$", stripped)
        if m:
            flush_builtin()
            current_section = m.group(1).strip()
            continue

        # 空行：Builtin 分区内保留（YAML 块结构需要）
        if not stripped:
            if current_section == "Builtin":
                builtin_buf.append(raw)
            continue

        # 注释：Builtin 分区内保留
        if stripped.startswith("#"):
            if current_section == "Builtin":
                builtin_buf.append(raw)
            continue

        # >> path：输出路径指令
        if stripped.startswith(">>"):
            if current_platform and current_platform != "Surge":
                result.setdefault(current_platform, _empty_plat())["output"] = stripped[2:].strip()
            continue

        # << path：Builtin 分区内的文件引用（作为输出头部）
        if stripped.startswith("<<"):
            if current_section == "Builtin" and current_platform and current_platform != "Surge":
                result.setdefault(current_platform, _empty_plat())["include_file"] = stripped[2:].strip()
            continue

        # 内容行：按分区路由
        if current_section == "Builtin":
            builtin_buf.append(raw)
        elif current_section == "Skip":
            if current_platform == "Surge":
                result["global_skips"].append(stripped)
            elif current_platform:
                result.setdefault(current_platform, _empty_plat())["skips"].append(stripped)
        elif current_section == "Mapping" and current_platform and current_platform != "Surge":
            if "=>" not in stripped:
                continue
            left, _, right = stripped.partition("=>")
            left, right = left.strip(), right.strip()
            if not left:
                continue
            # right 留空表示"路径不变，仅规范扩展名为 .yaml"
            plat = result.setdefault(current_platform, _empty_plat())
            if not left.startswith("http") and "/" not in left:
                plat["builtin_rule_maps"][left] = right
            else:
                plat["url_maps"].append((left, right))

    flush_builtin()
    return result

# ---------------------------------------------------------------------------
# URL 映射
# ---------------------------------------------------------------------------

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
        rest = rest.replace("%20", " ")
        if rest.endswith(".list"):
            rest = rest[:-5] + ".yaml"
        return HOTKIDS_CLASH_PREFIX + rest

    # 2 & 3. 精确 URL 或前缀匹配
    best_len = 0
    best_result: str | None = None
    for left, right in url_maps:
        if not left.startswith("http"):
            continue
        if url == left:
            return right
        if url.startswith(left) and len(left) > best_len:
            best_len = len(left)
            best_result = right.rstrip("/") + "/" + url[len(left):]

    if best_result:
        return best_result

    # 4. 仓库简写（或同仓库扩展名规范化：right 为空）
    for left, right in url_maps:
        if left.startswith("http"):
            continue
        prefix = _expand_shorthand(left)
        if url.startswith(prefix):
            suffix = url[len(prefix):]
            if right:
                return _expand_shorthand(right) + suffix
            # right 为空：保持路径，将文件扩展名规范为 .yaml
            filename = suffix.rsplit("/", 1)[-1] if "/" in suffix else suffix
            if "." in filename:
                stem = suffix.rsplit(".", 1)[0]
                return prefix + stem + ".yaml"
            return prefix + suffix + ".yaml"

    return None

# ---------------------------------------------------------------------------
# 解析 Surge Profile.conf
# ---------------------------------------------------------------------------

def parse_surge_profile() -> tuple[list[str], list[str], list[str]]:
    """读取 Surge/Profile.conf，返回 proxy_lines, group_lines, rule_lines。"""
    text = SURGE_PROFILE.read_text(encoding="utf-8")
    sections: dict[str, list[str]] = {}
    current: str | None = None

    for line in text.splitlines():
        m = re.match(r"^\[(.+)\]$", line.strip())
        if m:
            current = m.group(1)
            sections[current] = []
        elif current is not None:
            sections[current].append(line)

    def clean(lines: list[str]) -> list[str]:
        out = []
        for l in lines:
            s = l.strip()
            if not s:
                continue
            if s.startswith("//"):
                continue  # Surge // 注释行（已注释掉的配置）丢弃
            out.append(s)  # 保留 # 注释行和内容行
        return out

    return (
        clean(sections.get("Proxy", [])),
        clean(sections.get("Proxy Group", [])),
        clean(sections.get("Rule", [])),
    )

# ---------------------------------------------------------------------------
# 生成 proxies
# ---------------------------------------------------------------------------

def gen_proxies(proxy_lines: list[str]) -> str:
    """生成 proxies 段落。当前 Profile.conf 只有内置 DIRECT/REJECT，输出空列表。"""
    real = [
        l for l in proxy_lines
        if "=" in l and l.partition("=")[2].strip().lower() not in ("direct", "reject")
    ]
    if not real:
        return "# 本地节点配置（订阅为空）\nproxies: []"
    return "proxies:\n" + "\n".join(f"  - {p}" for p in real)

# ---------------------------------------------------------------------------
# 解析 Proxy Group 行
# ---------------------------------------------------------------------------

def parse_group_line(line: str) -> dict | None:
    """解析一行 Surge Proxy Group 定义。

    格式：GroupName = type,proxy1,proxy2,...,key=val,...
    返回 {name, type, proxies, params} 或 None。
    """
    name, sep, rest = line.partition(" = ")
    if not sep:
        name, sep, rest = line.partition("=")
    if not sep:
        return None

    tokens = [t.strip() for t in rest.strip().split(",")]
    if not tokens:
        return None

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

    return {"name": name.strip(), "type": tokens[0].lower(), "proxies": proxies, "params": params}

# ---------------------------------------------------------------------------
# 生成 proxy-groups
# ---------------------------------------------------------------------------

def _parse_provider_urls(pp_block: str) -> dict[str, str]:
    """从 proxy-providers YAML 文本提取 {name → url}。"""
    result: dict[str, str] = {}
    current = None
    for line in pp_block.splitlines():
        # 两格缩进的顶层键 = provider 名称
        if m := re.match(r"^  ([A-Za-z]\S*):\s*$", line):
            current = m.group(1)
        elif current and (m := re.match(r"    url:\s+(\S+)", line)):
            result[current] = m.group(1)
            current = None
    return result


def _match_provider(policy_path: str, provider_urls: dict[str, str]) -> str | None:
    """通过域名模糊匹配，从 proxy-providers 中找到对应 policy-path 的 provider 名。"""
    m = re.match(r"https?://([^/:]+)", policy_path)
    if not m:
        return None
    pp_host = m.group(1)
    for name, url in provider_urls.items():
        if m2 := re.match(r"https?://([^/:]+)", url):
            pv_host = m2.group(1)
            if pp_host in pv_host or pv_host in pp_host:
                return name
    return None


def _is_skipped(name: str, skips: list[str]) -> bool:
    return any(kw in name for kw in skips)


def _fmt_group(
    name: str,
    gtype: str,
    params: dict[str, str],
    proxies: list[str],
    provider_urls: dict[str, str] | None = None,
) -> list[str]:
    """生成 proxy-group 的 YAML 行列表（select / smart 均输出为 select）。"""
    lines = [f'  - name: "{name}"', "    type: select"]

    icon = params.get("icon-url", "")
    if icon:
        lines.append(f"    icon: {icon}")

    if params.get("include-all-proxies", "").lower() in ("true", "1"):
        lines += ["    use:", "      - Server"]
        return lines

    other = params.get("include-other-group", "")
    if other:
        lines += ["    use:", f"      - {strip_emoji(other)}"]
        return lines

    # policy-path → 通过域名匹配找到对应 proxy-provider
    policy_path = params.get("policy-path", "")
    if policy_path and provider_urls:
        if matched := _match_provider(policy_path, provider_urls):
            lines += ["    use:", f"      - {matched}"]
            return lines

    regex = params.get("policy-regex-filter", "")
    if regex:
        lines.append(f"    filter: '{regex}'")

    if gtype == "smart" and params.get("hidden", "0") in ("1", "true"):
        lines.append("    hidden: true")

    if proxies:
        lines.append("    proxies:")
        lines += [f"      - {p}" for p in proxies]

    return lines


def gen_proxy_groups(
    group_lines: list[str],
    skips: list[str],
    pg_inject: dict | None,
    provider_urls: dict[str, str] | None = None,
) -> str:
    """生成 proxy-groups 段落。

    pg_inject（来自 Builtin 分区）：
      anchor  str|None  将注入块插入到该组之后；None = 追加到末尾
      block   str       要注入的 YAML 文本
      names   set[str]  块中已定义的组名（从 Surge 转换中跳过）
    """
    out: list[str] = ["proxy-groups:"]
    inject_names: set[str] = pg_inject["names"] if pg_inject else set()
    injected = False

    for line in group_lines:
        if line.startswith("#"):
            out.append(f"  {line}")
            continue
        g = parse_group_line(line)
        if g is None:
            continue
        name = g["name"]

        if name in inject_names:
            continue
        if _is_skipped(name, skips):
            print(f"  [SKIP group] {name}")
            continue

        out.extend(_fmt_group(name, g["type"], g["params"], g["proxies"], provider_urls))
        out.append("")

        if pg_inject and not injected and pg_inject["anchor"] == name:
            out.append(pg_inject["block"])
            out.append("")
            injected = True

    if pg_inject and not injected:
        out.append(pg_inject["block"])
        out.append("")

    return "\n".join(out)

# ---------------------------------------------------------------------------
# Skip 检查
# ---------------------------------------------------------------------------

def _should_skip(candidates: list[str], skips: list[str]) -> str | None:
    """检查候选字符串中是否命中 skip 关键词，返回命中的关键词或 None。"""
    for cand in candidates:
        for kw in skips:
            if kw in cand:
                return kw
    return None

# ---------------------------------------------------------------------------
# Provider 命名
# ---------------------------------------------------------------------------

def _derive_provider_name(clash_url: str, seen: dict[str, str]) -> str:
    """从 Clash URL 文件名派生 provider 名（首字母大写），处理冲突。"""
    stem = clash_url.rstrip("/").rsplit("/", 1)[-1]
    for ext in (".yaml", ".yml", ".txt", ".list", ".conf"):
        if stem.endswith(ext):
            stem = stem[: -len(ext)]
            break
    stem = stem[0].upper() + stem[1:] if stem else stem
    name, counter = stem, 2
    while name in seen and seen[name] != clash_url:
        name = f"{stem}_{counter}"
        counter += 1
    return name


def _behavior_from_url(url: str) -> str:
    """从 URL 文件名推断 rule-provider behavior（兜底检测）。

    优先级：cidr（文件名含）→ ipcidr；.txt → domain；其他 → classical
    """
    filename = url.rstrip("/").rsplit("/", 1)[-1].lower()
    stem = filename
    for ext in (".yaml", ".yml", ".txt", ".list", ".conf"):
        if stem.endswith(ext):
            stem = stem[: -len(ext)]
            break
    if "cidr" in stem:
        return "ipcidr"
    if filename.endswith(".txt"):
        return "domain"
    return "classical"

# ---------------------------------------------------------------------------
# 生成 rule-providers + rules
# ---------------------------------------------------------------------------

def gen_rules_and_providers(
    rule_lines: list[str],
    skips: list[str],
    url_maps: list[tuple[str, str]],
    builtin_maps: dict[str, str],
    rules_inject: dict | None = None,
) -> str:
    """生成 rule-providers + rules 的完整 YAML 文本。"""
    providers: OrderedDict[str, dict] = OrderedDict()
    seen: dict[str, str] = {}  # provider_name → url
    rules_out: list[str] = []

    def register(clash_url: str, behavior: str) -> str:
        if clash_url in providers:
            return providers[clash_url]["name"]
        name = _derive_provider_name(clash_url, seen)
        providers[clash_url] = {"name": name, "behavior": behavior}
        seen[name] = clash_url
        return name

    # 直通规则类型（原样输出，去掉 Surge 专属 flag）
    PASSTHROUGH = {"DEST-PORT", "IP-CIDR", "IP-CIDR6", "GEOIP", "GEOSITE",
                   "DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD"}

    for line in rule_lines:
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            rules_out.append(f"  {s}")
            continue

        parts = [p.strip() for p in s.split(",")]
        rule_type = parts[0].upper()

        if rule_type in CLASH_UNSUPPORTED_RULE_TYPES:
            print(f"  [SKIP rule] 不支持类型: {s}")
            continue

        if rule_type == "FINAL":
            policy = parts[1] if len(parts) > 1 else "🔰 Proxy"
            rules_out.append(f"  - MATCH,{policy}")
            continue

        if rule_type in PASSTHROUGH:
            # Surge 专用丢包保护（0.0.0.0/32），Clash 无对应机制
            if rule_type in ("IP-CIDR", "IP-CIDR6") and len(parts) > 1 and parts[1] == "0.0.0.0/32":
                continue
            keep = [p for p in parts if p not in _SURGE_FLAGS]
            rules_out.append("  - " + ",".join(keep))
            continue

        if rule_type not in ("RULE-SET", "DOMAIN-SET"):
            keep = [p for p in parts if p not in _SURGE_FLAGS]
            rules_out.append("  - " + ",".join(keep))
            continue

        # RULE-SET / DOMAIN-SET
        if len(parts) < 3:
            print(f"  [WARN] 解析失败（字段不足）: {s}")
            continue

        url_or_builtin, policy = parts[1], parts[2]

        if not url_or_builtin.startswith("http"):
            # 内置规则集
            if url_or_builtin not in builtin_maps:
                print(f"  [SKIP rule] 内置规则集无映射: {url_or_builtin}")
                continue
            clash_url = builtin_maps[url_or_builtin]
            pname = register(clash_url, _behavior_from_url(clash_url))
            if skip := _should_skip([url_or_builtin, clash_url, pname, policy], skips):
                print(f"  [SKIP rule] skip={skip}: {url_or_builtin} -> {policy}")
                providers.pop(clash_url, None)
                seen.pop(pname, None)
                continue
            rules_out.append(f"  - RULE-SET,{pname},{policy}")
            continue

        # 外部 URL
        if skip := _should_skip([url_or_builtin, policy], skips):
            print(f"  [SKIP rule] skip={skip}: {url_or_builtin}")
            continue

        clash_url = map_surge_url(url_or_builtin, url_maps)
        if clash_url is None:
            print(f"  [WARN] 无 Clash URL 映射，跳过: {url_or_builtin}")
            continue

        # cidr 文件名覆盖 > rule type > 文件名兜底
        url_beh = _behavior_from_url(clash_url)
        if url_beh == "ipcidr":
            behavior = "ipcidr"
        elif rule_type == "DOMAIN-SET":
            behavior = "domain"
        elif rule_type == "RULE-SET":
            behavior = "classical"
        else:
            behavior = url_beh
        pname = register(clash_url, behavior)

        if skip := _should_skip([pname, clash_url], skips):
            print(f"  [SKIP rule] skip={skip}: {clash_url}")
            providers.pop(clash_url, None)
            seen.pop(pname, None)
            continue

        rules_out.append(f"  - RULE-SET,{pname},{policy}")

    # rule-providers
    rp_lines = [
        "# 关于 Rule Provider 请查阅：https://lancellc.gitbook.io/clash/clash-config-file/rule-provider",
        "",
        "rule-providers:",
    ]
    for clash_url, info in providers.items():
        pname, behavior = info["name"], info["behavior"]
        rp_lines += [
            f"  {pname}:",
            "    type: http",
            f"    behavior: {behavior}",
            f"    path: ./Provider/RuleSet/{pname}.yaml",
            f"    url: {clash_url}",
            "    interval: 86400",
            "",
        ]

    # 注入 Builtin rules（按锚点插入，否则追加到 MATCH 之前）
    if rules_inject and rules_inject.get("rules"):
        inject_lines = [f"  - {r}" for r in rules_inject["rules"]]
        anchor_r = (rules_inject.get("anchor") or "").lower()
        if anchor_r:
            inserted = False
            new_out: list[str] = []
            for rule in rules_out:
                new_out.append(rule)
                if not inserted and anchor_r in rule.lower():
                    new_out.extend(inject_lines)
                    inserted = True
            if not inserted:
                # anchor not found: insert before MATCH
                for i, rule in enumerate(new_out):
                    if "MATCH," in rule:
                        new_out[i:i] = inject_lines
                        break
                else:
                    new_out.extend(inject_lines)
            rules_out = new_out
        else:
            # no anchor: insert before MATCH
            for i, rule in enumerate(rules_out):
                if "MATCH," in rule:
                    rules_out[i:i] = inject_lines
                    break
            else:
                rules_out.extend(inject_lines)

    rules_block = ["# 规则", "rules:"] + rules_out
    return "\n".join(rp_lines) + "\n" + "\n".join(rules_block) + "\n"

# ---------------------------------------------------------------------------
# 主函数
# ---------------------------------------------------------------------------

def main() -> None:
    print("── sync-config: Surge Profile → Clash Sample.yaml ──")

    config = parse_sync_txt()
    clash = config.get("Clash", {})
    skips = config.get("global_skips", []) + clash.get("skips", [])
    url_maps = clash.get("url_maps", [])
    builtin_maps = clash.get("builtin_rule_maps", {})
    pp_block = clash.get("proxy_providers", "")
    pg_inject = clash.get("pg_inject")
    rules_inject = clash.get("rules_inject")
    provider_urls = _parse_provider_urls(pp_block) if pp_block else {}

    print(f"  映射: {len(url_maps)} 条 URL 规则 | skip: {skips}")
    if pg_inject:
        print(f"  pg_inject: anchor={pg_inject['anchor']} | names={pg_inject['names']}")
    if rules_inject:
        print(f"  rules_inject: anchor={rules_inject['anchor']} | {len(rules_inject['rules'])} rules")

    proxy_lines, group_lines, rule_lines = parse_surge_profile()
    print(f"  Surge: {len(proxy_lines)} proxies, {len(group_lines)} groups, {len(rule_lines)} rules")

    inc = clash.get("include_file")
    if not inc:
        raise ValueError("Clash Builtin 分区缺少 << include_file 指令")
    header = (REPO_ROOT / inc).read_text(encoding="utf-8").rstrip()
    proxies_yaml = gen_proxies(proxy_lines)
    groups_yaml = gen_proxy_groups(group_lines, skips, pg_inject, provider_urls)
    rp_rules_yaml = gen_rules_and_providers(rule_lines, skips, url_maps, builtin_maps, rules_inject)

    parts = [header, proxies_yaml]
    if pp_block:
        parts.append(pp_block)
    parts += [groups_yaml, rp_rules_yaml]

    changed = write_if_changed(CLASH_SAMPLE, "\n\n".join(parts) + "\n")
    print(f"  {'✓ Clash/Sample.yaml 已更新' if changed else '✓ Clash/Sample.yaml 无变化'}")


if __name__ == "__main__":
    main()
