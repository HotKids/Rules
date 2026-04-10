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
from pathlib import Path

# ---------------------------------------------------------------------------
# 路径配置
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SYNC_CONFIG_TXT = REPO_ROOT / ".github" / "scripts" / "sync-config.txt"

HOTKIDS_SURGE_PREFIX = "https://raw.githubusercontent.com/HotKids/Rules/master/Surge/RULE-SET/"
HOTKIDS_CLASH_PREFIX = "https://raw.githubusercontent.com/HotKids/Rules/master/Clash/RuleSet/"
HOTKIDS_QX_FILTER_PREFIX = "https://raw.githubusercontent.com/HotKids/Rules/master/Quantumult/X/Filter/"

CLASH_UNSUPPORTED_RULE_TYPES = {"PROTOCOL", "URL-REGEX", "USER-AGENT"}
# 注释掉的规则中，这些类型在 Clash 里同样不支持，直接丢弃（不入待输出缓冲区）
_COMMENT_DROP_TYPES = CLASH_UNSUPPORTED_RULE_TYPES | {"AND", "OR", "NOT"}
_SURGE_FLAGS = {"extended-matching", "force-remote-dns", "no-alert"}
RAW_PREFIX = "https://raw.githubusercontent.com/"

# Surfboard 不支持的规则类型（Android 无 MITM，无 IPv6 实现）
SURFBOARD_UNSUPPORTED_RULE_TYPES = {"URL-REGEX", "USER-AGENT"}
# Surfboard（Android）不适用的 Surge iOS/macOS 专属 General key
# Surge 内建动作名（proxy value 为这些时视为 action proxy）
_SURGE_BUILTIN_ACTIONS = frozenset({"direct", "reject", "reject-tinygif", "reject-drop", "reject-no-drop"})
# Surfboard 支持的内建动作（无 MITM，不支持 TINYGIF/DROP）
_SURFBOARD_SUPPORTED_ACTIONS = frozenset({"direct", "reject"})
# Loon 支持的内建动作及其值映射（Surge lowercase → Loon format）
_LOON_SUPPORTED_ACTIONS = frozenset({"direct", "reject"})
_LOON_ACTION_VALUE_MAP = {"direct": "DIRECT", "reject": "REJECT",
                          "reject-tinygif": "REJECT", "reject-drop": "REJECT-DROP", "reject-no-drop": "REJECT"}
_CLASH_SUPPORTED_ACTIONS = frozenset({"direct", "reject"})


def _filter_proxy_lines_for_platform(proxy_lines: list[str], supported_actions: frozenset) -> list[str]:
    """过滤 proxy_lines，移除该平台不支持的 action proxy 行（保留所有非 action 行）。"""
    result = []
    for line in proxy_lines:
        if "=" not in line:
            result.append(line)
            continue
        _, _, val = line.partition("=")
        surge_val = val.strip().lower()
        if surge_val in _SURGE_BUILTIN_ACTIONS and surge_val not in supported_actions:
            continue  # 该 action 不被支持，跳过
        result.append(line)
    return result


def _gen_loon_proxy_section(proxy_lines: list[str]) -> str:
    """从 Surge proxy_lines 生成 Loon [Proxy] 段落（仅 action proxies，值转换为 Loon 格式）。"""
    entries: list[str] = []
    for line in proxy_lines:
        if "=" not in line:
            continue
        name, _, val = line.partition("=")
        surge_val = val.strip().lower()
        if surge_val not in _LOON_SUPPORTED_ACTIONS:
            continue
        loon_val = _LOON_ACTION_VALUE_MAP.get(surge_val, surge_val.upper())
        entries.append(f"{name.strip()} = {loon_val}")
    return "[Proxy]\n" + "\n".join(entries) if entries else ""


def _gen_clash_action_wrapper_groups(proxy_lines: list[str]) -> tuple[list[str], str]:
    """从 Surge proxy_lines 生成 Clash hidden action wrapper groups（无 icon）。

    返回：
      proxy_names  list[str]  按 proxy_lines 顺序的 emoji 名称
      wrapper_yaml str        追加到 pg_inject["block"] 的 YAML 文本
    """
    proxy_names: list[str] = []
    wrapper_blocks: list[str] = []
    for line in proxy_lines:
        if "=" not in line:
            continue
        name, _, val = line.partition("=")
        name = name.strip()
        surge_val = val.strip().lower()
        if surge_val not in _CLASH_SUPPORTED_ACTIONS:
            continue
        clash_val = surge_val.upper()       # reject → REJECT, direct → DIRECT
        comment = strip_emoji(name)         # ⛔️ REJECT → REJECT, 🔘 DIRECT → DIRECT
        proxy_names.append(name)
        wrapper_blocks.append(
            f"  # {comment}\n"
            f'  - name: "{name}"\n'
            f"    type: select\n"
            f"    hidden: true\n"
            f"    proxies:\n"
            f"      - {clash_val}"
        )
    return proxy_names, "\n\n".join(wrapper_blocks)


SURFBOARD_SKIP_GENERAL_KEYS = {
    "wifi-assist", "allow-wifi-access", "wifi-access-http-port", "wifi-access-socks5-port",
    "http-listen", "socks5-listen",
    "external-controller-access", "http-api", "http-api-tls", "http-api-web-dashboard",
}

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


