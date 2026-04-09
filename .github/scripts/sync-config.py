#!/usr/bin/env python3
"""Surge Profile → Clash Sample.yaml 同步脚本

从 sync-config.txt + Surge/Profile.conf + 平台头部文件生成 Clash/Sample.yaml。

sync-config.txt 格式（平台块 + 子分区）：
  # Platform    平台块（Surge / Clash / Quantumult X / Loon）
  >> path       文件路径（Surge 块 = 源文件；其他 = 输出目标）
  # > Skip      跳过关键词（Surge 块 = 全局；平台块 = 仅该平台）
  # > Builtin   静态注入块（<< 头部文件 / proxy-providers / proxy-groups / rules）
  # > Mapping   URL 映射（X => Y）与内置规则集映射
"""

import re
from collections import OrderedDict
from pathlib import Path

# ---------------------------------------------------------------------------
# 路径配置
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SYNC_CONFIG_TXT = REPO_ROOT / ".github" / "scripts" / "sync-config.txt"

HOTKIDS_SURGE_PREFIX = "https://raw.githubusercontent.com/HotKids/Rules/master/Surge/RULE-SET/"
HOTKIDS_CLASH_PREFIX = "https://raw.githubusercontent.com/HotKids/Rules/master/Clash/RuleSet/"

CLASH_UNSUPPORTED_RULE_TYPES = {"PROTOCOL", "URL-REGEX", "USER-AGENT"}
# 注释掉的规则中，这些类型在 Clash 里同样不支持，直接丢弃（不入待输出缓冲区）
_COMMENT_DROP_TYPES = CLASH_UNSUPPORTED_RULE_TYPES | {"AND", "OR", "NOT"}
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
        if line.strip() == "proxy-groups:":
            mode = "pg"
            continue
        if line.strip() == "rules:":
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
        pre_lines: list[str] = []
        post_lines: list[str] = []
        found_anchor = False
        for line in pg_lines:
            s = line.strip()
            if s.startswith("#") and "//" in s and not found_anchor:
                found_anchor = True
                m = re.search(r"//\s*(.+?)(?=\s+[\u4e00-\u9fff]|\s*$)", s)
                if m:
                    anchor = m.group(1).strip()
                clean_comment = re.sub(r"\s*//.*$", "", s).rstrip()
                if clean_comment and clean_comment != "#":
                    post_lines.append(re.sub(r"\s*//.*$", "", line).rstrip())
                continue
            if found_anchor:
                post_lines.append(line.rstrip())
            else:
                pre_lines.append(line.rstrip())
        names: set[str] = set(re.findall(r'- name:\s*"([^"]+)"', "\n".join(pg_lines)))
        prepend_block = "\n".join(pre_lines).rstrip() or None
        pg_inject = {
            "anchor": anchor,
            "block": "\n".join(post_lines).rstrip(),
            "names": names,
            "prepend_block": prepend_block,
        }

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
                comment_text = re.sub(r"\s*//.*$", "", s).strip()
                if comment_text and comment_text != "#":
                    rules.append(comment_text)
                continue
            # "  - RULE,..." → extract rule string
            if s.startswith("-"):
                rules.append(s[1:].strip())
        rules_inject = {"anchor": anchor_r, "rules": rules}

    return proxy_providers, pg_inject, rules_inject


def _process_builtin_loon(lines: list[str]) -> tuple[str, dict | None, str, str, str]:
    """从 Loon Builtin 内容解析头部和各段落块。

    返回：
      loon_header     str        proxy-groups: 之前的所有内容（[General] 等静态段落）
      pg_inject_loon  dict|None  {anchor, block, names, prepend_block}
      rule_block      str        [Rule] 内容（不含段落标题）
      plugin_block    str        [Plugin] 内容（不含段落标题）
      mitm_block      str        [Mitm] 内容（不含段落标题）
    """
    header_lines: list[str] = []
    pg_lines: list[str] = []
    rule_lines: list[str] = []
    plugin_lines: list[str] = []
    mitm_lines: list[str] = []
    mode = "header"  # header | pg | Rule | Plugin | Mitm

    for line in lines:
        s = line.strip()
        if s in ("proxy-groups:", "[Proxy Group]"):
            mode = "pg"
            continue
        if s == "[Rule]":
            mode = "Rule"
            continue
        if s == "[Plugin]":
            mode = "Plugin"
            continue
        if s in ("[Mitm]", "[MITM]"):
            mode = "Mitm"
            continue
        if mode == "header":
            header_lines.append(line)
        elif mode == "pg":
            pg_lines.append(line)
        elif mode == "Rule":
            rule_lines.append(line)
        elif mode == "Plugin":
            plugin_lines.append(line)
        elif mode == "Mitm":
            mitm_lines.append(line)

    loon_header = "\n".join(l.rstrip() for l in header_lines).strip()

    # proxy-groups 注入（Loon 格式：Name = type,...,img-url = URL）
    pg_inject_loon: dict | None = None
    if pg_lines:
        anchor: str | None = None
        pre_lines: list[str] = []
        post_lines: list[str] = []
        found_anchor = False

        for line in pg_lines:
            s = line.strip()
            if not s:
                continue
            if s.startswith("#") and "//" in s and not found_anchor:
                found_anchor = True
                m = re.search(r"//\s*(.+?)(?=\s+[\u4e00-\u9fff]|\s*$)", s)
                if m:
                    anchor = m.group(1).strip()
                clean_s = re.sub(r"\s*//.*$", "", s).rstrip()
                if clean_s and clean_s != "#":
                    post_lines.append(clean_s)
                continue
            if found_anchor:
                post_lines.append(s)
            else:
                pre_lines.append(s)

        # 从 Loon 行（Name = type,...）提取 names
        names: set[str] = set()
        for line in pg_lines:
            s = line.strip()
            if s and not s.startswith("#") and "=" in s:
                name = s.split("=")[0].strip()
                if name:
                    names.add(name)

        prepend_block = "\n".join(pre_lines).strip() or None
        pg_inject_loon = {
            "anchor": anchor,
            "block": "\n".join(post_lines).strip(),
            "names": names,
            "prepend_block": prepend_block,
        }

    rule_block = "\n".join(l.rstrip() for l in rule_lines).strip()
    plugin_block = "\n".join(l.rstrip() for l in plugin_lines).strip()
    mitm_block = "\n".join(l.rstrip() for l in mitm_lines).strip()

    return loon_header, pg_inject_loon, rule_block, plugin_block, mitm_block