def _process_builtin_loon(lines: list[str]) -> tuple[str, dict | None, str, str, str, str, str, str, dict]:
    """从 Loon Builtin 内容解析头部和各段落块。

    返回：
      loon_header     str        [Proxy Group] 之前的所有内容（含 [Remote Filter] 等静态段落）
      pg_inject_loon  dict|None  {anchor, block, names, prepend_block}
      rule_block      str        [Rule] 内容（不含段落标题）
      plugin_block    str        [Plugin] 内容（不含段落标题）
      mitm_block      str        [Mitm] 内容（不含段落标题，通常由 Surge 覆盖）
      host_block      str        [Host] 内容（不含段落标题）
      rewrite_block   str        [Rewrite] 内容（不含段落标题）
      script_block    str        [Script] 内容（不含段落标题）
      filter_defs     dict       {filter_name: filterkey_regex}（从 [Remote Filter] 扫描）
    """
    header_lines: list[str] = []
    pg_lines: list[str] = []
    rule_lines: list[str] = []
    plugin_lines: list[str] = []
    mitm_lines: list[str] = []
    host_lines: list[str] = []
    rewrite_lines: list[str] = []
    script_lines: list[str] = []
    mode = "header"  # header | pg | Rule | RemoteRule | Host | Rewrite | Script | Plugin | Mitm

    for line in lines:
        s = line.strip()
        if s in ("proxy-groups:", "[Proxy Group]"):
            mode = "pg"
            continue
        if s == "[Rule]":
            mode = "Rule"
            continue
        if s == "[Remote Rule]":
            mode = "RemoteRule"  # 内容由 Surge 生成，忽略 ini 中的占位内容
            continue
        if s == "[Host]":
            mode = "Host"
            continue
        if s == "[Rewrite]":
            mode = "Rewrite"
            continue
        if s == "[Script]":
            mode = "Script"
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
        elif mode == "Host":
            host_lines.append(line)
        elif mode == "Rewrite":
            rewrite_lines.append(line)
        elif mode == "Script":
            script_lines.append(line)
        elif mode == "Plugin":
            plugin_lines.append(line)
        elif mode == "Mitm":
            mitm_lines.append(line)
        # RemoteRule: 忽略（由 Surge 生成）
        # [Remote Filter] 留在 header_lines，同时用于解析 filter_defs

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
    host_block = "\n".join(l.rstrip() for l in host_lines).strip()
    rewrite_block = "\n".join(l.rstrip() for l in rewrite_lines).strip()
    script_block = "\n".join(l.rstrip() for l in script_lines).strip()

    # 从 header_lines 扫描 [Remote Filter] 段落 → {filter_name: filterkey_regex}（catch-all 排末尾）
    filter_defs: dict[str, str] = {}
    catchalls: dict[str, str] = {}
    in_rf = False
    for l in header_lines:
        s = l.strip()
        if s == "[Remote Filter]":
            in_rf = True
            continue
        if s.startswith("[") and s.endswith("]"):
            in_rf = False
            continue
        if not in_rf or not s or s.startswith("#"):
            continue
        m = re.match(r'^(\S+)\s*=\s*NameRegex,\s*FilterKey\s*=\s*"(.+)"', s)
        if m:
            fname, pattern = m.group(1), m.group(2)
            # catch-all：positive lookahead 仅为 (?=.+)，无 (?i) 关键词
            if re.match(r'^\^\(\?=\.\+\)', pattern):
                catchalls[fname] = pattern
            else:
                filter_defs[fname] = pattern
    filter_defs.update(catchalls)  # catch-all 排到最后

    return loon_header, pg_inject_loon, rule_block, plugin_block, mitm_block, host_block, rewrite_block, script_block, filter_defs


def _process_builtin_qx(lines: list[str]) -> tuple[str, dict | None, dict]:
    """从 QX Builtin 内容解析头部和各段落块。

    返回：
      qx_header      str        [general]+[dns] 内容（[policy] 前）
      pg_inject_qx   dict|None  {anchor, block, names, prepend_block}
      qx_blocks      dict       各静态段落文本 {server_remote, filter_remote,
                                  rewrite_remote, task_local, http_backend,
                                  server_local, filter_local, rewrite_local, mitm}
    """
    _BLOCK_KEYS = (
        "server_remote", "filter_remote", "rewrite_remote", "task_local",
        "http_backend", "server_local", "filter_local", "rewrite_local", "mitm",
    )
    _SECTION_MODE: dict[str, str] = {
        "[policy]": "pg",
        "[server_remote]": "server_remote",
        "[filter_remote]": "filter_remote",
        "[rewrite_remote]": "rewrite_remote",
        "[task_local]": "task_local",
        "[http_backend]": "http_backend",
        "[server_local]": "server_local",
        "[filter_local]": "filter_local",
        "[rewrite_local]": "rewrite_local",
        "[mitm]": "mitm",
        "[MITM]": "mitm",
    }

    header_lines: list[str] = []
    pg_lines: list[str] = []
    block_lines: dict[str, list[str]] = {k: [] for k in _BLOCK_KEYS}
    mode = "header"

    for line in lines:
        s = line.strip()
        if s in _SECTION_MODE:
            mode = _SECTION_MODE[s]
            continue
        if mode == "header":
            header_lines.append(line)
        elif mode == "pg":
            pg_lines.append(line)
        elif mode in block_lines:
            block_lines[mode].append(line)

    qx_header = "\n".join(l.rstrip() for l in header_lines).strip()

    # [policy] 注入解析（与 _process_builtin_loon 相同逻辑）
    pg_inject_qx: dict | None = None
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

        # QX format: "static=Name, ..." / "url-latency-benchmark=Name, ..."
        # Name is the part AFTER the first "=", before the first ","
        names: set[str] = set()
        for line in pg_lines:
            s = line.strip()
            if s and not s.startswith("#") and "=" in s:
                after_eq = s.split("=", 1)[1]
                name = after_eq.split(",")[0].strip()
                if name:
                    names.add(name)

        pg_inject_qx = {
            "anchor": anchor,
            "block": "\n".join(post_lines).strip(),
            "names": names,
            "prepend_block": "\n".join(pre_lines).strip() or None,
        }

    qx_blocks = {
        k: "\n".join(l.rstrip() for l in v).strip()
        for k, v in block_lines.items()
    }
    return qx_header, pg_inject_qx, qx_blocks


def _process_builtin_surfboard(lines: list[str]) -> dict | None:
    """从 Surfboard builtin INI（Surge 格式）解析 [Proxy Group] 注入配置。

    返回 pg_inject 字典 {anchor, block, names, prepend_block}，或 None。
    """
    pg_lines: list[str] = []
    in_pg = False

    for line in lines:
        s = line.strip()
        if s == "[Proxy Group]":
            in_pg = True
            continue
        if s.startswith("[") and s.endswith("]"):
            in_pg = False
            continue
        if in_pg:
            pg_lines.append(line)

    if not pg_lines:
        return None

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

    # 从 Surge 格式行（Name = type, ...）提取 names
    names: set[str] = set()
    for line in pg_lines:
        s = line.strip()
        if s and not s.startswith("#") and "=" in s:
            name = s.split("=")[0].strip()
            if name:
                names.add(name)

    return {
        "anchor": anchor,
        "block": "\n".join(post_lines).strip(),
        "names": names,
        "prepend_block": "\n".join(pre_lines).strip() or None,
    }


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
        "filter_defs": {},
        "pg_inject_loon": None,
        "loon_blocks": {},
        "qx_header": "",
        "qx_blocks": {},
        "pg_inject_qx": None,
        "policy_rename_map": {},
        "pg_inject_surfboard": None,
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
    _rename_sub = ""
    builtin_buf: list[str] = []

    def flush_builtin() -> None:
        if current_section == "Builtin" and current_platform and current_platform != "Surge":
            plat = result.setdefault(current_platform, _empty_plat())
            if current_platform == "Loon":
                hdr, pg_inj, rule_blk, plugin_blk, mitm_blk, host_blk, rewrite_blk, script_blk, fdefs = _process_builtin_loon(builtin_buf)
                plat["loon_header"] = hdr
                plat["pg_inject_loon"] = pg_inj
                plat["filter_defs"] = fdefs
                plat["loon_blocks"] = {
                    "Rule": rule_blk, "Plugin": plugin_blk, "Mitm": mitm_blk,
                    "Host": host_blk, "Rewrite": rewrite_blk, "Script": script_blk,
                }
            elif current_platform == "Quantumult X":
                qx_hdr, pg_inj_qx, qx_blks = _process_builtin_qx(builtin_buf)
                plat["qx_header"] = qx_hdr
                plat["pg_inject_qx"] = pg_inj_qx
                plat["qx_blocks"] = qx_blks
            elif current_platform == "Surfboard":
                plat["pg_inject_surfboard"] = _process_builtin_surfboard(builtin_buf)
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
            _rename_sub = ""
            if current_platform != "Surge":
                result.setdefault(current_platform, _empty_plat())
            continue

        # 子分区：# > SubSection
        m = re.match(r"^#\s+>\s+(.+)$", stripped)
        if m:
            flush_builtin()
            current_section = m.group(1).strip()
            _rename_sub = ""
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
            # 子分区标题行（如 [policy] 或 [filter_remote]）
            m_sub = re.match(r"^\[(.+)\]$", stripped)
            if m_sub:
                _rename_sub = m_sub.group(1)
                continue
            if "=>" not in stripped:
                continue  # 跳过 "rule-providers:" 等标题行
            left, _, right = stripped.partition("=>")
            left, right = left.strip(), right.strip()
            if left and right:
                plat = result.setdefault(current_platform, _empty_plat())
                if _rename_sub == "policy":
                    plat["policy_rename_map"][left] = right
                else:
                    plat["rename_map"][left] = right
        elif current_section == "FilterMap" and current_platform and current_platform != "Surge":
            if "=>" not in stripped:
                continue
            left, _, right = stripped.partition("=>")
            left, right = left.strip(), right.strip()
            if left:
                result.setdefault(current_platform, _empty_plat())["filter_map"][left] = right
        elif current_section == "Options" and current_platform and current_platform != "Surge":
            pass  # reserved for future options

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

def parse_surge_profile(profile_path: Path) -> tuple[list[str], list[str], list[str], list[str], list[str]]:
    """读取 Surge Profile.conf，返回 proxy_lines, group_lines, rule_lines, mitm_lines, general_lines。"""
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
        clean(sections.get("MITM", [])),
        sections.get("General", []),  # raw lines，含注释，不经 clean() 处理
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


class PendingHeaders:
    """三级注释缓冲（# / # > / # >>），用于各 gen_* 函数中的注释懒刷逻辑。"""

    __slots__ = ("_h",)

    def __init__(self) -> None:
        self._h: list[str | None] = [None, None, None]

    def push(self, line: str, lvl: int) -> None:
        idx = lvl - 1
        self._h[idx] = line
        for i in range(idx + 1, 3):
            self._h[i] = None

    def skip(self) -> None:
        for i in range(2, -1, -1):
            if self._h[i] is not None:
                for j in range(i, 3):
                    self._h[j] = None
                return

    def flush(self) -> list[str]:
        out = [h for h in self._h if h is not None]
        self._h = [None, None, None]
        return out