def _empty_plat() -> dict:
    return {
        "output": None,
        "include_file": None,
        "skips": [],
        "url_maps": [],
        "builtin_rule_maps": {},
        "rename_map": {},
        "proxy_providers": "",
        "pg_inject": None,
        "rules_inject": None,
        "filter_map": {},
        "pg_inject_loon": None,
        "loon_blocks": {},
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
            if current_platform == "Loon":
                hdr, pg_inj, rule_blk, plugin_blk, mitm_blk = _process_builtin_loon(builtin_buf)
                plat["loon_header"] = hdr
                plat["pg_inject_loon"] = pg_inj
                plat["loon_blocks"] = {"Rule": rule_blk, "Plugin": plugin_blk, "Mitm": mitm_blk}
            else:
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

        # >> path：路径指令（Surge = 源文件；其他 = 输出目标）
        if stripped.startswith(">>"):
            path = stripped[2:].strip()
            if current_platform == "Surge":
                result.setdefault("Surge", {})["source"] = path
            elif current_platform:
                result.setdefault(current_platform, _empty_plat())["output"] = path
            continue

        # << path：Builtin 分区内的文件引用（作为输出头部，或展开 .ini 文件）
        if stripped.startswith("<<"):
            if current_section == "Builtin" and current_platform and current_platform != "Surge":
                path = stripped[2:].strip()
                if path.endswith(".ini"):
                    ini_path = REPO_ROOT / path
                    if ini_path.exists():
                        for ini_line in ini_path.read_text(encoding="utf-8").splitlines():
                            ini_s = ini_line.strip()
                            if ini_s.startswith("<<"):
                                result.setdefault(current_platform, _empty_plat())["include_file"] = ini_s[2:].strip()
                            else:
                                builtin_buf.append(ini_line)
                else:
                    result.setdefault(current_platform, _empty_plat())["include_file"] = path
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
        elif current_section == "Rename" and current_platform and current_platform != "Surge":
            if "=>" not in stripped:
                continue  # 跳过 "rule-providers:" 等标题行
            left, _, right = stripped.partition("=>")
            left, right = left.strip(), right.strip()
            if left and right:
                result.setdefault(current_platform, _empty_plat())["rename_map"][left] = right
        elif current_section == "FilterMap" and current_platform and current_platform != "Surge":
            if "=>" not in stripped:
                continue
            left, _, right = stripped.partition("=>")
            left, right = left.strip(), right.strip()
            if left:
                result.setdefault(current_platform, _empty_plat())["filter_map"][left] = right

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

def parse_surge_profile(profile_path: Path) -> tuple[list[str], list[str], list[str]]:
    """读取 Surge Profile.conf，返回 proxy_lines, group_lines, rule_lines。"""
    text = profile_path.read_text(encoding="utf-8")
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

    # 确定 use 来源（三选一，优先级依次降低）
    use_name: str | None = None
    if params.get("include-all-proxies", "").lower() in ("true", "1"):
        use_name = "Server"
    elif other := params.get("include-other-group", ""):
        use_name = strip_emoji(other)
    elif (pp := params.get("policy-path", "")) and provider_urls:
        use_name = _match_provider(pp, provider_urls)

    if use_name:
        lines += ["    use:", f"      - {use_name}"]

    # 节点筛选（可与 use 共存，smart 类型的核心功能）
    if regex := params.get("policy-regex-filter", ""):
        lines.append(f"    filter: '{regex}'")


    # 无 use 时用静态节点列表
    if not use_name and proxies:
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
    # 三级注释缓冲：h[0]=# h[1]=# > h[2]=# >>（与 gen_rules_and_providers 同逻辑）
    pending_h: list[str | None] = [None, None, None]

    def _h_skip() -> None:
        for i in range(2, -1, -1):
            if pending_h[i] is not None:
                for j in range(i, 3):
                    pending_h[j] = None
                return

    def _h_flush() -> list[str]:
        result = []
        for i in range(3):
            if pending_h[i] is not None:
                result.append(pending_h[i])
                pending_h[i] = None
        return result

    # prepend_block：Builtin 中无 // 锚点的分组 → 插到最前
    if pg_inject and pg_inject.get("prepend_block"):
        out.append(pg_inject["prepend_block"])
        out.append("")

    for line in group_lines:
        if line.startswith("#"):
            lvl = 3 if line.startswith("# >>") else (2 if line.startswith("# >") else 1)
            idx = lvl - 1
            pending_h[idx] = f"  {line}"
            for i in range(idx + 1, 3):
                pending_h[i] = None
            continue
        g = parse_group_line(line)
        if g is None:
            _h_skip()
            continue
        name = g["name"]

        if name in inject_names:
            _h_skip()
            continue
        if _is_skipped(name, skips):
            print(f"  [SKIP group] {name}")
            _h_skip()
            continue

        out.extend(_h_flush())
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

def _derive_provider_name(
    clash_url: str, seen: dict[str, str], rename_map: dict[str, str] | None = None
) -> str:
    """从 Clash URL 文件名派生 provider 名，处理冲突。"""
    stem = clash_url.rstrip("/").rsplit("/", 1)[-1]
    for ext in (".yaml", ".yml", ".txt", ".list", ".conf"):
        if stem.endswith(ext):
            stem = stem[: -len(ext)]
            break
    stem = stem.replace("%20", " ")
    if rename_map:
        stem = rename_map.get(stem, stem)
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
    rename_map: dict[str, str] | None = None,
) -> str:
    """生成 rule-providers + rules 的完整 YAML 文本。"""
    providers: OrderedDict[str, dict] = OrderedDict()
    seen: dict[str, str] = {}  # provider_name → url
    rules_out: list[str] = []
    # 三级注释缓冲：h[0]=# h[1]=# > h[2]=# >>
    # 规则跳过时，从最深非空层起向下清除；成功时全部刷出
    pending_h: list[str | None] = [None, None, None]

    def _h_skip() -> None:
        """跳过/无映射时：从最深非空层起清除（保留更高层直到下一条规则出现）。"""
        for i in range(2, -1, -1):
            if pending_h[i] is not None:
                for j in range(i, 3):
                    pending_h[j] = None
                return

    def _h_flush() -> None:
        """规则输出前：将所有待定注释刷入 rules_out。"""
        for i in range(3):
            if pending_h[i] is not None:
                rules_out.append(pending_h[i])
                pending_h[i] = None

    def register(clash_url: str, behavior: str) -> str:
        if clash_url in providers:
            return providers[clash_url]["name"]
        name = _derive_provider_name(clash_url, seen, rename_map)
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
            # 已注释掉的 Clash 不支持类型（如 AND/OR/NOT/PROTOCOL）直接丢弃
            inner_type = s.lstrip("#").strip().split(",")[0].strip().upper()
            if inner_type not in _COMMENT_DROP_TYPES:
                lvl = 3 if s.startswith("# >>") else (2 if s.startswith("# >") else 1)
                idx = lvl - 1
                pending_h[idx] = f"  {s}"
                for i in range(idx + 1, 3):  # 清除更深层的孤立注释
                    pending_h[i] = None
            continue

        parts = [p.strip() for p in s.split(",")]
        rule_type = parts[0].upper()
        emit: list[str] = []  # 本次迭代要写入 rules_out 的行

        if rule_type in CLASH_UNSUPPORTED_RULE_TYPES:
            print(f"  [SKIP rule] 不支持类型: {s}")
            _h_skip()
            continue

        if rule_type == "FINAL":
            policy = parts[1] if len(parts) > 1 else "🔰 Proxy"
            emit.append(f"  - MATCH,{policy}")

        elif rule_type in PASSTHROUGH:
            # Surge 专用丢包保护（0.0.0.0/32），Clash 无对应机制
            if rule_type in ("IP-CIDR", "IP-CIDR6") and len(parts) > 1 and parts[1] == "0.0.0.0/32":
                _h_skip()
                continue
            keep = [p for p in parts if p not in _SURGE_FLAGS]
            emit.append("  - " + ",".join(keep))

        elif rule_type not in ("RULE-SET", "DOMAIN-SET"):
            keep = [p for p in parts if p not in _SURGE_FLAGS]
            emit.append("  - " + ",".join(keep))

        else:
            # RULE-SET / DOMAIN-SET
            if len(parts) < 3:
                print(f"  [WARN] 解析失败（字段不足）: {s}")
                _h_skip()
                continue

            url_or_builtin, policy = parts[1], parts[2]

            if not url_or_builtin.startswith("http"):
                # 内置规则集
                if url_or_builtin not in builtin_maps:
                    print(f"  [SKIP rule] 内置规则集无映射: {url_or_builtin}")
                    _h_skip()
                    continue
                clash_url = builtin_maps[url_or_builtin]
                pname = register(clash_url, _behavior_from_url(clash_url))
                if skip := _should_skip([url_or_builtin, clash_url, pname, policy], skips):
                    print(f"  [SKIP rule] skip={skip}: {url_or_builtin} -> {policy}")
                    providers.pop(clash_url, None)
                    seen.pop(pname, None)
                    _h_skip()
                    continue
                emit.append(f"  - RULE-SET,{pname},{policy}")

            else:
                # 外部 URL
                if skip := _should_skip([url_or_builtin, policy], skips):
                    print(f"  [SKIP rule] skip={skip}: {url_or_builtin}")
                    _h_skip()
                    continue

                clash_url = map_surge_url(url_or_builtin, url_maps)
                if clash_url is None:
                    print(f"  [WARN] 无 Clash URL 映射，跳过: {url_or_builtin}")
                    _h_skip()
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
                    _h_skip()
                    continue

                emit.append(f"  - RULE-SET,{pname},{policy}")

        # 规则会被输出：先刷缓冲注释，再写规则行
        _h_flush()
        rules_out.extend(emit)

    # rule-providers
    rp_lines = [
        "# 关于 Rule Provider 请查阅：https://wiki.metacubex.one/en/config/rule-providers/",
        "",
        "rule-providers:",
        "# name: # Provider 名称",
        "#   type: http # http 或 file",
        "#   behavior: classical # 或 ipcidr、domain",
        "#   path: # 文件路径",
        "#   url: # 只有当类型为 HTTP 时才可用，您不需要在本地空间中创建新文件。",
        "#   interval: # 自动更新间隔，仅在类型为 HTTP 时可用",
    ]
    for clash_url, info in providers.items():
        pname, behavior = info["name"], info["behavior"]
        rp_lines += [
            f"  {pname}:",
            "    type: http",
            f"    behavior: {behavior}",
            f"    path: ./Provider/RuleSet/{pname.replace(' ', '_')}.yaml",
            f"    url: {clash_url}",
            "    interval: 86400",
            "",
        ]

    # 注入 Builtin rules（按锚点插入，否则追加到 MATCH 之前）
    if rules_inject and rules_inject.get("rules"):
        inject_lines = [
            f"  {r}" if r.startswith("#") else f"  - {r}"
            for r in rules_inject["rules"]
        ]
        anchor_r = (rules_inject.get("anchor") or "").lower()
        inserted = False
        if anchor_r:
            new_out: list[str] = []
            for rule in rules_out:
                new_out.append(rule)
                if not inserted and anchor_r in rule.lower():
                    new_out.extend(inject_lines)
                    inserted = True
            rules_out = new_out
        if not inserted:
            # 锚点未命中或无锚点：插到 MATCH 之前，没有 MATCH 则追加
            for i, rule in enumerate(rules_out):
                if "MATCH," in rule:
                    rules_out[i:i] = inject_lines
                    break
            else:
                rules_out.extend(inject_lines)

    # 在 # / # > 注释行前插入空行（# >> 子项不加），改善可读性
    formatted: list[str] = []
    for line in rules_out:
        s = line.strip()
        if (
            s.startswith("#")
            and not s.startswith("# >>")
            and formatted
            and formatted[-1] != ""
            and not formatted[-1].strip().startswith("#")
        ):
            formatted.append("")
        formatted.append(line)
    rules_out = formatted

    rules_block = ["# 规则", "rules:"] + rules_out
    return "\n".join(rp_lines) + "\n" + "\n".join(rules_block) + "\n"