def gen_proxy_groups(
    group_lines: list[str],
    skips: list[str],
    pg_inject: dict | None,
    provider_urls: dict[str, str] | None = None,
    adblock_proxy_lines: list[str] | None = None,
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
    ph = PendingHeaders()

    # prepend_block：Builtin 中无 // 锚点的分组 → 插到最前
    if pg_inject and pg_inject.get("prepend_block"):
        out.append(pg_inject["prepend_block"])
        out.append("")

    for line in group_lines:
        if line.startswith("#"):
            lvl = 3 if line.startswith("# >>") else (2 if line.startswith("# >") else 1)
            ph.push(f"  {line}", lvl)
            continue
        g = parse_group_line(line)
        if g is None:
            ph.skip()
            continue
        name = g["name"]

        if name in inject_names:
            ph.skip()
            continue
        if _is_skipped(name, skips):
            print(f"  [SKIP group] {name}")
            ph.skip()
            continue

        # select + policy-path + no explicit proxies → adblock group
        if (g["type"] == "select" and "policy-path" in g["params"]
                and not g["proxies"] and adblock_proxy_lines is not None):
            clash_action_names, wrapper_yaml = _gen_clash_action_wrapper_groups(adblock_proxy_lines)
            if clash_action_names:
                icon = g["params"].get("icon-url", "")
                icon_line = f"\n    icon: {icon}" if icon else ""
                proxy_list = "\n".join(f"      - {n}" for n in clash_action_names)
                out.extend(ph.flush())
                out.append(
                    f'  - name: "{name}"\n'
                    f"    type: select{icon_line}\n"
                    f"    proxies:\n{proxy_list}"
                )
                out.append("")
                if wrapper_yaml:
                    out.append(wrapper_yaml)
                    out.append("")
            else:
                ph.skip()
            continue

        out.extend(ph.flush())
        out.extend(_fmt_group(name, g["type"], g["params"], g["proxies"], provider_urls))
        out.append("")

        if pg_inject and not injected and pg_inject["anchor"] == name:
            out.append(pg_inject["block"])
            out.append("")
            injected = True

    if pg_inject and not injected and pg_inject.get("block"):
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
    providers: dict[str, dict] = {}
    seen: dict[str, str] = {}  # provider_name → url
    rules_out: list[str] = []
    ph = PendingHeaders()

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
                ph.push(f"  {s}", lvl)
            continue

        parts = [p.strip() for p in s.split(",")]
        rule_type = parts[0].upper()
        emit: list[str] = []  # 本次迭代要写入 rules_out 的行

        if rule_type in CLASH_UNSUPPORTED_RULE_TYPES:
            print(f"  [SKIP rule] 不支持类型: {s}")
            ph.skip()
            continue

        if rule_type == "FINAL":
            policy = parts[1] if len(parts) > 1 else "🔰 Proxy"
            emit.append(f"  - MATCH,{policy}")

        elif rule_type in PASSTHROUGH:
            # Surge 专用丢包保护（0.0.0.0/32），Clash 无对应机制
            if rule_type in ("IP-CIDR", "IP-CIDR6") and len(parts) > 1 and parts[1] == "0.0.0.0/32":
                ph.skip()
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
                ph.skip()
                continue

            url_or_builtin, policy = parts[1], parts[2]

            if not url_or_builtin.startswith("http"):
                # 内置规则集
                if url_or_builtin not in builtin_maps:
                    print(f"  [SKIP rule] 内置规则集无映射: {url_or_builtin}")
                    ph.skip()
                    continue
                clash_url = builtin_maps[url_or_builtin]
                pname = register(clash_url, _behavior_from_url(clash_url))
                if skip := _should_skip([url_or_builtin, clash_url, pname, policy], skips):
                    print(f"  [SKIP rule] skip={skip}: {url_or_builtin} -> {policy}")
                    providers.pop(clash_url, None)
                    seen.pop(pname, None)
                    ph.skip()
                    continue
                emit.append(f"  - RULE-SET,{pname},{policy}")

            else:
                # 外部 URL
                if skip := _should_skip([url_or_builtin, policy], skips):
                    print(f"  [SKIP rule] skip={skip}: {url_or_builtin}")
                    ph.skip()
                    continue

                clash_url = map_surge_url(url_or_builtin, url_maps)
                if clash_url is None:
                    print(f"  [WARN] 无 Clash URL 映射，跳过: {url_or_builtin}")
                    ph.skip()
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
                    ph.skip()
                    continue

                emit.append(f"  - RULE-SET,{pname},{policy}")

        # 规则会被输出：先刷缓冲注释，再写规则行
        rules_out.extend(ph.flush())
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
    adblock_proxy_lines: list[str] | None = None,
) -> str:
    """生成 Loon [Proxy Group] 段落。"""
    out: list[str] = ["[Proxy Group]"]
    inject_names: set[str] = pg_inject["names"] if pg_inject else set()
    injected = False
    ph = PendingHeaders()

    # prepend_block（无 // 锚点的 Builtin 分组 → 插到最前）
    if pg_inject and pg_inject.get("prepend_block"):
        out.append(pg_inject["prepend_block"])

    for line in group_lines:
        if line.startswith("#"):
            lvl = 3 if line.startswith("# >>") else (2 if line.startswith("# >") else 1)
            ph.push(line, lvl)
            continue
        g = parse_group_line(line)
        if g is None:
            ph.skip()
            continue
        name = g["name"]

        if name in inject_names:
            ph.skip()
            continue
        if _is_skipped(name, skips):
            print(f"  [SKIP Loon group] {name}")
            ph.skip()
            continue

        # select + policy-path + no explicit proxies → adblock group
        if (g["type"] == "select" and "policy-path" in g["params"]
                and not g["proxies"] and adblock_proxy_lines is not None):
            loon_names = [
                pl.partition("=")[0].strip()
                for pl in adblock_proxy_lines
                if "=" in pl and pl.partition("=")[2].strip().lower() in _LOON_SUPPORTED_ACTIONS
            ]
            if loon_names:
                icon = g["params"].get("icon-url", "")
                icon_part = f",img-url = {icon}" if icon else ""
                out.extend(ph.flush())
                out.append(f"{name} = select,{','.join(loon_names)}{icon_part}")
            else:
                ph.skip()
            continue

        loon_line = _fmt_loon_group(name, g["type"], g["params"], g["proxies"], filter_map)
        if loon_line is None:
            ph.skip()
            continue

        out.extend(ph.flush())
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
    rename_map: dict[str, str] | None = None,
) -> str:
    """生成 Loon [Remote Rule] 段落。

    Loon 原生支持 Surge .list 格式，URL 直接复用无需转换。
    """
    out: list[str] = ["[Remote Rule]"]
    ph = PendingHeaders()

    for line in rule_lines:
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            inner_type = s.lstrip("#").strip().split(",")[0].strip().upper()
            if inner_type not in _COMMENT_DROP_TYPES:
                lvl = 3 if s.startswith("# >>") else (2 if s.startswith("# >") else 1)
                ph.push(s, lvl)
            continue

        parts = [p.strip() for p in s.split(",")]
        rule_type = parts[0].upper()

        if rule_type not in ("RULE-SET", "DOMAIN-SET"):
            ph.skip()
            continue
        if len(parts) < 3:
            ph.skip()
            continue

        url, policy = parts[1], parts[2]
        if not url.startswith("http"):
            ph.skip()
            continue  # 内置规则集（LAN 等）跳过

        if _should_skip([url, policy], skips):
            print(f"  [SKIP Loon remote rule] {url}")
            ph.skip()
            continue

        tag = _derive_tag(url)
        if rename_map:
            tag = rename_map.get(tag, tag)
        out.extend(ph.flush())
        out.append(f"{url}, policy={policy}, tag={tag}, enabled=true")

    return "\n".join(out)


# ---------------------------------------------------------------------------
# 生成 QX [policy]
# ---------------------------------------------------------------------------

_QX_PROXY_MAP = {"🚫 REJECT": "reject", "🔘 DIRECT": "direct"}


def _qx_normalize_text(text: str, policy_rename: dict[str, str] | None = None) -> str:
    """Strip emoji and apply policy renames in QX config text blocks.

    Handles:
      static=🚧 AdGuard, reject, direct, img-url=...
      force-policy=🚧 AdGuard  (within filter_remote lines)
      final, 🔰 Proxy
    """
    def _apply(name: str) -> str:
        s = strip_emoji(name)
        return policy_rename.get(s, s) if policy_rename else s

    result = []
    for line in text.splitlines():
        s = line.strip()
        m = re.match(
            r"^((?:static|url-latency-benchmark|available|round-robin|dest-hash)=)(.*)", s
        )
        if m:
            kind, rest = m.group(1), m.group(2)
            parts = [p.strip() for p in rest.split(",")]
            out_parts = [_apply(p) if "=" not in p else p for p in parts]
            result.append(kind + ", ".join(out_parts))
        elif "force-policy=" in line:
            new_line = re.sub(
                r"(force-policy=)([^,]+)",
                lambda m2: m2.group(1) + _apply(m2.group(2).strip()),
                line,
            )
            result.append(new_line)
        elif s.startswith("final,"):
            result.append("final, " + _apply(s[6:].strip()))
        else:
            result.append(line)
    return "\n".join(result)


def _normalize_qx_comment(
    comment: str,
    strip_names: bool = True,
    policy_rename_map: dict[str, str] | None = None,
) -> str:
    """Apply strip_emoji and policy_rename_map to a QX policy group comment line."""
    if comment.startswith("# >> "):
        prefix, name = "# >> ", comment[5:]
    elif comment.startswith("# > "):
        prefix, name = "# > ", comment[4:]
    elif comment.startswith("# "):
        prefix, name = "# ", comment[2:]
    else:
        return comment
    name = name.rstrip()
    if strip_names:
        name = strip_emoji(name)
    if policy_rename_map:
        name = policy_rename_map.get(name, name)
    return prefix + name


def _fmt_qx_policy(
    name: str,
    gtype: str,
    params: dict[str, str],
    proxies: list[str],
    strip_names: bool = True,
    policy_rename_map: dict[str, str] | None = None,
    all_proxy_names: set[str] | None = None,
) -> str | None:
    """格式化为 QX policy 单行。返回 None 表示跳过该组。"""
    icon_part = ""
    if icon_url := params.get("icon-url", ""):
        icon_part = f", img-url={icon_url}"

    emit_name = strip_emoji(name) if strip_names else name
    if policy_rename_map:
        emit_name = policy_rename_map.get(emit_name, emit_name)

    # smart + policy-regex-filter → static with server-tag-regex（必须先于 include-other-group 检查）
    if gtype == "smart" and (regex := params.get("policy-regex-filter", "")):
        return f"static={emit_name}, server-tag-regex={regex}{icon_part}"

    # include-all-proxies / include-other-group / policy-path → 跳过
    if (
        params.get("include-all-proxies", "").lower() in ("true", "1")
        or "include-other-group" in params
        or "policy-path" in params
    ):
        return None

    # select with explicit proxies → static
    if proxies:
        mapped = [_QX_PROXY_MAP.get(p, p) for p in proxies]
        if strip_names:
            mapped = [strip_emoji(p) for p in mapped]
        if policy_rename_map:
            mapped = [policy_rename_map.get(p, p) for p in mapped]
        # include-all-proxies 组（如 Server）→ QX 内建 'proxy' 关键字
        if all_proxy_names:
            mapped = ["proxy" if p in all_proxy_names else p for p in mapped]
        return f"static={emit_name}, {', '.join(mapped)}{icon_part}"

    return None


def gen_qx_policies(
    group_lines: list[str],
    skips: list[str],
    pg_inject: dict | None,
    strip_names: bool = True,
    policy_rename_map: dict[str, str] | None = None,
) -> str:
    """生成 QX [policy] 段落。"""
    out: list[str] = ["[policy]"]
    inject_names: set[str] = pg_inject["names"] if pg_inject else set()
    injected = False
    ph = PendingHeaders()

    # 预扫描：识别 include-all-proxies 组（在 QX 中替换为内建 'proxy' 关键字）
    all_proxy_names: set[str] = set()
    for _line in group_lines:
        _g = parse_group_line(_line)
        if _g and _g["params"].get("include-all-proxies", "").lower() in ("true", "1"):
            _n = strip_emoji(_g["name"]) if strip_names else _g["name"]
            if policy_rename_map:
                _n = policy_rename_map.get(_n, _n)
            all_proxy_names.add(_n)
    all_proxy_names_arg = all_proxy_names or None

    if pg_inject and pg_inject.get("prepend_block"):
        prepend = _qx_normalize_text(pg_inject["prepend_block"], policy_rename_map) if strip_names else pg_inject["prepend_block"]
        out.append(prepend)

    for line in group_lines:
        if line.startswith("#"):
            lvl = 3 if line.startswith("# >>") else (2 if line.startswith("# >") else 1)
            normalized = _normalize_qx_comment(line, strip_names, policy_rename_map)
            ph.push(normalized, lvl)
            continue
        g = parse_group_line(line)
        if g is None:
            ph.skip()
            continue
        name = g["name"]

        # 计算最终输出名（strip + rename），用于 inject_names 和 anchor 比较
        emit_name = strip_emoji(name) if strip_names else name
        if policy_rename_map:
            emit_name = policy_rename_map.get(emit_name, emit_name)

        if emit_name in inject_names or name in inject_names:
            ph.skip()
            continue
        if _is_skipped(name, skips):
            print(f"  [SKIP QX policy] {name}")
            ph.skip()
            continue

        qx_line = _fmt_qx_policy(name, g["type"], g["params"], g["proxies"], strip_names, policy_rename_map, all_proxy_names_arg)
        if qx_line is None:
            ph.skip()
            continue

        out.extend(ph.flush())
        out.append(qx_line)

        # anchor 比较使用最终输出名（strip + rename 后）
        if pg_inject and not injected and pg_inject.get("anchor") == emit_name:
            block = _qx_normalize_text(pg_inject["block"], policy_rename_map) if strip_names else pg_inject["block"]
            out.append(block)
            injected = True

    if pg_inject and not injected and pg_inject.get("block"):
        block = _qx_normalize_text(pg_inject["block"], policy_rename_map) if strip_names else pg_inject["block"]
        out.append(block)

    return "\n".join(out)


# ---------------------------------------------------------------------------
# 生成 QX [filter_remote]
# ---------------------------------------------------------------------------

def _resolve_qx_url(surge_url: str, url_maps: list | None = None) -> tuple[str, str]:
    """将 Surge 规则 URL 解析为 QX URL 及对应 opt-parser 值。

    优先级：
    1. HotKids 自动映射：Surge/RULE-SET/<subdir>/<name>.list → Quantumult/X/Filter/<name>.list
       （本地文件存在时使用 QX 版本，opt-parser=false）
    2. 外部 URL 映射（url_maps），opt-parser=false
    3. 无匹配：保留 Surge URL，opt-parser=true
    """
    # 1. HotKids 自动映射
    if surge_url.startswith(HOTKIDS_SURGE_PREFIX):
        rest = surge_url[len(HOTKIDS_SURGE_PREFIX):]  # e.g. "Apple/Apple%20TV.list"
        basename = rest.rsplit("/", 1)[-1] if "/" in rest else rest  # e.g. "Apple%20TV.list"
        local_name = basename.replace("%20", " ")
        qx_local = REPO_ROOT / "Quantumult" / "X" / "Filter" / local_name
        if qx_local.exists():
            return HOTKIDS_QX_FILTER_PREFIX + basename, "false"

    # 2. 外部 URL 映射
    if url_maps:
        best_len = 0
        best_url: str | None = None
        for left, right in url_maps:
            if not left.startswith("http") or not right:
                continue
            if surge_url == left:
                return right, "false"
            if surge_url.startswith(left) and len(left) > best_len:
                best_len = len(left)
                best_url = right.rstrip("/") + "/" + surge_url[len(left):]
        if best_url:
            return best_url, "false"

    # 3. 保留 Surge URL，需要 opt-parser 解析
    return surge_url, "true"