# ---------------------------------------------------------------------------
# 生成 Loon [Proxy Group]
# ---------------------------------------------------------------------------

def _fmt_loon_group(
    name: str,
    gtype: str,
    params: dict[str, str],
    proxies: list[str],
    filter_map: dict[str, str],
) -> str | None:
    """格式化为 Loon Proxy Group 单行。返回 None 表示跳过该组。"""
    icon = params.get("icon-url", "")
    icon_part = f",img-url = {icon}" if icon else ""

    if gtype == "smart":
        fm_val = filter_map.get(name, "")
        if not fm_val:
            return None  # 无 FilterMap 映射，跳过
        parts = fm_val.split(",", 1)
        filter_name = parts[0].strip()
        extra = "," + parts[1].strip() if len(parts) > 1 else ""
        return f"{name} = url-test,{filter_name}{extra}{icon_part}"

    if params.get("include-all-proxies", "").lower() in ("true", "1"):
        # include-all-proxies → 使用 FilterMap 指定的 Remote Filter（默认 Sub-UN）
        fm_val = filter_map.get(name, "Sub-UN")
        filter_name = fm_val.split(",")[0].strip()
        return f"{name} = select,{filter_name}{icon_part}"

    if params.get("include-other-group", ""):
        return None  # Loon 不直接支持，由 builtin inject_names 或 FilterMap 覆盖

    if params.get("policy-path", ""):
        return None  # 由 Builtin inject_names 替换

    if proxies:
        proxy_str = ",".join(proxies)
        return f"{name} = select,{proxy_str}{icon_part}"

    return None