def gen_qx_filter_remote(
    rule_lines: list[str],
    skips: list[str],
    rename_map: dict[str, str] | None = None,
    static_fr: str = "",
    strip_names: bool = True,
    policy_rename_map: dict[str, str] | None = None,
    url_maps: list | None = None,
) -> str:
    """生成 QX [filter_remote] 段落。

    static_fr 为 qx.ini 中的静态条目（流媒体等），prepend 到动态生成内容之前。
    """
    out: list[str] = ["[filter_remote]"]

    # 收集 static_fr 中已包含的 URL，避免动态生成重复条目
    static_urls: set[str] = set()
    if static_fr:
        fr_text = _qx_normalize_text(static_fr, policy_rename_map) if strip_names else static_fr
        for line in fr_text.splitlines():
            s = line.strip()
            if s and not s.startswith(";") and not s.startswith("#") and s.startswith("http"):
                static_urls.add(s.split(",", 1)[0].strip())
        for line in fr_text.splitlines():
            out.append(line)
        out.append("")

    ph = PendingHeaders()

    for line in rule_lines:
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            inner_type = s.lstrip("#").strip().split(",")[0].strip().upper()
            if inner_type not in _COMMENT_DROP_TYPES:
                lvl = 3 if s.startswith("# >>") else (2 if s.startswith("# >") else 1)
                ph.push(s, lvl)
            continue

        parts = [p.strip() for p in s.split(",")]
        rule_type = parts[0].upper()

        if rule_type not in ("RULE-SET", "DOMAIN-SET"):
            ph.skip()
            continue
        if len(parts) < 3:
            ph.skip()
            continue

        url, policy = parts[1], parts[2]
        if not url.startswith("http"):
            ph.skip()
            continue

        tag = _derive_tag(url)
        if _should_skip([url, policy, tag], skips):
            print(f"  [SKIP QX filter_remote] {url}")
            ph.skip()
            continue

        emit_url, opt_parser = _resolve_qx_url(url, url_maps)
        if emit_url in static_urls:
            ph.skip()
            continue

        if rename_map:
            tag = rename_map.get(tag, tag)
        # _QX_PROXY_MAP 优先（🔘 DIRECT→direct 等 QX 内建值），其余按 strip_names 处理
        stripped_policy = _QX_PROXY_MAP.get(policy, strip_emoji(policy) if strip_names else policy)
        emit_policy = policy_rename_map.get(stripped_policy, stripped_policy) if policy_rename_map else stripped_policy
        out.extend(ph.flush())
        out.append(
            f"{emit_url}, tag={tag}, force-policy={emit_policy}, "
            f"update-interval=86400, opt-parser={opt_parser}, enabled=true"
        )

    return "\n".join(out)


# ---------------------------------------------------------------------------
# 生成 QX [filter_local]
# ---------------------------------------------------------------------------

def gen_qx_filter_local(
    rule_lines: list[str],
    static_fl: str = "",
    strip_names: bool = True,
    policy_rename_map: dict[str, str] | None = None,
) -> str:
    """生成 QX [filter_local] 段落。

    static_fl 为 qx.ini 中的静态 LAN 规则（含 geoip, cn, direct），
    再从 Surge rule_lines 提取 GEOIP（非 CN）和 FINAL。
    """
    out: list[str] = ["[filter_local]"]
    if static_fl:
        for line in static_fl.splitlines():
            out.append(line)
        out.append("")

    final_line: str | None = None

    for line in rule_lines:
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        parts = [p.strip() for p in s.split(",")]
        rule_type = parts[0].upper()
        if rule_type == "GEOIP" and len(parts) >= 3:
            geoip_val = parts[1].lower()
            if geoip_val == "cn":
                continue  # 已在 static_fl 中
            policy = parts[2]
            out.append(f"geoip, {geoip_val}, {policy}")
        elif rule_type == "FINAL" and final_line is None:
            policy = parts[1] if len(parts) > 1 else "🔰 Proxy"
            stripped_policy = _QX_PROXY_MAP.get(policy, strip_emoji(policy) if strip_names else policy)
            emit_policy = policy_rename_map.get(stripped_policy, stripped_policy) if policy_rename_map else stripped_policy
            final_line = f"final, {emit_policy}"

    if final_line:
        out.append(final_line)

    return "\n".join(out)


# ---------------------------------------------------------------------------
# QX [mitm] 同步
# ---------------------------------------------------------------------------

def _sync_qx_mitm(mitm_block: str, surge_mitm_lines: list[str]) -> str:
    """将 Surge [MITM] 的 ca-passphrase / ca-p12 同步到 QX [mitm] 块。"""
    surge_passphrase = ""
    surge_p12 = ""
    for line in surge_mitm_lines:
        s = line.strip()
        if s.startswith("ca-passphrase") and "=" in s:
            surge_passphrase = s.split("=", 1)[1].strip()
        elif s.startswith("ca-p12") and "=" in s:
            surge_p12 = s.split("=", 1)[1].strip()

    result = []
    for line in mitm_block.splitlines():
        s = line.strip()
        if s.startswith("passphrase") and "=" in s and surge_passphrase:
            result.append(f"passphrase = {surge_passphrase}")
        elif s.startswith("p12") and "=" in s and surge_p12:
            result.append(f"p12 = {surge_p12}")
        else:
            result.append(line)
    return "\n".join(result)


# ---------------------------------------------------------------------------
# 生成 Surfboard Profile
# ---------------------------------------------------------------------------

def _gen_surfboard_general(lines: list[str]) -> str:
    """过滤 iOS/macOS 专属 key，输出 Surfboard 兼容的 [General] 内容。"""
    out = []
    for line in lines:
        s = line.strip()
        if s and not s.startswith("#") and "=" in s:
            key = s.split("=")[0].strip()
            if key in SURFBOARD_SKIP_GENERAL_KEYS:
                continue
        out.append(line.rstrip())
    return "\n".join(out).strip()


def _gen_surfboard_proxy_groups(
    group_lines: list[str],
    skips: list[str],
    pg_inject: dict | None = None,
    adblock_proxy_lines: list[str] | None = None,
) -> str:
    """生成 Surfboard [Proxy Group] 段落，将 smart 类型转换为 url-test。"""
    out: list[str] = ["[Proxy Group]"]
    inject_names: set[str] = pg_inject["names"] if pg_inject else set()
    injected = False
    ph = PendingHeaders()

    if pg_inject and pg_inject.get("prepend_block"):
        out.append(pg_inject["prepend_block"])

    for line in group_lines:
        if line.startswith("#"):
            lvl = 3 if line.startswith("# >>") else (2 if line.startswith("# >") else 1)
            ph.push(line, lvl)
            continue
        g = parse_group_line(line)
        if g is None:
            ph.skip()
            continue
        name = g["name"]
        if name in inject_names:
            ph.skip()
            continue
        if _is_skipped(name, skips):
            print(f"  [SKIP Surfboard group] {name}")
            ph.skip()
            continue

        # select + policy-path + no explicit proxies → adblock group
        if (g["type"] == "select" and "policy-path" in g["params"]
                and not g["proxies"] and adblock_proxy_lines is not None):
            sb_names = [
                pl.partition("=")[0].strip()
                for pl in adblock_proxy_lines
                if "=" in pl and pl.partition("=")[2].strip().lower() in _SURFBOARD_SUPPORTED_ACTIONS
            ]
            if sb_names:
                icon = g["params"].get("icon-url", "")
                icon_part = f", icon-url={icon}" if icon else ""
                out.extend(ph.flush())
                out.append(f"{name} = select, {', '.join(sb_names)}{icon_part}")
            else:
                ph.skip()
            continue

        gtype = "url-test" if g["type"] == "smart" else g["type"]
        tokens = [gtype] + g["proxies"]
        for k, v in g["params"].items():
            tokens.append(f"{k}={v}")

        out.extend(ph.flush())
        out.append(f"{name} = {', '.join(tokens)}")

        if pg_inject and not injected and pg_inject.get("anchor") == name:
            out.append(pg_inject["block"])
            injected = True

    if pg_inject and not injected and pg_inject.get("block"):
        out.append(pg_inject["block"])

    return "\n".join(out)


def _gen_surfboard_rules(rule_lines: list[str], skips: list[str]) -> str:
    """生成 Surfboard [Rule] 段落，过滤 URL-REGEX / USER-AGENT / IP-CIDR6，REJECT-TINYGIF → REJECT。"""
    out: list[str] = ["[Rule]"]
    ph = PendingHeaders()
    _sb_drop = SURFBOARD_UNSUPPORTED_RULE_TYPES | _COMMENT_DROP_TYPES

    for line in rule_lines:
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            inner_type = s.lstrip("#").strip().split(",")[0].strip().upper()
            if inner_type not in _sb_drop:
                lvl = 3 if s.startswith("# >>") else (2 if s.startswith("# >") else 1)
                ph.push(s, lvl)
            continue

        parts = [p.strip() for p in s.split(",")]
        rule_type = parts[0].upper()

        if rule_type in SURFBOARD_UNSUPPORTED_RULE_TYPES:
            ph.skip()
            continue

        if rule_type == "REJECT-TINYGIF":
            parts[0] = "REJECT"

        # skip 检查
        if rule_type in ("RULE-SET", "DOMAIN-SET") and len(parts) >= 3:
            if _should_skip([parts[1], parts[2]], skips):
                ph.skip()
                continue
        elif len(parts) >= 2 and _should_skip([parts[1]], skips):
            ph.skip()
            continue

        keep = [p for p in parts if p not in _SURGE_FLAGS]
        out.extend(ph.flush())
        out.append(", ".join(keep))
    return "\n".join(out)


def gen_surfboard_profile(
    proxy_lines: list[str],
    group_lines: list[str],
    rule_lines: list[str],
    skips: list[str],
    general_lines: list[str] | None = None,
    pg_inject: dict | None = None,
) -> str:
    """从 Surge 解析结果生成 Surfboard 兼容 Profile（Surge 精简版，无 MITM）。"""
    parts = []
    if general_lines:
        gen_text = _gen_surfboard_general(general_lines)
        if gen_text:
            parts.append("[General]\n" + gen_text)
    # [Proxy]：Surge 源代理，过滤掉 Surfboard 不支持的 action proxy（如 REJECT-TINYGIF）
    sb_proxy_lines = _filter_proxy_lines_for_platform(proxy_lines, _SURFBOARD_SUPPORTED_ACTIONS)
    parts.append("[Proxy]\n" + "\n".join(sb_proxy_lines))
    parts.append(_gen_surfboard_proxy_groups(group_lines, skips, pg_inject, adblock_proxy_lines=proxy_lines))
    parts.append(_gen_surfboard_rules(rule_lines, skips))
    return "\n\n".join(parts) + "\n"


# ---------------------------------------------------------------------------
# 主函数
# ---------------------------------------------------------------------------