def gen_loon_proxy_groups(
    group_lines: list[str],
    skips: list[str],
    pg_inject: dict | None,
    filter_map: dict[str, str],
) -> str:
    """生成 Loon [Proxy Group] 段落。"""
    out: list[str] = ["[Proxy Group]"]
    inject_names: set[str] = pg_inject["names"] if pg_inject else set()
    injected = False
    pending_h: list[str | None] = [None, None, None]

    def _h_skip() -> None:
        for i in range(2, -1, -1):
            if pending_h[i] is not None:
                for j in range(i, 3):
                    pending_h[j] = None
                return

    def _h_flush() -> list[str]:
        result_h = []
        for i in range(3):
            if pending_h[i] is not None:
                result_h.append(pending_h[i])
                pending_h[i] = None
        return result_h

    # prepend_block（无 // 锚点的 Builtin 分组 → 插到最前）
    if pg_inject and pg_inject.get("prepend_block"):
        out.append(pg_inject["prepend_block"])

    for line in group_lines:
        if line.startswith("#"):
            lvl = 3 if line.startswith("# >>") else (2 if line.startswith("# >") else 1)
            idx = lvl - 1
            pending_h[idx] = line
            for i in range(idx + 1, 3):
                pending_h[i] = None
            continue
        g = parse_group_line(line)
        if g is None:
            _h_skip()
            continue
        name = g["name"]

        if name in inject_names:
            _h_skip()
            continue
        if _is_skipped(name, skips):
            print(f"  [SKIP Loon group] {name}")
            _h_skip()
            continue

        loon_line = _fmt_loon_group(name, g["type"], g["params"], g["proxies"], filter_map)
        if loon_line is None:
            _h_skip()
            continue

        out.extend(_h_flush())
        out.append(loon_line)

        # 锚点注入
        if pg_inject and not injected and pg_inject.get("anchor") == name:
            out.append(pg_inject["block"])
            injected = True

    if pg_inject and not injected and pg_inject.get("block"):
        out.append(pg_inject["block"])

    return "\n".join(out)