def main() -> None:
    config = parse_sync_txt()

    surge_src = config.get("Surge", {}).get("source")
    if not surge_src:
        raise ValueError("Surge 块缺少 >> 源文件路径指令")

    proxy_lines, group_lines, rule_lines, surge_mitm_lines, general_lines = parse_surge_profile(REPO_ROOT / surge_src)
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

        groups_yaml = gen_proxy_groups(group_lines, skips, pg_inject, provider_urls, adblock_proxy_lines=proxy_lines)
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
        loon_host_block = loon_blocks.get("Host", "")
        loon_rewrite_block = loon_blocks.get("Rewrite", "")
        loon_script_block = loon_blocks.get("Script", "")
        explicit_filter_map = loon.get("filter_map", {})
        filter_defs = loon.get("filter_defs", {})
        loon_skips = config.get("global_skips", []) + loon.get("skips", [])

        # 若无手动 FilterMap，从 loon.ini [Remote Filter] regex 自动推导
        if explicit_filter_map:
            filter_map = explicit_filter_map
        elif filter_defs:
            auto_map: dict[str, str] = {}
            for grp_line in group_lines:
                g = parse_group_line(grp_line)
                if g and g["type"] == "smart":
                    name = g["name"]
                    for filter_name, pattern in filter_defs.items():
                        try:
                            # Loon FilterKey 中 (?i) 可出现在非开头位置；
                            # Python re 不允许，将其剥离后以 IGNORECASE 标志替代
                            clean_pat = pattern.replace("(?i)", "")
                            if re.search(clean_pat, name, re.IGNORECASE):
                                auto_map[name] = filter_name
                                break
                        except re.error:
                            pass
            filter_map = auto_map
        else:
            filter_map = {}

        print(f"  FilterMap (auto): {list(filter_map.keys())}" if not explicit_filter_map else f"  FilterMap: {list(filter_map.keys())}")
        print(f"  Loon skip: {loon_skips}")
        if loon_pg_inject:
            print(f"  loon pg_inject: anchor={loon_pg_inject.get('anchor')} | names={loon_pg_inject.get('names')}")

        # 从 Surge rule_lines 提取 FINAL 规则
        surge_final = ""
        for _rl in rule_lines:
            _parts = [p.strip() for p in _rl.split(",")]
            if _parts[0].upper() == "FINAL":
                _policy = _parts[1] if len(_parts) > 1 else "🔰 Proxy"
                surge_final = f"# Final\nFINAL,{_policy}"
                break

        loon_rename_map = loon.get("rename_map", {})
        pg_loon = gen_loon_proxy_groups(group_lines, loon_skips, loon_pg_inject, filter_map, adblock_proxy_lines=proxy_lines)
        remote_rules = gen_loon_remote_rules(rule_lines, loon_skips, loon_rename_map)

        # [Rule]：静态规则 + FINAL（来自 Surge）
        rule_section_parts = []
        if loon_rule_block:
            rule_section_parts.append(loon_rule_block)
        if surge_final:
            rule_section_parts.append(surge_final)
        rule_section = "[Rule]\n" + "\n".join(rule_section_parts) if rule_section_parts else ""

        # [Mitm]：来自 Surge Profile [MITM] 段落
        surge_mitm_block = "\n".join(surge_mitm_lines).strip()

        loon_proxy_section = _gen_loon_proxy_section(proxy_lines)
        loon_parts = [loon_header, pg_loon]
        if loon_proxy_section:
            loon_parts.append(loon_proxy_section)
        if rule_section:
            loon_parts.append(rule_section)
        loon_parts.append(remote_rules)
        loon_parts.append("[Host]\n" + loon_host_block if loon_host_block else "[Host]")
        loon_parts.append("[Rewrite]\n" + loon_rewrite_block if loon_rewrite_block else "[Rewrite]")
        loon_parts.append("[Script]\n" + loon_script_block if loon_script_block else "[Script]")
        if loon_plugin_block:
            loon_parts.append("[Plugin]\n" + loon_plugin_block)
        if surge_mitm_block:
            loon_parts.append("[Mitm]\n" + surge_mitm_block)

        changed = write_if_changed(REPO_ROOT / loon_out_path, "\n\n".join(loon_parts) + "\n")
        print(f"  {'✓ ' + loon_out_path + ' 已更新' if changed else '✓ ' + loon_out_path + ' 无变化'}")

    # ── Quantumult X ───────────────────────────────────────────────────────
    qx = config.get("Quantumult X", {})
    if qx.get("output"):
        print("\n── sync-config: Surge Profile → QX Sample.conf ──")
        qx_out_path = qx["output"]
        qx_header = qx.get("qx_header", "")
        qx_blocks = qx.get("qx_blocks", {})
        qx_pg_inject = qx.get("pg_inject_qx")
        qx_skips = config.get("global_skips", []) + qx.get("skips", [])
        qx_rename_map = qx.get("rename_map", {})
        qx_strip_names = True
        qx_policy_rename = qx.get("policy_rename_map") or None  # 空 dict → None

        print(f"  QX skip: {qx_skips}")
        if qx_policy_rename:
            print(f"  QX policy_rename: {qx_policy_rename}")
        if qx_pg_inject:
            print(f"  QX pg_inject: anchor={qx_pg_inject.get('anchor')} | names={qx_pg_inject.get('names')}")

        policies = gen_qx_policies(group_lines, qx_skips, qx_pg_inject, strip_names=qx_strip_names, policy_rename_map=qx_policy_rename)
        qx_url_maps = qx.get("url_maps") or None
        filter_remote = gen_qx_filter_remote(
            rule_lines, qx_skips, qx_rename_map, qx_blocks.get("filter_remote", ""),
            strip_names=qx_strip_names, policy_rename_map=qx_policy_rename,
            url_maps=qx_url_maps,
        )
        filter_local = gen_qx_filter_local(
            rule_lines, qx_blocks.get("filter_local", ""),
            strip_names=qx_strip_names, policy_rename_map=qx_policy_rename,
        )

        def _qx_section(key: str, header: str) -> str:
            content = qx_blocks.get(key, "")
            return f"{header}\n{content}" if content else header

        qx_parts = [qx_header, policies]
        qx_parts.append(_qx_section("server_remote", "[server_remote]"))
        qx_parts.append(filter_remote)
        qx_parts.append(_qx_section("rewrite_remote", "[rewrite_remote]"))
        qx_parts.append(_qx_section("task_local", "[task_local]"))
        qx_parts.append(_qx_section("http_backend", "[http_backend]"))
        qx_parts.append("[server_local]")
        qx_parts.append(filter_local)
        qx_parts.append("[rewrite_local]")
        mitm_content = qx_blocks.get("mitm", "")
        if mitm_content:
            mitm_content = _sync_qx_mitm(mitm_content, surge_mitm_lines)
            qx_parts.append(f"[mitm]\n{mitm_content}")

        changed = write_if_changed(REPO_ROOT / qx_out_path, "\n\n".join(qx_parts) + "\n")
        print(f"  {'✓ ' + qx_out_path + ' 已更新' if changed else '✓ ' + qx_out_path + ' 无变化'}")

    # ── Surfboard ──────────────────────────────────────────────────────────────
    surfboard = config.get("Surfboard", {})
    if surfboard.get("output"):
        print("\n── sync-config: Surge Profile → Surfboard.conf ──")
        sb_out = surfboard["output"]
        sb_skips = config.get("global_skips", []) + surfboard.get("skips", [])
        sb_pg_inject = surfboard.get("pg_inject_surfboard")
        print(f"  Surfboard skip: {sb_skips}")
        if sb_pg_inject:
            print(f"  Surfboard pg_inject: anchor={sb_pg_inject.get('anchor')} | names={sb_pg_inject.get('names')}")
        sb_content = gen_surfboard_profile(proxy_lines, group_lines, rule_lines, sb_skips, general_lines, sb_pg_inject)
        changed = write_if_changed(REPO_ROOT / sb_out, sb_content)
        print(f"  {'✓ ' + sb_out + ' 已更新' if changed else '✓ ' + sb_out + ' 无变化'}")


if __name__ == "__main__":
    main()