# ---------------------------------------------------------------------------
# 生成 Loon [Remote Rule]
# ---------------------------------------------------------------------------

def _derive_tag(url: str) -> str:
    """从 URL 文件名派生 Loon Remote Rule tag。"""
    filename = url.rstrip("/").rsplit("/", 1)[-1]
    for ext in (".list", ".txt", ".yaml", ".yml", ".conf"):
        if filename.endswith(ext):
            filename = filename[: -len(ext)]
            break
    return filename.replace("%20", " ")


def gen_loon_remote_rules(
    rule_lines: list[str],
    skips: list[str],
) -> str:
    """生成 Loon [Remote Rule] 段落。

    Loon 原生支持 Surge .list 格式，URL 直接复用无需转换。
    """
    out: list[str] = ["[Remote Rule]"]
    pending_h: list[str | None] = [None, None, None]

    def _h_skip() -> None:
        for i in range(2, -1, -1):
            if pending_h[i] is not None:
                for j in range(i, 3):
                    pending_h[j] = None
                return

    def _h_flush() -> None:
        for i in range(3):
            if pending_h[i] is not None:
                out.append(pending_h[i])
                pending_h[i] = None

    for line in rule_lines:
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            inner_type = s.lstrip("#").strip().split(",")[0].strip().upper()
            if inner_type not in _COMMENT_DROP_TYPES:
                lvl = 3 if s.startswith("# >>") else (2 if s.startswith("# >") else 1)
                idx = lvl - 1
                pending_h[idx] = s
                for i in range(idx + 1, 3):
                    pending_h[i] = None
            continue

        parts = [p.strip() for p in s.split(",")]
        rule_type = parts[0].upper()

        if rule_type not in ("RULE-SET", "DOMAIN-SET"):
            _h_skip()
            continue
        if len(parts) < 3:
            _h_skip()
            continue

        url, policy = parts[1], parts[2]
        if not url.startswith("http"):
            _h_skip()
            continue  # 内置规则集（LAN 等）跳过

        if _should_skip([url, policy], skips):
            print(f"  [SKIP Loon remote rule] {url}")
            _h_skip()
            continue

        tag = _derive_tag(url)
        _h_flush()
        out.append(f"{url}, policy={policy}, tag={tag}, enabled=true")

    return "\n".join(out)


# ---------------------------------------------------------------------------
# 主函数
# ---------------------------------------------------------------------------

def main() -> None:
    config = parse_sync_txt()

    surge_src = config.get("Surge", {}).get("source")
    if not surge_src:
        raise ValueError("Surge 块缺少 >> 源文件路径指令")

    _, group_lines, rule_lines = parse_surge_profile(REPO_ROOT / surge_src)
    print(f"  Surge: {len(group_lines)} groups, {len(rule_lines)} rules")

    # ── Clash ──────────────────────────────────────────────────────────────
    clash = config.get("Clash", {})
    if clash.get("output"):
        print("\n── sync-config: Surge Profile → Clash Sample.yaml ──")
        clash_out = clash["output"]
        skips = config.get("global_skips", []) + clash.get("skips", [])
        url_maps = clash.get("url_maps", [])
        builtin_maps = clash.get("builtin_rule_maps", {})
        pp_block = clash.get("proxy_providers", "")
        pg_inject = clash.get("pg_inject")
        rules_inject = clash.get("rules_inject")
        rename_map = clash.get("rename_map", {})
        provider_urls = _parse_provider_urls(pp_block) if pp_block else {}
        inc = clash.get("include_file")

        print(f"  映射: {len(url_maps)} 条 URL 规则 | skip: {skips}")
        if pg_inject:
            print(f"  pg_inject: anchor={pg_inject['anchor']} | names={pg_inject['names']}")
        if rules_inject:
            print(f"  rules_inject: anchor={rules_inject['anchor']} | {len(rules_inject['rules'])} rules")

        groups_yaml = gen_proxy_groups(group_lines, skips, pg_inject, provider_urls)
        rp_rules_yaml = gen_rules_and_providers(rule_lines, skips, url_maps, builtin_maps, rules_inject, rename_map)

        parts = []
        if inc:
            parts.append((REPO_ROOT / inc).read_text(encoding="utf-8").rstrip())
        if pp_block:
            parts.append(pp_block)
        parts += [groups_yaml, rp_rules_yaml]

        changed = write_if_changed(REPO_ROOT / clash_out, "\n\n".join(parts) + "\n")
        print(f"  {'✓ ' + clash_out + ' 已更新' if changed else '✓ ' + clash_out + ' 无变化'}")

    # ── Loon ───────────────────────────────────────────────────────────────
    loon = config.get("Loon", {})
    if loon.get("output"):
        print("\n── sync-config: Surge Profile → Loon Balloon.lcf ──")
        loon_out_path = loon["output"]
        loon_inc = loon.get("include_file")
        if loon_inc:
            loon_header = (REPO_ROOT / loon_inc).read_text(encoding="utf-8").rstrip()
        else:
            loon_header = loon.get("loon_header", "")
        loon_pg_inject = loon.get("pg_inject_loon")
        loon_blocks = loon.get("loon_blocks", {})
        loon_rule_block = loon_blocks.get("Rule", "")
        loon_plugin_block = loon_blocks.get("Plugin", "")
        loon_mitm_block = loon_blocks.get("Mitm", "")
        filter_map = loon.get("filter_map", {})
        loon_skips = config.get("global_skips", []) + loon.get("skips", [])

        print(f"  FilterMap: {list(filter_map.keys())}")
        print(f"  Loon skip: {loon_skips}")
        if loon_pg_inject:
            print(f"  loon pg_inject: anchor={loon_pg_inject.get('anchor')} | names={loon_pg_inject.get('names')}")

        pg_loon = gen_loon_proxy_groups(group_lines, loon_skips, loon_pg_inject, filter_map)
        remote_rules = gen_loon_remote_rules(rule_lines, loon_skips)

        loon_parts = [loon_header, pg_loon]
        if loon_rule_block:
            loon_parts.append("[Rule]\n" + loon_rule_block)
        loon_parts.append(remote_rules)
        if loon_plugin_block:
            loon_parts.append("[Plugin]\n" + loon_plugin_block)
        if loon_mitm_block:
            loon_parts.append("[Mitm]\n" + loon_mitm_block)

        changed = write_if_changed(REPO_ROOT / loon_out_path, "\n\n".join(loon_parts) + "\n")
        print(f"  {'✓ ' + loon_out_path + ' 已更新' if changed else '✓ ' + loon_out_path + ' 无变化'}")


if __name__ == "__main__":
    main()
