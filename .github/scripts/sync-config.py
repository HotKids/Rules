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

import copy
import json
import re
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import quote, unquote

import yaml

from _common import write_if_changed as _write_if_changed

# ---------------------------------------------------------------------------
# 路径配置
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SYNC_CONFIG_TXT = REPO_ROOT / ".github" / "scripts" / "sync-config.txt"

HOTKIDS_SURGE_PREFIX = "https://raw.githubusercontent.com/HotKids/Rules/master/Surge/RULE-SET/"
HOTKIDS_CLASH_PREFIX = "https://raw.githubusercontent.com/HotKids/Rules/master/Clash/RuleSet/"
HOTKIDS_QX_FILTER_PREFIX = "https://raw.githubusercontent.com/HotKids/Rules/master/Quantumult/X/Filter/"

CLASH_UNSUPPORTED_RULE_TYPES = {"URL-REGEX", "USER-AGENT"}
# 注释掉的规则中，这些类型在 Clash 里同样不支持，直接丢弃（不入待输出缓冲区）
_COMMENT_DROP_TYPES = CLASH_UNSUPPORTED_RULE_TYPES | {"AND", "OR", "NOT"}
_SURGE_FLAGS = {"extended-matching", "pre-matching", "force-remote-dns", "no-alert", "enhanced-mode"}
RAW_PREFIX = "https://raw.githubusercontent.com/"

# Surfboard 不支持的规则类型（Android 无 MITM，无 IPv6 实现；DOMAIN-REGEX 未记录）
SURFBOARD_UNSUPPORTED_RULE_TYPES = {"URL-REGEX", "USER-AGENT", "GEOSITE", "IP-CIDR6", "DOMAIN-REGEX"}
# Surfboard（Android）不适用的 Surge iOS/macOS 专属 General key
# Surge 内建动作名（proxy value 为这些时视为 action proxy）
_SURGE_BUILTIN_ACTIONS = frozenset({"direct", "reject", "reject-tinygif", "reject-drop", "reject-no-drop"})
# Surfboard 支持的内建动作（无 MITM，不支持 TINYGIF/DROP）
_SURFBOARD_SUPPORTED_ACTIONS = frozenset({"direct", "reject"})
# Loon 支持的内建动作及其值映射（Surge lowercase → Loon format）
_LOON_SUPPORTED_ACTIONS = frozenset({"direct", "reject"})
_LOON_ACTION_VALUE_MAP = {"direct": "DIRECT", "reject": "REJECT",
                          "reject-tinygif": "REJECT", "reject-drop": "REJECT-DROP", "reject-no-drop": "REJECT"}
_CLASH_SUPPORTED_ACTIONS = frozenset({"direct", "reject", "reject-drop"})
# Surge → Clash 规则类型重命名（含 AND 子规则）
_CLASH_TYPE_RENAMES = {"DEST-PORT": "DST-PORT", "PROTOCOL": "NETWORK"}
# Surge PROTOCOL 值 → Clash NETWORK 值（不支持的值 → 跳过该规则）
_SURGE_PROTOCOL_TO_NETWORK = {"TCP": "TCP", "UDP": "UDP"}


def _convert_and_clash(s: str) -> str | None:
    """将 Surge AND rule 字符串转换为 Clash 格式，返回 None 表示无法转换（应跳过）。

    子规则类型按 _CLASH_TYPE_RENAMES 重命名；PROTOCOL 值按 _SURGE_PROTOCOL_TO_NETWORK
    映射为大写（QUIC 等无对应值时返回 None）。
    """
    def convert_sub(m: re.Match) -> str:
        t, v = m.group(1).upper(), m.group(2)
        if t == "PROTOCOL":
            new_v = _SURGE_PROTOCOL_TO_NETWORK.get(v.strip().upper())
            if new_v is None:
                raise ValueError(v)
            return f"(NETWORK,{new_v})"
        return f"({_CLASH_TYPE_RENAMES.get(t, t)},{v})"
    try:
        return re.sub(r"\(([A-Z][A-Z0-9-]*),([^)]+)\)", convert_sub, s)
    except ValueError:
        return None


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


def _gen_clash_action_wrapper_groups(
    proxy_lines: list[str], icon_map: dict[str, str] | None = None
) -> tuple[list[str], str]:
    """从 Surge proxy_lines 生成 Clash hidden action wrapper groups。

    icon_map（来自 policy-path 文件的 `# icon:` 注释）按名称提供 icon，缺省则不带 icon。

    返回：
      proxy_names  list[str]  按 proxy_lines 顺序的 emoji 名称
      wrapper_yaml str        追加到 pg_inject["block"] 的 YAML 文本
    """
    icon_map = icon_map or {}
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
        icon = icon_map.get(name, "")
        icon_line = f"    icon: {icon}\n" if icon else ""
        wrapper_blocks.append(
            f"  # {comment}\n"
            f'  - name: "{name}"\n'
            f"    type: select\n"
            f"{icon_line}"
            f"    hidden: true\n"
            f"    proxies:\n"
            f"      - {clash_val}"
        )
    return proxy_names, "\n\n".join(wrapper_blocks)


# Surfboard [General] 白名单：仅保留这些 key
_SURFBOARD_KEEP_GENERAL_KEYS = frozenset({
    "dns-server", "doh-server", "skip-proxy", "proxy-test-url", "always-real-ip",
})
# Surge key → Surfboard 等价 key（重命名）
_SURFBOARD_GENERAL_KEY_RENAMES = {"encrypted-dns-server": "doh-server"}

# ---------------------------------------------------------------------------
# 通用工具
# ---------------------------------------------------------------------------

_CST = timezone(timedelta(hours=8))
_DATE_LINE_RE = re.compile(r"^# Date: .*$", re.MULTILINE)


def _stamp_date(text: str) -> str:
    """将首个 `# Date: ...` 行替换为当前北京时间（YYYY-MM-DD HH:MM:SS）。"""
    now = datetime.now(_CST).strftime("%Y-%m-%d %H:%M:%S")
    return _DATE_LINE_RE.sub(f"# Date: {now}", text, count=1)


def _write_stamped_if_changed(filepath: Path, content: str) -> bool:
    """按需写入 content（Date 行替换为当前北京时间），避免仅 Date 行差异导致的无意义刷新。

    - 文件不存在 → 写入（当前时间）
    - 文件存在且内容（忽略 Date 行）与 content 相同 → 不写（保留既有 Date），返回 False
    - 否则 → 写入（当前时间）
    """
    now = datetime.now(_CST).strftime("%Y-%m-%d %H:%M:%S")
    stamped = _DATE_LINE_RE.sub(f"# Date: {now}", content, count=1)
    if filepath.exists():
        existing = filepath.read_text(encoding="utf-8")
        placeholder = "# Date: __NORM__"
        if (_DATE_LINE_RE.sub(placeholder, existing, count=1)
                == _DATE_LINE_RE.sub(placeholder, content, count=1)):
            return False
    filepath.parent.mkdir(parents=True, exist_ok=True)
    filepath.write_text(stamped, encoding="utf-8")
    return True


# 无 Date 行场景下的按需写入复用 _common.write_if_changed（见顶部 import _write_if_changed）


_GIST_RAW_RE = re.compile(r"https://raw\.githubusercontent\.com/([^/\s]+)/([^/\s]+)/([^/\s]+)/")


def _apply_gist_reverse_proxy(text: str, host: str) -> str:
    """把 `https://raw.githubusercontent.com/<user>/<repo>/<ref>/` 改写为 jsDelivr 风格
    `https://<host>/gh/<user>/<repo>@<ref>/`。`host` 为空串则原样返回。"""
    if not host:
        return text
    return _GIST_RAW_RE.sub(
        lambda m: f"https://{host}/gh/{m.group(1)}/{m.group(2)}@{m.group(3)}/",
        text,
    )


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
            if s.startswith("#") and re.search(r"(?<!:)//", s) and not found_anchor:
                found_anchor = True
                m = re.search(r"(?<!:)//\s*(.+?)(?=\s+[\u4e00-\u9fff]|\s*$)", s)
                if m:
                    anchor = m.group(1).strip()
                clean_comment = re.sub(r"\s*(?<!:)//.*$", "", s).rstrip()
                if clean_comment and clean_comment != "#":
                    post_lines.append(re.sub(r"\s*(?<!:)//.*$", "", line).rstrip())
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

    # rules 注入：按「# 说明 // 锚点」拆成多段，每段携带各自锚点；
    # 首个锚点前的内容归入 anchor=None 段——与 pg_inject 的 prepend_block 语义一致，
    # 插到 rules 列表最前面（而非跟"锚点声明了但没匹配上"的情况一样堆到 MATCH 之前）。
    rules_inject: dict | None = None
    if rules_lines:
        segments: list[dict] = []
        cur: dict = {"anchor": None, "rules": []}
        for line in rules_lines:
            s = line.strip()
            if not s:
                continue
            if s.startswith("#"):
                m = re.search(r"(?<!:)//\s*(.+?)(?=\s+[\u4e00-\u9fff]|\s*$)", s)
                if m:
                    if cur["rules"]:
                        segments.append(cur)
                    cur = {"anchor": m.group(1).strip(), "rules": []}
                comment_text = re.sub(r"\s*(?<!:)//.*$", "", s).strip()
                if comment_text and comment_text != "#":
                    cur["rules"].append(comment_text)
                continue
            # "  - RULE,..." → extract rule string
            if s.startswith("-"):
                cur["rules"].append(s[1:].strip())
        if cur["rules"]:
            segments.append(cur)
        rules_inject = {"segments": segments}

    return proxy_providers, pg_inject, rules_inject


def _process_builtin_loon(lines: list[str]) -> tuple[str, dict | None, str, str, str, str, str, str]:
    """从 Loon Builtin 内容解析头部和各段落块。

    返回：
      loon_header     str        [Proxy Group] 之前的所有内容（含 [Remote Filter] 段头，
                                 条目由 _gen_loon_filters 从 Profile.conf 自动生成注入）
      pg_inject_loon  dict|None  {anchor, block, names, prepend_block}
      rule_block      str        [Rule] 内容（不含段落标题）
      plugin_block    str        [Plugin] 内容（不含段落标题）
      mitm_block      str        [Mitm] 内容（不含段落标题，通常由 Surge 覆盖）
      host_block      str        [Host] 内容（不含段落标题）
      rewrite_block   str        [Rewrite] 内容（不含段落标题）
      script_block    str        [Script] 内容（不含段落标题）
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
        # [Remote Filter] 段头留在 header_lines，条目由 _gen_loon_filters 生成注入

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

    return loon_header, pg_inject_loon, rule_block, plugin_block, mitm_block, host_block, rewrite_block, script_block


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
        "pg_inject_loon": None,
        "loon_blocks": {},
        "qx_header": "",
        "qx_blocks": {},
        "pg_inject_qx": None,
        "policy_rename_map": {},
        "pg_inject_surfboard": None,
        "gist_reverse_proxy": "",
    }


_url_cache: dict[str, str] = {}


def _fetch_remote_section(url: str, section: str) -> list[str]:
    """获取远程 URL，提取指定 [section] 段落的内容行（不含段落标题行）。"""
    if url not in _url_cache:
        try:
            with urllib.request.urlopen(url, timeout=15) as resp:  # noqa: S310
                _url_cache[url] = resp.read().decode("utf-8")
        except Exception as e:
            print(f"  [WARN] 无法获取 {url}: {e}")
            _url_cache[url] = ""
    content = _url_cache[url]
    if not content:
        return []
    result: list[str] = []
    in_target = False
    for line in content.splitlines():
        s = line.strip()
        if s == f"[{section}]":
            in_target = True
            continue
        if s.startswith("[") and s.endswith("]") and in_target:
            break
        if in_target:
            result.append(line)
    return result


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
                hdr, pg_inj, rule_blk, plugin_blk, mitm_blk, host_blk, rewrite_blk, script_blk = _process_builtin_loon(builtin_buf)
                plat["loon_header"] = hdr
                plat["pg_inject_loon"] = pg_inj
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
                        _cur_ini_sec = ""
                        for ini_line in ini_path.read_text(encoding="utf-8").splitlines():
                            ini_s = ini_line.strip()
                            # 跟踪 ini 内当前段落
                            if ini_s.startswith("[") and ini_s.endswith("]"):
                                _cur_ini_sec = ini_s[1:-1]
                            if ini_s.startswith("<<"):
                                ref = ini_s[2:].strip().split()[0] if ini_s[2:].strip() else ""
                                if ref.startswith("http") and _cur_ini_sec:
                                    # 抓取远程文件，仅注入对应段落内容
                                    fetched = _fetch_remote_section(ref, _cur_ini_sec)
                                    builtin_buf.extend(fetched)
                                elif ref and not ref.startswith("http"):
                                    result.setdefault(current_platform, _empty_plat())["include_file"] = ref
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
        elif current_section == "Gist":
            if "=>" not in stripped:
                continue
            left, _, right = stripped.partition("=>")
            left, right = left.strip(), right.strip()
            if left != "ReverseProxy" or not right:
                continue
            if current_platform == "Surge":
                result["gist_reverse_proxy"] = right
            elif current_platform:
                result.setdefault(current_platform, _empty_plat())["gist_reverse_proxy"] = right

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
    # 1. HotKids 自动映射（摊平子目录，与 sync-rules.py 输出一致）
    if HOTKIDS_SURGE_PREFIX in url:
        rest = url[url.index(HOTKIDS_SURGE_PREFIX) + len(HOTKIDS_SURGE_PREFIX):]
        basename = rest.rsplit("/", 1)[-1] if "/" in rest else rest
        if basename.endswith(".list"):
            basename = basename[:-5] + ".yaml"
        return HOTKIDS_CLASH_PREFIX + basename

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


def _parse_surge_alt_groups(profile_path: Path) -> dict[str, dict]:
    """解析 Surge [Proxy Group] 中以 // 注释的备选定义，返回 {group_name: parsed_group}。

    这些行不被 parse_surge_profile 采纳，但可作为 Surfboard 等平台的替换规则使用。
    """
    text = profile_path.read_text(encoding="utf-8")
    in_pg = False
    result: dict[str, dict] = {}
    for line in text.splitlines():
        s = line.strip()
        if re.match(r"^\[(.+)\]$", s):
            in_pg = (s == "[Proxy Group]")
            continue
        if in_pg and s.startswith("//"):
            g = parse_group_line(s[2:].strip())
            if g:
                result[g["name"]] = g
    return result

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
            loaded = _load_policy_path_proxy_lines(g["params"]["policy-path"])
            extra_lines, action_icons = loaded if loaded else ([], {})
            action_lines = _merge_action_lines(adblock_proxy_lines, extra_lines)
            clash_action_names, wrapper_yaml = _gen_clash_action_wrapper_groups(action_lines, action_icons)
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

        flushed = ph.flush()
        out.extend(flushed)
        out.extend(_fmt_group(name, g["type"], g["params"], g["proxies"], provider_urls))
        out.append("")

        # 锚点优先匹配「段落开头注释」（如 # Google），兼容匹配组名；命中则注入到该组之后。
        if pg_inject and not injected and pg_inject.get("anchor") and (
            any(_anchor_matches(pg_inject["anchor"], c) for c in flushed)
            or _anchor_matches(pg_inject["anchor"], name)
        ):
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


def _anchor_matches(anchor: str | None, target: str) -> bool:
    """注入锚点匹配：关键词（子串、忽略大小写）。anchor 为空则不匹配。

    例：锚点 `Google` 命中组名 `🔍 Google`；锚点 `RULE-SET,LAN` 命中规则行
    `- RULE-SET,LAN,🔘 DIRECT`。proxy-groups 与 rules 注入共用同一套语义。
    """
    return bool(anchor) and anchor.lower() in target.lower()

# ---------------------------------------------------------------------------
# Provider 命名
# ---------------------------------------------------------------------------

def _rename_lookup(url: str, stem: str, rename_map: dict[str, str] | None) -> str:
    """Rename 查表：优先 `父目录/词干` 复合键（区分不同上游的同名文件，如
    Sukka 的 ip/reject 与 Loyalsoldier 的 reject），其次裸词干。"""
    if not rename_map:
        return stem
    parts = url.rstrip("/").rsplit("/", 2)
    parent = parts[-2] if len(parts) >= 2 else ""
    return rename_map.get(f"{parent}/{stem}", rename_map.get(stem, stem))


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
    stem = _rename_lookup(clash_url, stem, rename_map)
    name, counter = stem, 2
    while name in seen and seen[name] != clash_url:
        name = f"{stem}_{counter}"
        counter += 1
    return name


HOTKIDS_RAW_BASE = "https://raw.githubusercontent.com/HotKids/Rules/master/"

# Clash 内置 rule-set 首选配置：stem → (repo 内首选远程文件, 本地 path 生成的文件名)
# 用于某些 rule-set 有多个格式时指定首选远程文件并自定义本地缓存文件名
# （如 LAN 远程走 ipcidr 格式 lancidr.txt，本地落盘命名为 LANCIDR.yaml）
_CLASH_BUILTIN_PREFERRED = {"LAN": ("lancidr.txt", "LANCIDR.yaml")}


def _infer_behavior_from_clash_yaml(path: Path) -> str:
    """解析本地 Clash RuleSet YAML，按 payload 条目**格式**推断 provider behavior。

    - 任一条目含规则类型前缀（形如 `IP-CIDR,10.0.0.0/8,no-resolve` / `DOMAIN-SUFFIX,example.com`）→ `classical`
    - 所有条目为裸 CIDR（含 `/` 的字面 IP 段，如 `10.0.0.0/8`）→ `ipcidr`
    - 所有条目为裸域名 → `domain`
    - 混合或空 → `classical`（最宽松，安全兜底）
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return "classical"
    has_classical = False
    has_ipcidr = False
    has_domain = False
    prefix_re = re.compile(r"^[A-Z][A-Z0-9-]+,")
    for line in text.splitlines():
        s = line.strip()
        if not s.startswith("- "):
            continue
        body = s[2:].strip()
        hash_idx = body.find("#")
        if hash_idx >= 0:
            body = body[:hash_idx].strip()
        if len(body) >= 2 and body[0] in "\"'" and body[-1] == body[0]:
            body = body[1:-1].strip()
        if not body:
            continue
        if prefix_re.match(body):
            has_classical = True
        elif "/" in body:
            has_ipcidr = True
        else:
            has_domain = True
    if has_classical:
        return "classical"
    if has_ipcidr and not has_domain:
        return "ipcidr"
    if has_domain and not has_ipcidr:
        return "domain"
    return "classical"


def _resolve_builtin_from_repo(name: str, platform: str) -> tuple[str, str] | None:
    """按平台自动探测仓库本地 rule-set 文件，返回 (HotKids raw URL, behavior)。

    platform == "clash" → 若 _CLASH_BUILTIN_PREFERRED 命中则用首选文件，否则 Clash/RuleSet/<name>.yaml；
                         behavior 由 payload 条目格式推断
    platform == "loon"  → 检查 Surge/RULE-SET/<name>.list；behavior 返回空串
    """
    if platform == "clash":
        preferred = _CLASH_BUILTIN_PREFERRED.get(name)
        if preferred:
            remote_file, _local_path = preferred
            local = REPO_ROOT / "Clash" / "RuleSet" / remote_file
            if local.exists():
                return f"{HOTKIDS_RAW_BASE}Clash/RuleSet/{remote_file}", _infer_behavior_from_clash_yaml(local)
        local = REPO_ROOT / "Clash" / "RuleSet" / f"{name}.yaml"
        if local.exists():
            return f"{HOTKIDS_RAW_BASE}Clash/RuleSet/{name}.yaml", _infer_behavior_from_clash_yaml(local)
    elif platform == "loon":
        local = REPO_ROOT / "Surge" / "RULE-SET" / f"{name}.list"
        if local.exists():
            return f"{HOTKIDS_RAW_BASE}Surge/RULE-SET/{name}.list", ""
    return None


def _load_policy_path_proxy_lines(url: str) -> tuple[list[str], dict[str, str]] | None:
    """解析 Surge policy-path URL，读取本地文件提取 `NAME = VALUE` action 行及图标。

    返回 (action_lines, icon_map)：
      action_lines  list[str]       `NAME = VALUE` 行（供生成 wrapper group）
      icon_map      dict[name,url]  `# icon: NAME = URL` 注释行解析的图标（Surge 忽略）
    仅处理 HotKids raw URL（可映射到仓库内文件）。其他来源返回 None，调用方走默认回退。
    """
    if not url.startswith(HOTKIDS_RAW_BASE):
        return None
    local = REPO_ROOT / url[len(HOTKIDS_RAW_BASE):]
    if not local.exists():
        return None
    out: list[str] = []
    icons: dict[str, str] = {}
    for line in local.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s:
            continue
        m = re.match(r"#\s*icon:\s*(.+?)\s*=\s*(\S+)$", s)
        if m:
            icons[m.group(1).strip()] = m.group(2).strip()
            continue
        if not s.startswith("#") and "=" in s:
            out.append(s)
    return out, icons


def _merge_action_lines(base: list[str], extra: list[str]) -> list[str]:
    """合并两组 `NAME = VALUE` 行，保留 base 顺序；extra 中 name 未出现的追加到尾部。"""
    def _name(s: str) -> str:
        return s.partition("=")[0].strip() if "=" in s else ""
    seen = {_name(ln) for ln in base if _name(ln)}
    merged = list(base)
    for ln in extra:
        n = _name(ln)
        if n and n not in seen:
            merged.append(ln)
            seen.add(n)
    return merged


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

    def register(clash_url: str, behavior: str, prefer_name: str | None = None) -> str:
        if clash_url in providers:
            return providers[clash_url]["name"]
        if prefer_name:
            # 强制使用原始 Surge 令牌作为 provider 名（如 `RULE-SET,LAN,...` 对应 URL 文件名
            # 是 `lancidr.txt` 时，provider 名仍保留为 LAN）；冲突时追加 _N 后缀
            name, counter = prefer_name, 2
            while name in seen and seen[name] != clash_url:
                name = f"{prefer_name}_{counter}"
                counter += 1
        else:
            name = _derive_provider_name(clash_url, seen, rename_map)
        entry = {"name": name, "behavior": behavior}
        # Sukka Ruleset（ruleset.skk.moe 及其 SukkaLab GitHub 镜像）的 Clash 产物
        # 均为纯文本格式（每行一条规则），mihomo 默认按 yaml 解析会失败，需显式声明
        if "ruleset.skk.moe" in clash_url:
            entry["format"] = "text"
        providers[clash_url] = entry
        seen[name] = clash_url
        return name

    # 直通规则类型（原样输出，去掉 Surge 专属 flag，再按 _CLASH_TYPE_RENAMES 重命名）
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

        elif rule_type == "PROTOCOL":
            # Surge PROTOCOL → Clash NETWORK；QUIC 无对应值，跳过
            clash_val = _SURGE_PROTOCOL_TO_NETWORK.get(parts[1].upper() if len(parts) > 1 else "")
            if clash_val is None:
                print(f"  [SKIP rule] PROTOCOL 无 Clash 等价: {s}")
                ph.skip()
                continue
            policy = parts[2] if len(parts) > 2 else ""
            emit.append(f"  - NETWORK,{clash_val},{policy}")

        elif rule_type == "AND":
            converted = _convert_and_clash(s)
            if converted is None:
                print(f"  [SKIP rule] AND 子规则无 Clash 等价: {s}")
                ph.skip()
                continue
            emit.append(f"  - {converted}")

        elif rule_type in PASSTHROUGH:
            # Surge 专用丢包保护（0.0.0.0/32），Clash 无对应机制
            if rule_type in ("IP-CIDR", "IP-CIDR6") and len(parts) > 1 and parts[1] == "0.0.0.0/32":
                ph.skip()
                continue
            keep = [p for p in parts if p not in _SURGE_FLAGS]
            keep[0] = _CLASH_TYPE_RENAMES.get(keep[0].upper(), keep[0])
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
            # mihomo 的 RULE-SET 支持 no-resolve（rules/parser.go ParseParams），
            # 源行带上时透传，避免 ipcidr 规则集对域名连接触发多余 DNS 解析
            nr = ",no-resolve" if any(p.lower() == "no-resolve" for p in parts[3:]) else ""

            if not url_or_builtin.startswith("http"):
                # 内置规则集：显式 mapping > 仓库自动探测
                if url_or_builtin in builtin_maps:
                    clash_url = builtin_maps[url_or_builtin]
                    behavior = _behavior_from_url(clash_url)
                else:
                    resolved = _resolve_builtin_from_repo(url_or_builtin, "clash")
                    if resolved is None:
                        print(f"  [SKIP rule] 内置规则集无映射: {url_or_builtin}")
                        ph.skip()
                        continue
                    clash_url, behavior = resolved
                pname = register(clash_url, behavior, prefer_name=url_or_builtin)
                if skip := _should_skip([url_or_builtin, clash_url, pname, policy], skips):
                    print(f"  [SKIP rule] skip={skip}: {url_or_builtin} -> {policy}")
                    providers.pop(clash_url, None)
                    seen.pop(pname, None)
                    ph.skip()
                    continue
                emit.append(f"  - RULE-SET,{pname},{policy}{nr}")

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

                emit.append(f"  - RULE-SET,{pname},{policy}{nr}")

        # 规则会被输出：先刷缓冲注释，再写规则行
        rules_out.extend(ph.flush())
        rules_out.extend(emit)

    # Builtin 注入 rules 预处理：逐段为其中的 RULE-SET / DOMAIN-SET 注册 provider，
    # 使 Clash 专属注入（clash.ini）也能自动生成对应 rule-providers，与 Profile.conf 规则一致。
    # 注释行原样保留；GEOSITE/GEOIP 等无需 provider 的类型原样输出。每段携带各自锚点。
    inject_segments: list[dict] = []
    for seg in (rules_inject or {}).get("segments", []):
        seg_lines: list[str] = []
        for r in seg["rules"]:
            if r.startswith("#"):
                seg_lines.append(f"  {r}")
                continue
            ip = [p.strip() for p in r.split(",")]
            if ip[0].upper() in ("RULE-SET", "DOMAIN-SET") and len(ip) >= 3:
                token, ipolicy = ip[1], ip[2]
                if token.startswith("http"):
                    iurl = map_surge_url(token, url_maps) or token
                    ibeh = "domain" if ip[0].upper() == "DOMAIN-SET" else "classical"
                    seg_lines.append(f"  - RULE-SET,{register(iurl, ibeh)},{ipolicy}")
                elif token in builtin_maps:
                    iurl = builtin_maps[token]
                    seg_lines.append(f"  - RULE-SET,{register(iurl, _behavior_from_url(iurl), prefer_name=token)},{ipolicy}")
                elif (resolved := _resolve_builtin_from_repo(token, "clash")) is not None:
                    iurl, ibeh = resolved
                    seg_lines.append(f"  - RULE-SET,{register(iurl, ibeh, prefer_name=token)},{ipolicy}")
                else:
                    print(f"  [WARN] Builtin 注入规则集无映射，原样输出: {token}")
                    seg_lines.append(f"  - {r}")
            else:
                seg_lines.append(f"  - {r}")
        inject_segments.append({"anchor": seg.get("anchor"), "lines": seg_lines})

    # 注入 Builtin rules：每段按其锚点（匹配段落开头注释）插入到该段落之后；
    # anchor=None（ini 里第一个 // 锚点之前声明的内容）插到 rules 列表最前面，
    # 与 pg_inject 的 prepend_block 语义一致；锚点声明了但没匹配上（真正的异常，
    # 通常是锚点文字打错，或对应 Surge 规则在本平台被 skip 掉了）才收集到
    # leftover，插到 MATCH 之前（无 MATCH 则追加），并打印警告便于发现。
    # 注：先做注入再生成 rule-providers，使后者能按最终 rules 顺序排序。
    def _comment_level(line: str) -> int:
        s = line.strip().lstrip("#").strip()
        n = 0
        while n < len(s) and s[n] == ">":
            n += 1
        return n

    prepend: list[str] = []
    leftover: list[str] = []
    for seg in inject_segments:
        lines = seg["lines"]
        if not lines:
            continue
        anchor = seg["anchor"]
        if anchor is None:
            prepend.extend(lines)
            continue
        inserted = False
        # 锚点只匹配「段落开头注释行」，不匹配规则行本身（避免撞策略名/同名规则）；
        # 插入到该段落之后——跳过其下更深层级子段，遇同级/更高级注释才停。
        for i, rule in enumerate(rules_out):
            if rule.strip().startswith("#") and _anchor_matches(anchor, rule):
                lvl = _comment_level(rule)
                j = i + 1
                while j < len(rules_out):
                    nxt = rules_out[j].strip()
                    if nxt.startswith("#") and _comment_level(rules_out[j]) <= lvl:
                        break
                    j += 1
                rules_out[j:j] = lines
                inserted = True
                break
        if not inserted:
            print(f"  [WARN] rules_inject 锚点未命中: {anchor!r}，注入内容改为堆到 MATCH 之前")
            leftover.extend(lines)
    if prepend:
        rules_out[0:0] = prepend
    if leftover:
        for i, rule in enumerate(rules_out):
            if "MATCH," in rule:
                rules_out[i:i] = leftover
                break
        else:
            rules_out.extend(leftover)

    # rule-providers：按 provider 名在最终 rules 中首次出现的顺序排列，
    # 使注入的 provider（如 OneDrive/Microsoft）随规则归位，而非堆在末尾。
    name_to_url = {info["name"]: url for url, info in providers.items()}
    ordered_urls: list[str] = []
    seen_urls: set[str] = set()
    for line in rules_out:
        s = line.strip()
        if s.startswith("- RULE-SET,"):
            nm = s.split(",", 2)[1].strip()
            url = name_to_url.get(nm)
            if url and url not in seen_urls:
                ordered_urls.append(url)
                seen_urls.add(url)
    for url in providers:                      # 未被引用的 provider 按原顺序补到末尾
        if url not in seen_urls:
            ordered_urls.append(url)
            seen_urls.add(url)

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
    # path 覆盖：URL 命中 _CLASH_BUILTIN_PREFERRED 首选文件时，用自定义 path 文件名
    _preferred_path_by_url = {
        f"{HOTKIDS_RAW_BASE}Clash/RuleSet/{remote}": local_path
        for remote, local_path in _CLASH_BUILTIN_PREFERRED.values()
    }
    for clash_url in ordered_urls:
        info = providers[clash_url]
        pname, behavior = info["name"], info["behavior"]
        path_override = _preferred_path_by_url.get(clash_url)
        if path_override:
            path_file = path_override
        else:
            path_file = f"{pname.replace(' ', '_')}.yaml"
        rp_lines += [
            f"  {pname}:",
            "    type: http",
            f"    behavior: {behavior}",
            f"    path: ./Provider/RuleSet/{path_file}",
            f"    url: {clash_url}",
            "    interval: 86400",
        ]
        if info.get("format"):
            rp_lines.append(f"    format: {info['format']}")
        rp_lines.append("")

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

# 地区代码表：组名（去 emoji）→ 代码，供 Loon [Remote Filter] tag 与 Clash 锚点版
# （Mihomo.yaml）的 &Filter<code> 共用命名。未列出的组回退为组名（去 emoji 去空格）。
_REGION_CODE = {
    "Hong Kong": "HK",
    "Taiwan": "TW",
    "Singapore": "SG",
    "Japan": "JP",
    "America": "US",
    "Server": "UN",
}


def _gen_loon_filters(group_lines: list[str]) -> tuple[dict[str, str], list[str]]:
    """从 Surge 策略组自动生成 Loon [Remote Filter] 条目（单点源，tag = Filter<code>）。

    - smart 组 + policy-regex-filter → 地区过滤器，正则封装成 ^(?=.*<regex>).*
    - include-all-proxies 组（如 🇺🇳 Server）→ 全节点过滤器 ^(?=.+).*（不排除任何节点）
    正则只维护在 Surge/Profile.conf；tag 代码取自 _REGION_CODE，未列出回退为组名。
    返回 ({组名: tag}, ['<tag> = NameRegex, FilterKey = "..."', ...])。
    """
    filter_map: dict[str, str] = {}
    lines: list[str] = []
    for gl in group_lines:
        g = parse_group_line(gl)
        if not g:
            continue
        regex = g["params"].get("policy-regex-filter", "")
        if g["type"] == "smart" and regex:
            filter_key = f"^(?=.*{regex}).*"
        elif g["params"].get("include-all-proxies", "").lower() in ("true", "1"):
            filter_key = "^(?=.+).*"
        else:
            continue
        base = strip_emoji(g["name"])
        tag = "Filter" + _REGION_CODE.get(base, base.replace(" ", ""))
        filter_map[g["name"]] = tag
        lines.append(f'{tag} = NameRegex, FilterKey = "{filter_key}"')
    return filter_map, lines


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
        # include-all-proxies → 使用 FilterMap 指定的 Remote Filter（默认 FilterUN）
        fm_val = filter_map.get(name, "FilterUN")
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
        if pg_inject and not injected and _anchor_matches(pg_inject.get("anchor"), name):
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
            resolved = _resolve_builtin_from_repo(url, "loon")
            if resolved is None:
                ph.skip()
                continue
            url = resolved[0]

        if _should_skip([url, policy], skips):
            print(f"  [SKIP Loon remote rule] {url}")
            ph.skip()
            continue

        tag = _rename_lookup(url, _derive_tag(url), rename_map)
        out.extend(ph.flush())
        # 拦截包装策略（policy-path 定义，Loon 不加载）→ Loon 内建动作
        emit_policy = {"📛 REJECT-DROP": "REJECT-DROP"}.get(policy, policy)
        out.append(f"{url}, policy={emit_policy}, tag={tag}, enabled=true")

    return "\n".join(out)


# ---------------------------------------------------------------------------
# 生成 QX [policy]
# ---------------------------------------------------------------------------

# QX 无 reject-drop 变体，拦截包装策略统一落到内建 reject
_QX_PROXY_MAP = {"🚫 REJECT": "reject", "⛔️ REJECT": "reject",
                 "📛 REJECT-DROP": "reject", "🔘 DIRECT": "direct"}


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
        if pg_inject and not injected and _anchor_matches(pg_inject.get("anchor"), emit_name):
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

        tag = _rename_lookup(url, tag, rename_map)
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

_QX_LAN_PLACEHOLDER = "# <<< LAN >>>"
_LAN_TITLE_HEADER_RE = re.compile(r"^#\s*>\s*.+$")


def _qx_expand_lan_list(list_path: Path, title: str) -> list[str]:
    """把 Surge 格式 rule-set 展开为 QX [filter_local] 行（策略统一为 `direct`）。

    - 首个 `# > ...` section header 替换为 `# {title}`
    - 其它注释行原样保留
    - 规则行按类型转换（`no-resolve` 丢弃）：
        DOMAIN-SUFFIX,host        → host-suffix, host, direct
        DOMAIN,host               → host, host, direct
        IP-CIDR,cidr              → ip-cidr, cidr, direct
        IP-CIDR6,cidr             → ip6-cidr, cidr, direct
    - 其它规则类型 → 抛 ValueError（显式失败，避免静默吞规则）
    - 移除尾部空白行
    """
    out: list[str] = []
    header_replaced = False
    for raw in list_path.read_text(encoding="utf-8").splitlines():
        s = raw.rstrip()
        if not s:
            out.append("")
            continue
        if s.startswith("#"):
            if not header_replaced and _LAN_TITLE_HEADER_RE.match(s):
                out.append(f"# {title}")
                header_replaced = True
            else:
                out.append(s)
            continue
        parts = [p.strip() for p in s.split(",")]
        rt = parts[0].upper()
        if len(parts) < 2:
            raise ValueError(f"_qx_expand_lan_list: malformed rule {s!r} in {list_path}")
        target = parts[1]
        if rt == "DOMAIN-SUFFIX":
            out.append(f"host-suffix, {target}, direct")
        elif rt == "DOMAIN":
            out.append(f"host, {target}, direct")
        elif rt == "IP-CIDR":
            out.append(f"ip-cidr, {target}, direct")
        elif rt == "IP-CIDR6":
            out.append(f"ip6-cidr, {target}, direct")
        else:
            raise ValueError(f"_qx_expand_lan_list: unsupported rule {rt!r} in {list_path}")
    while out and not out[-1]:
        out.pop()
    return out


def gen_qx_filter_local(
    rule_lines: list[str],
    static_fl: str = "",
    strip_names: bool = True,
    policy_rename_map: dict[str, str] | None = None,
    lan_expand: list[str] | None = None,
) -> str:
    """生成 QX [filter_local] 段落。

    static_fl 为 qx.ini 中的静态块（Unbreak / LAN 占位符 / geoip, cn, direct），
    `lan_expand` 提供时会替换 static_fl 中的 `# <<< LAN >>>` 占位符行。
    再从 Surge rule_lines 提取 GEOIP（非 CN）和 FINAL。
    """
    out: list[str] = ["[filter_local]"]
    if static_fl:
        for line in static_fl.splitlines():
            if lan_expand is not None and line.strip() == _QX_LAN_PLACEHOLDER:
                out.extend(lan_expand)
            else:
                out.append(line)
        out.append("")

    final_line: str | None = None

    for line in rule_lines:
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        parts = [p.strip() for p in s.split(",")]
        rule_type = parts[0].upper()
        if rule_type == "DEST-PORT" and len(parts) >= 3:
            policy = parts[2]
            stripped_policy = _QX_PROXY_MAP.get(policy, strip_emoji(policy) if strip_names else policy)
            emit_policy = policy_rename_map.get(stripped_policy, stripped_policy) if policy_rename_map else stripped_policy
            out.append(f"dest-port, {parts[1]}, {emit_policy}")
        elif rule_type == "GEOIP" and len(parts) >= 3:
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
    """白名单过滤，仅输出 Surfboard 支持的 [General] key，并重命名 Surge 专属 key。"""
    out = []
    for line in lines:
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        key, _, val = s.partition("=")
        key = key.strip()
        renamed = _SURFBOARD_GENERAL_KEY_RENAMES.get(key, key)
        if renamed in _SURFBOARD_KEEP_GENERAL_KEYS:
            out.append(f"{renamed} = {val.strip()}")
    return "\n".join(out)


_SURFBOARD_SKIP_PARAMS = {"icon-url", "evaluate-before-use", "no-alert"}


def _gen_surfboard_proxy_groups(
    group_lines: list[str],
    skips: list[str],
    pg_inject: dict | None = None,
    adblock_proxy_lines: list[str] | None = None,
    alt_groups: dict[str, dict] | None = None,
) -> str:
    """生成 Surfboard [Proxy Group] 段落，将 smart 类型转换为 url-test。

    alt_groups: 从 Surge // 注释行解析的备选组定义，用于替换 include-all-proxies 等 Surfboard
    不支持的形式（如 🇺🇳 Server 用 policy-path 替代）。icon-url 在所有组中被剥离。
    """
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
                out.extend(ph.flush())
                out.append(f"{name} = select, {', '.join(sb_names)}")
            else:
                ph.skip()
            continue

        # include-all-proxies=true → 用 // 备选定义中的 policy-path 替代
        if g["params"].get("include-all-proxies", "").lower() in ("true", "1"):
            alt = (alt_groups or {}).get(name)
            if alt and "policy-path" in alt["params"]:
                pp = alt["params"]["policy-path"]
                out.extend(ph.flush())
                out.append(f"{name} = select, policy-path={pp}")
            else:
                ph.skip()
            continue

        gtype = "url-test" if g["type"] == "smart" else g["type"]
        tokens = [gtype] + g["proxies"]
        for k, v in g["params"].items():
            if k in _SURFBOARD_SKIP_PARAMS:
                continue
            tokens.append(f"{k}={v}")

        out.extend(ph.flush())
        out.append(f"{name} = {', '.join(tokens)}")

        if pg_inject and not injected and _anchor_matches(pg_inject.get("anchor"), name):
            out.append(pg_inject["block"])
            injected = True

    if pg_inject and not injected and pg_inject.get("block"):
        out.append(pg_inject["block"])

    return "\n".join(out)


def _gen_surfboard_rules(rule_lines: list[str], skips: list[str]) -> str:
    """生成 Surfboard [Rule] 段落，过滤不支持的规则类型，REJECT-DROP/NO-DROP → REJECT。"""
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

        # Surge-specific rule types → REJECT（REJECT-TINYGIF 为 Surfboard 原生支持，保留）
        if rule_type in ("REJECT-DROP", "REJECT-NO-DROP"):
            parts[0] = "REJECT"
            rule_type = "REJECT"

        # skip 检查
        if rule_type in ("RULE-SET", "DOMAIN-SET") and len(parts) >= 3:
            if _should_skip([parts[1], parts[2]], skips):
                ph.skip()
                continue
        elif len(parts) >= 2 and _should_skip([parts[1]], skips):
            ph.skip()
            continue

        keep = [p for p in parts if p not in _SURGE_FLAGS]
        # policy-path 定义的拦截包装策略 → 内建 REJECT（策略可能不在行尾，如后接 no-resolve）
        keep = [{"📛 REJECT-DROP": "REJECT"}.get(p, p) for p in keep]
        # Surge-specific actions in policy position → REJECT
        if keep:
            keep[-1] = {"REJECT-NO-DROP": "REJECT", "REJECT-DROP": "REJECT"}.get(keep[-1].upper(), keep[-1])
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
    alt_groups: dict[str, dict] | None = None,
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
    parts.append(_gen_surfboard_proxy_groups(
        group_lines, skips, pg_inject, adblock_proxy_lines=proxy_lines, alt_groups=alt_groups))
    parts.append(_gen_surfboard_rules(rule_lines, skips))
    return "\n\n".join(parts) + "\n"


# ---------------------------------------------------------------------------
# Clash 覆写脚本（Script.js）：解析生成后的 Mihomo.yaml，转译为等效 JS
# ---------------------------------------------------------------------------

_JS_IDENT_RE = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")

# main(config) 中按此顺序透传的基础设置 key（proxies / proxy-providers /
# proxy-groups / rule-providers / rules 单独处理，不在此列）
# 基础设置的分节 + 每键注释（单一来源）：Mihomo.yaml 与 Script.js 两个生成器共用，
# 保证锚点版 YAML 和覆写脚本的分节/注释永远一致。结构：[(分节标题, [(键, [注释行, ...])])]
_CLASH_BASE_SECTIONS: list[tuple[str, list[tuple[str, list[str]]]]] = [
    ("通用设置", [
        ("mixed-port", ["混合代理端口（HTTP 和 SOCKS5 共用）"]),
        ("allow-lan", ["允许局域网设备通过本机代理"]),
        ("bind-address", ["监听地址，'*' 表示所有网卡"]),
        ("mode", ["代理模式：rule（规则）/ global（全局）/ direct（直连）"]),
        ("log-level", ["日志等级：silent / error / warning / info / debug"]),
        ("ipv6", ["关闭 IPv6：阻断所有 IPv6 连接并屏蔽 AAAA DNS 记录"]),
        ("external-controller", ["RESTful API 监听地址（供 Dashboard 及外部控制器使用）"]),
    ]),
    ("性能设置", [
        ("unified-delay", ["统一延迟：去除 TCP 握手耗时，使延迟测试结果更准确"]),
        ("tcp-concurrent", ["TCP 并发：同时向所有解析 IP 发起连接，取最快握手"]),
        ("find-process-mode", ["进程匹配模式：always 强制 / strict 自动（默认）/ off 不匹配（适合路由器）"]),
        ("geodata-loader", ["GeoData 加载模式：standard 性能优先 / memconservative 低内存（适合路由器/嵌入式）"]),
        ("global-ua", ["HTTP 请求 UA（显式声明，避免随版本漂移）"]),
        ("keep-alive-interval", ["TCP Keep-Alive 探测间隔（秒）"]),
    ]),
    ("GeoData 设置", [
        ("geo-auto-update", ["自动更新 GeoData 数据库"]),
        ("geo-update-interval", ["更新间隔（小时）"]),
        ("geox-url", ["GeoData 数据库 URL"]),
    ]),
    ("Hosts", [
        ("hosts", ["静态域名映射，优先级高于 DNS 解析"]),
    ]),
    ("配置持久化", [
        ("profile", ["store-selected 记住策略组选择；store-fake-ip 持久化 fake-ip 映射（重启后 IP 不变）"]),
    ]),
    ("NTP 校时", [
        ("ntp", [
            "内置 NTP：部分协议（如 VMess）对本机时间偏差敏感，校时失败会导致握手异常；",
            "write-to-system=false 不写入系统时间，仅供内核内部使用",
        ]),
    ]),
    ("域名嗅探", [
        ("sniffer", [
            "嗅探结果仅用于规则匹配、不替换目标地址（fake-ip 下 override-destination=false，HTTP 单独覆盖为 true）；",
            "force-dns-mapping=true 改善直连 IP 命中；parse-pure-ip=false 避免纯 IP 连接的大量 \"may not have any sent data\" 警告",
        ]),
    ]),
    ("DNS", [
        ("dns", [
            "fake-ip（blacklist）：fake-ip-filter 内域名返回真实 IP，其余走 fake-ip；default-nameserver 仅解析上游域名（纯 IP）；",
            "nameserver/fallback 经代理（#proxy）防境外域名泄露给国内 DNS，ECS 携带国内 IP 取 CDN 最优节点；",
            "fallback-filter 命中（GeoIP 非 CN 或落保留段）判定污染改用 fallback；代理节点/DIRECT 域名走国内 DoH",
        ]),
    ]),
    ("TUN", [
        ("tun", [
            "接管系统全量流量；stack mixed（TCP 系统栈 + UDP gvisor，推荐）；dns-hijack 劫持 53 端口防绕过；",
            "auto-route/auto-redirect 自动配路由与透明代理（仅 Linux）；strict-route 防 IP 泄漏；",
            "EIM NAT 改善游戏/VOIP/WebRTC 打洞；disable-icmp-forwarding 关闭 ICMP 代答，让 ping 反映真实链路",
        ]),
    ]),
]

# 覆写脚本要接管的基础键，直接由上表派生（顺序一致）
_CLASH_SCRIPT_BASE_KEYS = [key for _, items in _CLASH_BASE_SECTIONS for key, _ in items]


def _js_string(s: str) -> str:
    escaped = s.replace("\\", "\\\\").replace("'", "\\'")
    return f"'{escaped}'"


def _js_key(k: str) -> str:
    return k if _JS_IDENT_RE.match(k) else _js_string(k)


def _to_js(value, indent: int = 2, quote_keys: bool = False) -> str:
    """quote_keys=True 时对象键一律加引号（用于 provider/分组名这类数据映射，
    避免'带空格的才有引号'的混排）；字段键（name/type/...）保持裸键。"""
    pad, pad_in = " " * indent, " " * (indent + 2)
    key_fn = _js_string if quote_keys else _js_key
    if isinstance(value, dict):
        if not value:
            return "{}"
        items = [f"{pad_in}{key_fn(str(k))}: {_to_js(v, indent + 2, quote_keys)}," for k, v in value.items()]
        return "{\n" + "\n".join(items) + f"\n{pad}}}"
    if isinstance(value, list):
        if not value:
            return "[]"
        items = [f"{pad_in}{_to_js(v, indent + 2)}," for v in value]
        return "[\n" + "\n".join(items) + f"\n{pad}]"
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "null"
    if isinstance(value, (int, float)):
        return json.dumps(value)
    return _js_string(str(value))


def _rule_comment_key(rule: str) -> str:
    """规则 → 注释匹配键：前两段（类型,值）；MATCH 的第 2 段是策略（会被 overlay 改名），单用类型。"""
    parts = rule.split(",")
    return parts[0] if parts[0] == "MATCH" else ",".join(parts[:2])


def _sort_by_group_order(pool_filters: dict, groups: list[dict]) -> dict:
    """把 pool_filters 的键序对齐到组在 proxyGroups 里的出现顺序（未知键排末尾）。"""
    order = {g["name"]: i for i, g in enumerate(groups)}
    return dict(sorted(pool_filters.items(), key=lambda kv: order.get(kv[0], len(order))))


def _to_js_inline(value) -> str:
    """紧凑单行 JS 字面量（对象/数组不换行），用于 spread 抽公共后的单行条目。"""
    if isinstance(value, dict):
        if not value:
            return "{}"
        return "{ " + ", ".join(f"{_js_key(str(k))}: {_to_js_inline(v)}" for k, v in value.items()) + " }"
    if isinstance(value, list):
        if not value:
            return "[]"
        return "[" + ", ".join(_to_js_inline(v) for v in value) + "]"
    return _to_js(value)


def _convert_group_for_script(g: dict, pool_filters: dict[str, str | None]) -> dict:
    """节点池组（Server / 地区）→ Script.js 场景下没有 provider，改由运行时 JS 手动
    过滤 config.proxies 填充 `proxies`（见 _gen_clash_script_js 里 poolGroupFilters 循环）。

    池组在 Sample.yaml 里写作 `use: [Server]`（+可选 filter），在 Mihomo.yaml 里写作
    `<<: *Region`（解析后 = `include-all-providers: true`）；两种来源都识别。

    不用 mihomo 原生 `include-all`：它对候选节点列表做隐式字母序排序（mihomo
    config/config.go 里 `slices.Sort(AllProxies)`，无条件执行、无开关可关闭），会打乱
    订阅原始顺序；而 `use:`+`filter` 走 outboundgroup/groupbase.go，不排序。这里手动
    实现同等语义（Array.filter 保序），行为对齐真正的 Clash 输出。

    pool_filters 记录 name → filter（无 filter 记 None），供上层生成填充代码。
    键序统一规范化为 name, type, icon, hidden, proxies，使输出与来源（Sample.yaml /
    Mihomo.yaml，二者键序不同）无关，切换来源不产生无谓 diff。
    """
    is_pool = g.get("use") == ["Server"] or g.get("include-all-providers") is True
    if is_pool:
        pool_filters[g["name"]] = g.get("filter")
    drop = {"use", "include-all-providers", "filter"} if is_pool else set()
    return _ordered_group({k: v for k, v in g.items() if k not in drop})


def _ordered_group(g: dict) -> dict:
    """组键序规范化为锚点版风格：name, type, proxies, hidden, …extras…, icon（icon 垫底）。
    使输出与来源（Sample.yaml / Mihomo.yaml，二者键序不同）及 overlay 声明顺序无关。"""
    head = [k for k in ("name", "type", "proxies", "hidden") if k in g]
    extras = [k for k in g if k not in ("name", "type", "proxies", "hidden", "icon")]
    tail = ["icon"] if "icon" in g else []
    return {k: g[k] for k in head + extras + tail}


def _rule_policy_index(parts: list[str]) -> int:
    """Surge/Clash 规则行里策略字段的下标。`MATCH,POLICY` 策略在 index 1；
    `AND/OR/NOT,(...),POLICY` 策略永远是最后一个逗号分段（拆括号里的逗号
    也没关系，反正策略本身不含逗号，取 -1 仍然对）；其余类型固定是
    `TYPE,VALUE,POLICY[,no-resolve]` 形式，策略在 index 2。
    """
    if parts[0] == "MATCH":
        return 1
    if parts[0] in ("AND", "OR", "NOT"):
        return len(parts) - 1
    return 2


def _apply_overlay(
    groups: list[dict],
    pool_filters: dict[str, str | None],
    rules: list[str],
    structural_pool_names: set[str],
    overlay: dict,
    overlay_label: str,
) -> None:
    """把私人差异声明（如 sync-config/Enhanced/myscript.overlay.json、
    clashbox.overlay.json）叠加到自动生成的基座上，就地修改 groups / pool_filters /
    rules / structural_pool_names。各类差异对应 overlay 里的字段（按此处的处理顺序）：

    - rule_policy_redirect：把 rules 里以某分组为策略目标的行改指另一分组
      （{旧落点: 新落点}，用改名前的基座名字）。先于 remove_groups 执行，
      因此「删掉某组但保留其规则」可以两者搭配（如 📛 REJECT-DROP 组删掉、
      其规则落点改指 ⛔️ REJECT）。
    - remove_groups：整组删掉（如 📛 REJECT-DROP），同时从其余分组的 proxies 候选
      里剔除对它的引用、删掉 rules 里以它为策略目标的行。
    - rename_map：批量改名（{旧名: 新名}），同步更新其余分组 proxies 候选里的旧名
      引用、pool_filters 的 key、以及 rules 里以该分组为策略目标的行，避免残留
      指向旧名字的悬空引用。多个 overlay 之间要做同一批改名时用这个，而不是在
      group_overrides 里逐个重复写 {"name": ...}。
    - icon_overrides：批量换图标（{名字: 图标 URL}，用改名后的新名字做 key）。
    - group_overrides：改写已有分组的其余字段（如地区组 select→fallback）+
      pool_filters 的 filter（换成带排除条件的正则）。同样支持带 name 改名
      （效果等同 rename_map 的单条写法），二者可以混用。
    - group_proxies_insert：在已有分组的静态 proxies 候选列表里，紧邻某个已有条目
      之前/之后插入新地区（如 🔰 Proxy 的候选里插入 🇬🇧 England / 🇩🇪 Germany）。
    - extra_pool_groups：整个新增的池分组（Relay 中转链、新地区），插入到指定锚点
      分组之后，并登记进 pool_filters（运行时按 filter 从 config.proxies 里挑节点）。
    - move_after：把一个既有分组（结构性池组，无法用 group_proxies_insert 挪位置）
      挪到另一个分组之后，纯粹调整展示顺序，不影响候选列表/规则。

    overlay_label 只用于报错信息里指明是哪个 overlay 文件（如 'myscript.overlay.json'）。
    """
    by_name = {g["name"]: g for g in groups}

    def _get_group(name: str, where: str) -> dict:
        if name not in by_name:
            raise ValueError(
                f"{overlay_label} 的 {where} 引用了不存在的分组 {name!r}；"
                f"当前基座里的分组有：{sorted(by_name)}"
            )
        return by_name[name]

    def _rename_group(old_name: str, new_name: str) -> None:
        if new_name == old_name:
            return
        group = by_name[old_name]
        group["name"] = new_name
        for g in groups:
            if isinstance(g.get("proxies"), list):
                g["proxies"] = [new_name if p == old_name else p for p in g["proxies"]]
        if old_name in pool_filters:
            pool_filters[new_name] = pool_filters.pop(old_name)
        if old_name in structural_pool_names:
            structural_pool_names.discard(old_name)
            structural_pool_names.add(new_name)
        for i, r in enumerate(rules):
            parts = r.split(",")
            idx = _rule_policy_index(parts)
            if idx < len(parts) and parts[idx] == old_name:
                parts[idx] = new_name
                rules[i] = ",".join(parts)
        del by_name[old_name]
        by_name[new_name] = group

    for old_policy, new_policy in overlay.get("rule_policy_redirect", {}).items():
        _get_group(new_policy, f"rule_policy_redirect[{old_policy!r}] 的新落点")
        for i, r in enumerate(rules):
            parts = r.split(",")
            idx = _rule_policy_index(parts)
            if idx < len(parts) and parts[idx] == old_policy:
                parts[idx] = new_policy
                rules[i] = ",".join(parts)

    for name in overlay.get("remove_groups", []):
        _get_group(name, f"remove_groups[{name!r}]")
        groups[:] = [g for g in groups if g["name"] != name]
        for g in groups:
            if isinstance(g.get("proxies"), list):
                g["proxies"] = [p for p in g["proxies"] if p != name]
        pool_filters.pop(name, None)
        structural_pool_names.discard(name)
        for i in reversed(range(len(rules))):
            parts = rules[i].split(",")
            idx = _rule_policy_index(parts)
            if idx < len(parts) and parts[idx] == name:
                del rules[i]
        del by_name[name]

    for old_name, new_name in overlay.get("rename_map", {}).items():
        _get_group(old_name, f"rename_map.{old_name!r}")
        _rename_group(old_name, new_name)

    for name, icon in overlay.get("icon_overrides", {}).items():
        _get_group(name, f"icon_overrides.{name!r}")["icon"] = icon

    for name, patch in overlay.get("group_overrides", {}).items():
        group = _get_group(name, f"group_overrides.{name!r}")
        group.update({k: v for k, v in patch.items() if k not in ("filter", "name")})
        if "filter" in patch:
            pool_filters[group["name"]] = patch["filter"]
        if "name" in patch:
            _rename_group(name, patch["name"])

    for name, spec in overlay.get("group_proxies_insert", {}).items():
        group = _get_group(name, f"group_proxies_insert.{name!r}")
        if "proxies" not in group:
            raise ValueError(
                f"{overlay_label} 的 group_proxies_insert.{name!r} 指向的分组"
                f"没有静态 proxies 候选列表（可能是节点池/地区组），无法插入"
            )
        proxies = group["proxies"]
        anchor = spec.get("after") or spec.get("before")
        if anchor not in proxies:
            raise ValueError(
                f"{overlay_label} 的 group_proxies_insert.{name!r} 里的锚点 "
                f"{anchor!r} 不在该分组的 proxies 候选列表里：{proxies}"
            )
        idx = proxies.index(anchor) + (1 if "after" in spec else 0)
        proxies[idx:idx] = spec["insert"]

    for i, raw_spec in enumerate(overlay.get("extra_pool_groups", [])):
        spec = dict(raw_spec)
        name = spec.get("name", f"#{i}")
        if "insert_after" not in spec:
            raise ValueError(
                f"{overlay_label} 的 extra_pool_groups[{name!r}] 缺少必填字段 insert_after"
            )
        anchor_name = spec.pop("insert_after")
        filter_ = spec.pop("filter", None)
        new_group = spec  # 剩余字段（name/type/icon/hidden/tolerance…）直接作为分组定义
        idx = next((j for j, g in enumerate(groups) if g["name"] == anchor_name), None)
        if idx is None:
            raise ValueError(
                f"{overlay_label} 的 extra_pool_groups[{name!r}] 的 insert_after "
                f"引用了不存在的分组 {anchor_name!r}；当前分组有：{[g['name'] for g in groups]}"
            )
        groups.insert(idx + 1, new_group)
        by_name[new_group["name"]] = new_group
        pool_filters[new_group["name"]] = filter_
        structural_pool_names.add(new_group["name"])

    for name, anchor_name in overlay.get("move_after", {}).items():
        group = _get_group(name, f"move_after.{name!r}")
        _get_group(anchor_name, f"move_after.{name!r} 的目标位置")
        groups.remove(group)
        idx = next(j for j, g in enumerate(groups) if g["name"] == anchor_name)
        groups.insert(idx + 1, group)


def _yaml_flow(v) -> str:
    """紧凑 flow 序列化（单行）。bare 标量会带 YAML 文档结束符 ...，去掉。"""
    s = yaml.safe_dump(v, default_flow_style=True, allow_unicode=True,
                       width=10**9, sort_keys=False).rstrip("\n")
    if s.endswith("\n..."):
        s = s[:-4].rstrip("\n")
    return s


def _yaml_sq(s) -> str:
    """单引号 YAML 标量（不做转义，适合正则 / 规则字符串）。"""
    return "'" + str(s).replace("'", "''") + "'"


def _scan_sample_item_comments(text: str, section_key: str) -> dict:
    """扫描 Sample.yaml / Mihomo.yaml 某顶层块，取每个条目正上方（连续、未被空行打断）的注释。
    返回 {条目名: [注释行]}；列表型条目（如 rules）汇总到 '__list__': [(值, [注释]), ...]。"""
    out: dict = {}
    pending: list[str] = []
    in_sec = False
    for ln in text.split("\n"):
        if ln.rstrip() == f"{section_key}:":
            in_sec = True
            pending = []
            continue
        if in_sec and ln and not ln[0].isspace():   # 到达下一个顶层键 / 顶层注释 → 离开本段
            break
        if not in_sec:
            continue
        s = ln.strip()
        if s == "":
            pending = []
        elif s.startswith("#"):
            pending.append(s)
        elif s.startswith("- name:"):
            m = re.search(r'name:\s*"?([^"]+?)"?\s*$', s)
            if m:
                out[m.group(1).strip()] = pending
            pending = []
        elif s.startswith("- "):
            body = s[2:].strip()
            # flow 单行条目（Mihomo.yaml 的 - {name: ..., ...}）：按 name 归属
            fm = re.match(r"^\{name:\s*([^,}]+)", body)
            if fm:
                out[fm.group(1).strip()] = pending
            else:
                # 列表条目；Mihomo.yaml 的规则带单引号，剥掉以与解析值对齐
                if len(body) >= 2 and body[0] == body[-1] == "'":
                    body = body[1:-1].replace("''", "'")
                out.setdefault("__list__", []).append((body, pending))
            pending = []
        elif re.match(r"^[^\s#-].*:$", s):
            out[s[:-1].strip()] = pending
            pending = []
        else:
            pending = []
    return out


def _gen_mihomo_yaml(sample_yaml_text: str) -> str:
    """由最终生成的 Clash/Sample.yaml 转译出锚点/flow 版 Clash/Mihomo.yaml（功能等价）。

    与 Script.js 同思路：只读 Sample.yaml 的解析结果，天然随 Sample.yaml 变化。
    - 地区组 use:[Server]+filter → <<: *Region, filter: *Filter<code>（正则单点源自 Sample.yaml）
    - rule-providers 抽公共 type/interval 到 &Remote
    - 大块（dns/tun/sniffer 等）转 flow 单行 + 摘要注释；策略组 / 规则的分层注释从 Sample.yaml 带过来
    """
    cfg = yaml.safe_load(sample_yaml_text) or {}

    # 地区筛选正则 → &Filter<code> 锚点；组 → 锚点类型映射
    filters: list[tuple[str, str]] = []
    grp_anchor: dict[str, tuple[str, str | None]] = {}
    for g in cfg.get("proxy-groups", []):
        if g.get("use") == ["Server"]:
            if "filter" in g:
                base = strip_emoji(g["name"])
                anchor = "Filter" + _REGION_CODE.get(base, base.replace(" ", ""))
                filters.append((anchor, g["filter"]))
                grp_anchor[g["name"]] = ("region", anchor)
            else:
                grp_anchor[g["name"]] = ("server", None)

    L: list[str] = [
        "# Clash · 锚点改写版（block + YAML 锚点，功能等价 Sample.yaml）",
        "# Date: ",
        "# Author: @HotKids",
        "#",
        "# 自动生成（sync-config.py 从 Clash/Sample.yaml 转译），请勿手改；改内容请改 Surge/Profile.conf。",
        "",
    ]

    # 基础设置分节 + 注释来自 _CLASH_BASE_SECTIONS（与 Script.js 生成器共享单一来源）
    for section, items in _CLASH_BASE_SECTIONS:
        present = [(k, cs) for k, cs in items if k in cfg]
        if not present:
            continue
        L.append(f"# ── {section} ──")
        L.append("")
        for key, comments in present:
            for cline in comments:
                L.append(f"# {cline}")
            L.append(f"{key}: {_yaml_flow(cfg[key])}")
        L.append("")

    # 节点 + 锚点
    L += [
        "# ── 节点 ──",
        "",
        "# 锚点：供下方 proxy-groups / rule-providers 以 <<: 合并、filter: 引用",
        "anchors:",
        "  # 远程规则集参数：http，每日更新一次（behavior/format 留各条自定）",
        "  - &Remote {type: http, interval: 86400}",
        "  # 地区分组基座：select + 全量 provider，节点保持订阅原序（🇺🇳 Server 直接用，地区组再叠 filter）",
        "  - &Region {type: select, include-all-providers: true}",
        "  # 地区节点筛选正则（与 Profile.conf policy-regex-filter 一致）",
    ]
    for anchor, val in filters:
        L.append(f"  - &{anchor} {_yaml_sq(val)}")
    L += [
        "  # —— 以下自动策略锚点当前未被引用，供日后加自动/故障转移/负载均衡组时 <<: 合并 ——",
        "  - &UrlTest {type: url-test, interval: 300, tolerance: 20, lazy: true, url: 'https://cp.cloudflare.com/generate_204', timeout: 2000, max-failed-times: 3, include-all-providers: true, hidden: true}",
        "  - &FallBack {type: fallback, interval: 300, lazy: true, url: 'https://cp.cloudflare.com/generate_204', timeout: 2000, max-failed-times: 3, include-all-providers: true, hidden: true}",
        "  - &LoadBalance {type: load-balance, interval: 300, lazy: true, strategy: consistent-hashing, url: 'https://cp.cloudflare.com/generate_204', timeout: 2000, max-failed-times: 3, include-all-providers: true, hidden: true}",
        "",
        "# 本地节点（订阅覆盖此处）",
        f"proxies: {_yaml_flow(cfg.get('proxies', []))}",
    ]
    if cfg.get("proxy-providers"):
        L.append("# 服务器订阅配置（每小时更新，健康检查用 Cloudflare 204）")
        L.append(f"proxy-providers: {_yaml_flow(cfg['proxy-providers'])}")
    L.append("")

    # 策略组
    L.append("# ── 策略组 ──")
    L.append("proxy-groups:")
    gcmt = _scan_sample_item_comments(sample_yaml_text, "proxy-groups")
    for g in cfg.get("proxy-groups", []):
        for c in gcmt.get(g["name"], []):
            L.append(f"  {c}")
        kind = grp_anchor.get(g["name"])
        icon_part = f", icon: {_yaml_flow(g['icon'])}" if g.get("icon") else ""
        if kind and kind[0] == "server":
            L.append(f"  - {{name: {g['name']}, <<: *Region{icon_part}}}")
        elif kind and kind[0] == "region":
            L.append(f"  - {{name: {g['name']}, <<: *Region, filter: *{kind[1]}{icon_part}}}")
        else:
            parts = [f"name: {g['name']}", f"type: {g['type']}",
                     f"proxies: {_yaml_flow(g.get('proxies', []))}"]
            if g.get("hidden"):
                parts.append("hidden: true")
            L.append("  - {" + ", ".join(parts) + icon_part + "}")
    L.append("")

    # 规则集
    L.append("# ── 规则集 ──")
    L.append("# 关于 Rule Provider 请查阅：https://wiki.metacubex.one/en/config/rule-providers/")
    L.append("rule-providers:")
    for name, rp in cfg.get("rule-providers", {}).items():
        fmt = f", format: {rp['format']}" if rp.get("format") else ""
        L.append(f"  {name}: {{<<: *Remote, behavior: {rp['behavior']}, "
                 f"path: {_yaml_flow(rp['path'])}, url: {_yaml_flow(rp['url'])}{fmt}}}")
    L.append("")

    # 规则
    L.append("# ── 规则 ──")
    L.append("rules:")
    for val, cmts in _scan_sample_item_comments(sample_yaml_text, "rules").get("__list__", []):
        for c in cmts:
            L.append(f"  {c}")
        L.append(f"  - {_yaml_sq(val)}")

    out = "\n".join(L)
    out = re.sub(r"\n\n\n+", "\n\n", out).rstrip() + "\n"
    return out


def _gen_clash_script_js(
    sample_yaml_text: str,
    overlay: dict | None = None,
    overlay_label: str = "",
    base_state: tuple[list[dict], dict[str, str | None], list[str], set[str]] | None = None,
) -> tuple[str, tuple[list[dict], dict[str, str | None], list[str], set[str]]]:
    """由最终生成的 Clash/Mihomo.yaml 转译出等效的 mihomo 覆写脚本（Script.js）。

    用于 Clash Verge 等支持「Enhance Script」的客户端：直接对任意订阅（如
    sub.hotkids.me）生成与本仓库 Surge/Profile.conf 等效的策略组 / 规则 / 基础设置，
    不依赖本仓库自身的 proxy-providers 静态生成流程。

    本函数只读 Mihomo.yaml 的解析结果（其 <<: 合并键由 YAML 解析器展开，与
    Sample.yaml 功能等价），不重新实现转换逻辑，因此天然随 Surge/Profile.conf 的
    改动同步更新，无需手动维护。

    可选分流分组（非隐藏、非节点池/地区组、非兜底策略组）会额外生成一份
    `ruleOptionsEnable`（默认 true，但 overlay 的 disabled_by_default 声明的分组
    默认 false），供使用者在本地临时切换开关某个分组——关闭时一并裁剪其 rules
    与专属 rule-providers，不改 Profile.conf。
    关闭分组时还会从其余组的候选列表中剔除对已删组的引用，即使日后策略组之间
    出现互相引用，也不会因指向不存在的策略而导致 mihomo 启动失败。

    base_state 用于多份 overlay 之间的链式叠加（overlay 的 extends 字段）：传入
    另一份已 resolve 好的 (groups, pool_filters, rules, structural_pool_names)，
    本次从这个状态（深拷贝，不影响调用方）而非 Mihomo.yaml 原始解析结果起步叠加
    overlay，从而复用公共部分（如地区/Relay链），不必在每份 overlay 里重复声明。
    返回值第二项就是这次 resolve 出的状态，供下一环 extends 复用。
    """
    data = yaml.safe_load(sample_yaml_text) or {}
    # 规范化 rule-provider 键序（Mihomo.yaml 经 <<: *Remote 合并后键序与 Sample.yaml
    # 不同），使 Script.js 输出与来源无关。
    _rp_order = ("type", "behavior", "path", "url", "interval", "format", "proxy")
    rule_providers = {
        name: {**{k: rp[k] for k in _rp_order if k in rp},
               **{k: v for k, v in rp.items() if k not in _rp_order}}
        for name, rp in (data.get("rule-providers") or {}).items()
    }

    if base_state is not None:
        base_groups, base_pool_filters, base_rules, base_structural = base_state
        groups = copy.deepcopy(base_groups)
        pool_filters = dict(base_pool_filters)
        rules = list(base_rules)
        structural_pool_names = set(base_structural)
    else:
        pool_filters = {}
        groups = [_convert_group_for_script(g, pool_filters) for g in (data.get("proxy-groups") or [])]
        rules = list(data.get("rules") or [])
        structural_pool_names = set(pool_filters)

    # 结构性池组（Server + 地区，均来自 Sample.yaml 的 use:[Server]，或链式继承自
    # base_state）——这些没有直接对应的 RULE-SET 目标，不纳入可选开关。overlay 的
    # extra_pool_groups 新增的同样是结构性的（Relay 链 / 新地区）。但 group_overrides
    # 给既有分组（如 📧 Mail）追加 filter 只是让它"顺带拿到全部节点"，不改变它本来是
    # 个可开关的功能分组这件事，因此不计入本集合。
    if overlay:
        _apply_overlay(groups, pool_filters, rules, structural_pool_names, overlay, overlay_label)

    # 基座 Script.js 面向任意机场订阅：内联 proxies 由运行时 JS 手动过滤（保序）；
    # provider 形态的订阅则给节点池分组补 include-all-providers + filter，由 mihomo
    # 运行时经 provider 路径收集（getProviders 不排序）。两路来源互不重叠、不会重复。
    # My* 私人变体绑定固定内联节点订阅，保持纯手动过滤，不加此兼容。
    if overlay is None:
        for g in groups:
            if g["name"] in pool_filters:
                g["include-all-providers"] = True
                if pool_filters[g["name"]]:
                    g["filter"] = pool_filters[g["name"]]

    # 兜底策略组（MATCH 的目标）视为核心组，始终保留；隐藏的动作包装组、
    # 结构性池组同样视为核心组，均不纳入可选开关。
    main_group_name = next((r.split(",", 1)[1] for r in rules if r.startswith("MATCH,")), None)
    optional_group_names = [
        g["name"] for g in groups
        if not g.get("hidden") and g["name"] not in structural_pool_names and g["name"] != main_group_name
    ]

    # overlay 可声明 disabled_by_default，让某些可选分组默认关闭（仍可随时手动改回
    # true），而不是像其余分组一样默认全部启用。
    disabled_by_default = set((overlay or {}).get("disabled_by_default", []))
    unknown_disabled = disabled_by_default - set(optional_group_names)
    if unknown_disabled:
        raise ValueError(
            f"{overlay_label} 的 disabled_by_default 引用了不存在或不可开关的分组 "
            f"{sorted(unknown_disabled)}；当前可开关的分组有：{optional_group_names}"
        )

    if overlay:
        source_lines = [
            " * 自动生成，请勿手改：由 sync-config.py 从 Surge/Profile.conf（经",
            f" * Clash/Mihomo.yaml）叠加 sync-config/Enhanced/{overlay_label}（私人差异声明）",
            " * 而来，直接改本文件会在下次同步时被覆盖。公共部分请改 Surge/Profile.conf；",
            " * 私人差异（改名 / 换图标 / 额外分组 / 分组类型 / 候选节点 / 默认开关等）",
            f" * 请改 {overlay_label}。",
        ]
    else:
        source_lines = [
            " * 自动生成，请勿手改：由 sync-config.py 从 Surge/Profile.conf（经",
            " * Clash/Mihomo.yaml）转译而来，直接改本文件会在下次同步时被覆盖；",
            " * 要改内容请改 Surge/Profile.conf。",
        ]

    lines = [
        "/**",
        " * mihomo 覆写脚本（Enhance Script）· HotKids/Rules",
        " *",
        " * 用途：在 Clash Verge 等支持「覆写脚本」的 mihomo 客户端里，对任意订阅",
        " * （如 https://sub.hotkids.me）动态套用与本仓库 Surge/Profile.conf 等效的",
        " * 策略组、分流规则与基础设置，不必依赖机场自带配置。",
        " *",
        *source_lines,
        " *",
        " * 本地唯一可临时修改的是下方 ruleOptionsEnable 的取值，用于按需开关某个分组。",
        " *",
        " * 仓库：https://github.com/HotKids/Rules",
        " */",
        "",
        "// 分流分组开关：true 启用 / false 关闭对应分组（连同其专属 rules /",
        "// rule-providers 一并裁剪，无需改动 Profile.conf）。默认值见下方——",
        "// 大多默认启用，个别按需默认关闭的直接标成 false，本地可随时改回 true。",
        f"const ruleOptionsEnable = {_to_js({name: name not in disabled_by_default for name in optional_group_names}, 0, quote_keys=True)};",
        "",
        "function main(config) {",
        "  // 空列表，或全部为 direct/reject 型占位节点（部分订阅模板会注入），都视为无有效节点",
        "  const inputProxies = Array.isArray(config.proxies) ? config.proxies : [];",
        "  const hasRealProxy = inputProxies.some((p) => !['direct', 'reject'].includes(String(p.type || '').toLowerCase()));",
        *(
            [
                "  // provider 形态的订阅（无内联 proxies）同样支持：节点池分组带",
                "  // include-all-providers + filter，由 mihomo 运行时从 provider 收集（不排序）",
                "  const hasProviders = config['proxy-providers'] && Object.keys(config['proxy-providers']).length > 0;",
                "  if (!hasRealProxy && !hasProviders) {",
            ]
            if overlay is None
            else ["  if (!hasRealProxy) {"]
        ),
        "    throw new Error('未找到任何代理节点，请先绑定含有效节点的订阅（如 https://sub.hotkids.me）再启用本脚本');",
        "  }",
        "",
        "  // —— 保留机场私有 DNS / 节点域名 hosts ——",
        "  // 部分机场用私有 DNS 解析节点域名，或把节点域名解析写进订阅的 hosts /",
        "  // proxy-server-nameserver；下方 dns/hosts 会被整块覆盖，先把这些私有条目",
        "  // 采集出来（滤掉常见公共 DNS），覆盖后再合并回去，避免此类机场断连。",
        "  const commonDnsRe = /(223\\.5\\.5\\.5|223\\.6\\.6\\.6|119\\.29\\.29\\.29|1\\.12\\.12\\.12|120\\.53\\.53\\.53|114\\.114\\.114\\.114|180\\.76\\.76\\.76|1\\.1\\.1\\.1|1\\.0\\.0\\.1|8\\.8\\.8\\.8|8\\.8\\.4\\.4|94\\.140\\.14\\.14|94\\.140\\.15\\.15|127\\.0\\.0\\.1|alidns|doh\\.pub|dot\\.pub|dnspod|dns\\.baidu|dns\\.google|cloudflare|adguard|system)/i;",
        "  const origDns = config.dns || {};",
        "  const privateProxyNs = (origDns['proxy-server-nameserver'] || []).filter((d) => !commonDnsRe.test(String(d)));",
        "  const privateNsPolicy = {};",
        "  for (const policy of [origDns['proxy-server-nameserver-policy'] || {}, origDns['nameserver-policy'] || {}]) {",
        "    for (const [rule, dns] of Object.entries(policy)) {",
        "      const list = Array.isArray(dns) ? dns : [dns];",
        "      if (list.some((d) => commonDnsRe.test(String(d)))) continue;",
        "      privateNsPolicy[rule] = dns;",
        "    }",
        "  }",
        "  const proxyServerDomains = new Set(inputProxies.map((p) => String(p.server || '').toLowerCase()).filter(Boolean));",
        "  const proxyHosts = {};",
        "  for (const [host, v] of Object.entries(config.hosts || {})) {",
        "    if (proxyServerDomains.has(host.toLowerCase())) proxyHosts[host] = v;",
        "  }",
        "",
    ]
    # 基础设置：分节 + 注释与 Mihomo.yaml 共享同一来源（_CLASH_BASE_SECTIONS），
    # 单行紧凑输出（与锚点版的 flow 单行风格对齐）
    for section, items in _CLASH_BASE_SECTIONS:
        present = [(k, cs) for k, cs in items if k in data]
        if not present:
            continue
        lines.append(f"  // ── {section} ──")
        for key, comments in present:
            for cline in comments:
                lines.append(f"  // {cline}")
            lines.append(f"  config[{_js_string(key)}] = {_to_js_inline(data[key])};")
        lines.append("")

    lines += [
        "  // 合并前面采集的机场私有 DNS / 节点域名 hosts（本仓库条目优先，私有条目垫后）",
        "  if (privateProxyNs.length > 0) {",
        "    config.dns['proxy-server-nameserver'] = [...(config.dns['proxy-server-nameserver'] || []), ...privateProxyNs];",
        "  }",
        "  if (Object.keys(privateNsPolicy).length > 0) {",
        "    config.dns['proxy-server-nameserver-policy'] = privateNsPolicy;",
        "  }",
        "  Object.assign(config.hosts, proxyHosts);",
        "",
    ]

    # 节点池筛选表先于 proxy-groups 输出，对齐锚点版"锚点在前、引用在后"的结构。
    # 键序按组在 proxyGroups 里的出现顺序排列（与面板一致，避免 overlay 阶段追加的
    # 键——如 📧 Mail——被排到地区中间）；仅影响可读性，运行时按组名查表、与键序无关。
    lines += [
        "  // ── 节点 ──",
        "  // 节点池筛选正则（对应 Mihomo.yaml 的 &Region / &Filter* 锚点）：",
        "  // null = 不过滤、取全量节点；下方策略组生成后按此表运行时填充候选。",
        f"  const poolGroupFilters = {_to_js(_sort_by_group_order(pool_filters, groups), quote_keys=True)};",
        "",
    ]

    # 每组一行（与 Mihomo.yaml 的 proxy-groups 单行条目风格对齐），分组注释从
    # Mihomo.yaml 带过来（# → //）；overlay 改过名的组经 rename_map 反查原名匹配。
    group_cmts = _scan_sample_item_comments(sample_yaml_text, "proxy-groups")
    rename_rev = {new: old for old, new in (overlay or {}).get("rename_map", {}).items()}
    lines.append("  // ── 策略组 ──")
    lines.append("  const proxyGroups = [")
    for g in groups:
        for cline in group_cmts.get(g["name"], group_cmts.get(rename_rev.get(g["name"], ""), [])):
            lines.append(f"    {cline.replace('#', '//', 1)}")
        lines.append(f"    {_to_js_inline(_ordered_group(g))},")
    lines.append("  ];")
    lines.append("")
    lines += [
        "  // 节点池分组（对应 Mihomo.yaml 的 <<: *Region + filter）：按上方 poolGroupFilters",
        "  // 手动过滤 config.proxies 并保持原始顺序，不用 mihomo 的 include-all —— 它对候选",
        "  // 节点做隐式字母序排序（mihomo config/config.go: slices.Sort(AllProxies)），",
        "  // 无条件执行、无开关可关闭，会打乱订阅原始顺序。",
        "  // 已有静态 proxies（如 📧 Mail 原有的 🔰 Proxy/🔘 DIRECT）会保留在前面，",
        "  // 过滤/全量结果追加在后面，而不是整体覆盖。",
        "  const allProxyNames = inputProxies.map((p) => p.name);",
        "  for (const g of proxyGroups) {",
        "    if (!(g.name in poolGroupFilters)) continue;",
        "    const filter = poolGroupFilters[g.name];",
        "    // 过滤正则可能带内联标志（如 (?i)）；JS RegExp 不支持内联标志，",
        "    // 需拆出标志作为第二参数传入（regexp2/ICU 等其他平台原样使用）。",
        "    let re = null;",
        "    if (filter) {",
        "      const fm = filter.match(/^\\(\\?([a-z]+)\\)([\\s\\S]*)$/);",
        "      re = fm ? new RegExp(fm[2], fm[1]) : new RegExp(filter);",
        "    }",
        "    const matched = re ? allProxyNames.filter((n) => re.test(n)) : allProxyNames;",
        "    const base = Array.isArray(g.proxies) ? g.proxies : [];",
        "    const merged = [...base, ...matched];",
        "    if (merged.length > 0) {",
        "      g.proxies = merged;",
        *(
            [
                "    } else if (g['include-all-providers'] && hasProviders) {",
                "      delete g.proxies; // 无内联匹配且订阅带 provider：交给 provider 路径在运行时填充",
            ]
            if overlay is None
            else []
        ),
        "    } else {",
        "      g.proxies = ['COMPATIBLE'];",
        "    }",
        "  }",
        "",
    ]
    # 抽取所有 rule-provider 的公共参数（动态求交集，如 type/interval），以 ...spread
    # 复用——JS 版的公共部分抽离，与 Mihomo.yaml 的 &Remote 锚点互为镜像。
    rp_common: dict = {}
    if len(rule_providers) > 1:
        first_rp = next(iter(rule_providers.values()))
        rp_common = {
            k: v for k, v in first_rp.items()
            if all(k in rp and rp[k] == v for rp in rule_providers.values())
        }
    if rp_common:
        lines.append("  // ── 规则集 ──")
        lines.append("  // 关于 Rule Provider 请查阅：https://wiki.metacubex.one/en/config/rule-providers/")
        lines.append("  // 远程规则集公共参数（对应 Mihomo.yaml 的 &Remote 锚点），各条目以 ...spread 复用")
        lines.append(f"  const remoteRuleProvider = {_to_js_inline(rp_common)};")
        lines.append("  const ruleProviders = {")
        for rp_name, rp in rule_providers.items():
            rest = ", ".join(
                f"{_js_key(str(k))}: {_to_js_inline(v)}" for k, v in rp.items() if k not in rp_common
            )
            lines.append(f"    {_js_string(str(rp_name))}: {{ ...remoteRuleProvider, {rest} }},")
        lines.append("  };")
    else:
        lines.append(f"  const ruleProviders = {_to_js(rule_providers)};")
    lines.append("")
    # 规则注释从 Mihomo.yaml 带过来（# → //）。匹配键用规则前两段（类型,值）——
    # overlay 的 rename 只改策略字段，前两段稳定；MATCH 的策略在第 2 段，单用类型匹配。
    rule_cmts: dict[str, list[str]] = {}
    for val, cs in _scan_sample_item_comments(sample_yaml_text, "rules").get("__list__", []):
        if cs:
            rule_cmts[_rule_comment_key(val)] = cs
    lines.append("  // ── 规则 ──")
    lines.append("  const rules = [")
    for r in rules:
        for cline in rule_cmts.get(_rule_comment_key(r), []):
            lines.append(f"    {cline.replace('#', '//', 1)}")
        lines.append(f"    {_js_string(r)},")
    lines.append("  ];")
    lines.append("")
    lines += [
        "  const disabledGroups = new Set(",
        "    Object.keys(ruleOptionsEnable).filter((name) => !ruleOptionsEnable[name]),",
        "  );",
        "",
        "  // 移除被关闭的组，并从其余组的候选列表中剔除对已删组的引用，",
        "  // 避免任何组指向不存在的策略导致 mihomo 启动失败。",
        "  config['proxy-groups'] = proxyGroups",
        "    .filter((g) => !disabledGroups.has(g.name))",
        "    .map((g) =>",
        "      Array.isArray(g.proxies)",
        "        ? { ...g, proxies: g.proxies.filter((p) => !disabledGroups.has(p)) }",
        "        : g,",
        "    );",
        "",
        "  const enabledRules = rules.filter((r) => {",
        "    const parts = r.split(',');",
        "    return !(parts[0] === 'RULE-SET' && parts.length >= 3 && disabledGroups.has(parts[2]));",
        "  });",
        "",
        "  const usedProviders = new Set();",
        "  for (const r of enabledRules) {",
        "    const parts = r.split(',');",
        "    if (parts[0] === 'RULE-SET' && parts.length >= 2) usedProviders.add(parts[1]);",
        "  }",
        "  config['rule-providers'] = Object.fromEntries(",
        "    Object.entries(ruleProviders).filter(([name]) => usedProviders.has(name)),",
        "  );",
        "",
        "  config['rules'] = enabledRules;",
        "",
        "  return config;",
        "}",
        "",
    ]
    return "\n".join(lines), (groups, pool_filters, rules, structural_pool_names)


# ---------------------------------------------------------------------------
# 平台同步函数
# ---------------------------------------------------------------------------

def _sync_clash(
    config: dict,
    proxy_lines: list[str],
    group_lines: list[str],
    rule_lines: list[str],
) -> None:
    clash = config.get("Clash", {})
    if not clash.get("output"):
        return
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
        _segs = rules_inject.get("segments", [])
        print(f"  rules_inject: {len(_segs)} 段 | 锚点={[s['anchor'] for s in _segs]}")

    groups_yaml = gen_proxy_groups(group_lines, skips, pg_inject, provider_urls, adblock_proxy_lines=proxy_lines)
    rp_rules_yaml = gen_rules_and_providers(rule_lines, skips, url_maps, builtin_maps, rules_inject, rename_map)

    parts = ["# Clash\n# Date: \n# Author: @HotKids"]
    if inc:
        parts.append((REPO_ROOT / inc).read_text(encoding="utf-8").rstrip())
    if pp_block:
        parts.append(pp_block)
    parts += [groups_yaml, rp_rules_yaml]

    gist_host = clash.get("gist_reverse_proxy") or config.get("gist_reverse_proxy", "")
    body = _apply_gist_reverse_proxy("\n\n".join(parts) + "\n", gist_host)
    changed = _write_stamped_if_changed(REPO_ROOT / clash_out, body)
    print(f"  {'✓ ' + clash_out + ' 已更新' if changed else '✓ ' + clash_out + ' 无变化'}")

    # 锚点/flow 版：从刚生成的 Sample.yaml 转译出 Mihomo.yaml（同层级，功能等价）；
    # 下方 Script.js 系列再由 Mihomo.yaml 转译（Mihomo.yaml 作为 Clash 侧的规范中间产物）
    mihomo_out = str(Path(clash_out).with_name("Mihomo.yaml"))
    mihomo_body = _gen_mihomo_yaml(body)
    mihomo_changed = _write_stamped_if_changed(REPO_ROOT / mihomo_out, mihomo_body)
    print(f"  {'✓ ' + mihomo_out + ' 已更新' if mihomo_changed else '✓ ' + mihomo_out + ' 无变化'}")

    script_dir = Path(clash_out).parent / "Script"
    script_path = script_dir / "Script.js"
    script_body, _ = _gen_clash_script_js(mihomo_body)
    script_changed = _write_if_changed(REPO_ROOT / script_path, script_body)
    print(f"  {'✓ ' + str(script_path) + ' 已更新' if script_changed else '✓ ' + str(script_path) + ' 无变化'}")

    # 本脚本产出的全部脚本文件（绝对路径），用于事后清理失效残留（见下方 prune）
    expected_scripts = {(REPO_ROOT / script_path).resolve()}

    # 个人差异声明（Enhanced/ 下）：自动扫描所有 *.overlay.json，每份生成一份派生
    # 脚本，输出路径由 overlay 自己的 output 字段声明（仓库根相对路径，如
    # "Clash/Script/MyClashBox.js"）——以后新增一份 overlay 文件即可自动生成对应脚本，
    # 无需改动本脚本。公共部分自动跟随 Script.js 同步；overlay 可用 extends 声明基于
    # 另一份 overlay（而非从 Mihomo.yaml 重新起步）叠加，避免多份个人配置之间重复
    # 声明同样的地区/Relay 链差异，依赖顺序按 extends 自动拓扑解析。
    enhanced_dir = REPO_ROOT / ".github" / "scripts" / "sync-config" / "Enhanced"
    overlays: dict[str, dict] = {}
    output_owner: dict[str, str] = {}  # 归一化 output 路径 → 声明它的 overlay 文件名
    for overlay_path in sorted(enhanced_dir.glob("*.overlay.json")):
        overlay = json.loads(overlay_path.read_text(encoding="utf-8"))
        if not overlay.get("output"):
            raise ValueError(
                f"{overlay_path.name} 缺少必填字段 output（派生脚本的输出路径，"
                f"仓库根相对，如 \"Clash/Script/{overlay_path.name.split('.')[0].capitalize()}.js\"）"
            )
        # 防止两份 overlay 声明同一个 output 互相覆盖（复制 overlay 后忘了改 output 的典型误操作）
        out_key = str((REPO_ROOT / overlay["output"]).resolve())
        if out_key in output_owner:
            raise ValueError(
                f"{overlay_path.name} 和 {output_owner[out_key]} 的 output 都指向 "
                f"{overlay['output']!r}，会互相覆盖；请给每份 overlay 用不同的 output"
            )
        output_owner[out_key] = overlay_path.name
        overlays[overlay_path.name] = overlay

    resolved_states: dict[str, tuple] = {}

    def _resolve_overlay(label: str, chain: list[str]) -> None:
        if label in resolved_states:
            return
        if label in chain:
            raise ValueError(
                f"overlay 的 extends 出现循环依赖：{' -> '.join(chain + [label])}"
            )
        overlay = overlays[label]
        extends = overlay.get("extends")
        base_state = None
        if extends:
            if extends not in overlays:
                raise ValueError(
                    f"{label} 的 extends 引用了不存在的 overlay 文件 {extends!r}；"
                    f"Enhanced/ 下现有：{sorted(overlays)}"
                )
            _resolve_overlay(extends, chain + [label])
            base_state = resolved_states[extends]
        out_body, state = _gen_clash_script_js(
            mihomo_body, overlay=overlay, overlay_label=label, base_state=base_state
        )
        resolved_states[label] = state
        out_rel = overlay["output"]
        expected_scripts.add((REPO_ROOT / out_rel).resolve())
        out_changed = _write_if_changed(REPO_ROOT / out_rel, out_body)
        print(f"  {'✓ ' + out_rel + ' 已更新' if out_changed else '✓ ' + out_rel + ' 无变化'}")

    for label in overlays:
        _resolve_overlay(label, [])

    # 清理失效残留：Script 目录里由本脚本生成过、但现在已不在 expected_scripts 里的
    # 脚本（例如某个 overlay 改了 output 后遗留的旧文件）。只删带 sync-config.py 生成
    # 标记的文件，不碰用户可能手放在此目录的其它 .js。
    _gen_marker = "由 sync-config.py 从 Surge/Profile.conf"
    for existing in sorted((REPO_ROOT / script_dir).glob("*.js")):
        if existing.resolve() in expected_scripts:
            continue
        try:
            head = existing.read_text(encoding="utf-8")[:400]
        except OSError:
            continue
        if _gen_marker not in head:
            continue
        existing.unlink()
        print(f"  ✓ {existing.relative_to(REPO_ROOT)} 已删除（失效残留）")


def _sync_loon(
    config: dict,
    proxy_lines: list[str],
    group_lines: list[str],
    rule_lines: list[str],
    surge_mitm_lines: list[str],
) -> None:
    loon = config.get("Loon", {})
    if not loon.get("output"):
        return
    print("\n── sync-config: Surge Profile → Loon Balloon.lcf ──")
    loon_out_path = loon["output"]
    loon_inc = loon.get("include_file")
    loon_header = (REPO_ROOT / loon_inc).read_text(encoding="utf-8").rstrip() if loon_inc else loon.get("loon_header", "")
    loon_pg_inject = loon.get("pg_inject_loon")
    loon_blocks = loon.get("loon_blocks", {})
    loon_rule_block = loon_blocks.get("Rule", "")
    loon_plugin_block = loon_blocks.get("Plugin", "")
    loon_host_block = loon_blocks.get("Host", "")
    loon_rewrite_block = loon_blocks.get("Rewrite", "")
    loon_script_block = loon_blocks.get("Script", "")
    explicit_filter_map = loon.get("filter_map", {})
    loon_skips = config.get("global_skips", []) + loon.get("skips", [])

    # [Remote Filter]：全部从 Profile.conf 策略组自动生成（单点源），tag 自动派生，
    # 并注入 loon_header 的 [Remote Filter] 段。
    auto_filter_map, auto_rf_lines = _gen_loon_filters(group_lines)
    filter_map = {**auto_filter_map, **explicit_filter_map}
    if auto_rf_lines:
        injected = "[Remote Filter]\n" + "\n".join(auto_rf_lines)
        # 精确替换独占一行的 [Remote Filter] 段头（不能用 str.replace，会命中注释里的
        # 同名字样；也不用 re.sub，注入内容含 \b/\d 会破坏替换串转义）。
        hdr_lines = loon_header.split("\n")
        for i, ln in enumerate(hdr_lines):
            if ln.strip() == "[Remote Filter]":
                hdr_lines[i] = injected
                break
        else:
            hdr_lines += ["", injected]
        loon_header = "\n".join(hdr_lines)

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
    loon_parts = [loon_header]
    if loon_proxy_section:
        loon_parts.append(loon_proxy_section)
    loon_parts.append(pg_loon)
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

    changed = _write_stamped_if_changed(REPO_ROOT / loon_out_path, "\n\n".join(loon_parts) + "\n")
    print(f"  {'✓ ' + loon_out_path + ' 已更新' if changed else '✓ ' + loon_out_path + ' 无变化'}")


def _sync_qx(
    config: dict,
    proxy_lines: list[str],
    group_lines: list[str],
    rule_lines: list[str],
    surge_mitm_lines: list[str],
) -> None:
    qx = config.get("Quantumult X", {})
    if not qx.get("output"):
        return
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
    lan_list_path = REPO_ROOT / "Surge/RULE-SET/LAN.list"
    lan_expand = (
        _qx_expand_lan_list(lan_list_path, title="Local Area Network 局域网")
        if lan_list_path.exists()
        else None
    )
    filter_local = gen_qx_filter_local(
        rule_lines, qx_blocks.get("filter_local", ""),
        strip_names=qx_strip_names, policy_rename_map=qx_policy_rename,
        lan_expand=lan_expand,
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

    changed = _write_stamped_if_changed(REPO_ROOT / qx_out_path, "\n\n".join(qx_parts) + "\n")
    print(f"  {'✓ ' + qx_out_path + ' 已更新' if changed else '✓ ' + qx_out_path + ' 无变化'}")


def _sync_surfboard(
    config: dict,
    proxy_lines: list[str],
    group_lines: list[str],
    rule_lines: list[str],
    general_lines: list[str],
    surge_src: str,
) -> None:
    surfboard = config.get("Surfboard", {})
    if not surfboard.get("output"):
        return
    print("\n── sync-config: Surge Profile → Surfboard.conf ──")
    sb_out = surfboard["output"]
    sb_skips = config.get("global_skips", []) + surfboard.get("skips", [])
    sb_pg_inject = surfboard.get("pg_inject_surfboard")
    print(f"  Surfboard skip: {sb_skips}")
    if sb_pg_inject:
        print(f"  Surfboard pg_inject: anchor={sb_pg_inject.get('anchor')} | names={sb_pg_inject.get('names')}")
    sb_alt_groups = _parse_surge_alt_groups(REPO_ROOT / surge_src)
    sb_content = gen_surfboard_profile(
        proxy_lines, group_lines, rule_lines, sb_skips, general_lines, sb_pg_inject,
        alt_groups=sb_alt_groups)
    changed = _write_stamped_if_changed(REPO_ROOT / sb_out, sb_content)
    print(f"  {'✓ ' + sb_out + ' 已更新' if changed else '✓ ' + sb_out + ' 无变化'}")


# ---------------------------------------------------------------------------
# sing-box 完整配置（config.json）：静态基座 + Profile.conf 生成 outbounds/服务规则
# ---------------------------------------------------------------------------

SB_SOURCE_DIR = REPO_ROOT / "sing-box" / "source"
# 静态基座（JSON 内容，沿用 sync-config/<平台>.ini 命名惯例，与 clash.ini 等并列）
SB_BASE_JSON = REPO_ROOT / ".github" / "scripts" / "sync-config" / "sing-box.ini"
SB_CONFIG_OUT = REPO_ROOT / "sing-box" / "config.json"
SB_SRS_PREFIX = "https://raw.githubusercontent.com/HotKids/Rules/master/sing-box/rule-set/"
SB_DIRECT_TAG = "🔘 Direct"
# 兜底占位（理论上不会用到：SB_EXAMPLE_NODES 已覆盖 Profile.conf 现有的全部地区组，
# 仅当出现无法识别的新地区组时才会引用，此时仍需手动订阅工具注入节点）
SB_PLACEHOLDER = "🚀 Proxy（请用订阅工具注入节点）"
# 组名含这些关键词的策略组不生成 outbound（与其他平台的 skip 语义一致）
SB_SKIP_GROUP_KW = ("Speedtest", "Gateway", "Apple TV")

# 各地区示例节点（占位用途：sing-box 无订阅机制，先内置一份可直接连通的示例
# Shadowsocks 节点，方便直接改 server/password 试用；真实使用请用订阅工具替换）
# 按地区组 policy-regex-filter 命中的关键词匹配，与本仓库 Profile.conf 的固定 5 个地区一一对应
SB_EXAMPLE_NODES = {
    "HK": ("🇭🇰 HK", "hk.hotkids.me"),
    "TW": ("🇨🇳 TW", "tw.hotkids.me"),
    "SG": ("🇸🇬 SG", "sg.hotkids.me"),
    "JP": ("🇯🇵 JP", "jp.hotkids.me"),
    "US": ("🇺🇸 US", "us.hotkids.me"),
}
_SB_EXAMPLE_METHOD = "2022-blake3-aes-128-gcm"
_SB_EXAMPLE_PORT = 12345
# 2022-blake3-aes-128-gcm 要求 password 为 base64 编码的 16 字节 PSK，随意字符串
# （如 "qwerty"）会被 sing-box check 判为非法密钥而报错。此处用一个合法的占位 PSK
# （base64("HotKidsRulesDemo")），仅为通过校验，正式使用时由订阅工具替换。
_SB_EXAMPLE_PASSWORD = "SG90S2lkc1J1bGVzRGVtbw=="


def _sb_example_node_for(regex_filter: str) -> tuple[str, str] | None:
    return next((v for kw, v in SB_EXAMPLE_NODES.items() if kw in regex_filter), None)


def _sb_example_outbound(tag: str, domain: str) -> dict:
    return {
        "type": "shadowsocks", "tag": tag,
        "server": domain, "server_port": _SB_EXAMPLE_PORT,
        "method": _SB_EXAMPLE_METHOD, "password": _SB_EXAMPLE_PASSWORD,
        "tcp_fast_open": True,
    }

# 外部规则集 → 官方 sing-box 规则集（SagerNet 二进制 srs / Sukka source json）。
# 这是跨项目等价映射（非机械转换），故显式列出；token 用子串匹配，值为 (tag, url, format)。
_SB_EXTERNAL_SETS = {
    "surge-rules/release/proxy.txt": (
        "geolocation-!cn", "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-geolocation-!cn.srs", "binary"),
    "surge-rules/release/direct.txt": (
        "geosite-cn", "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs", "binary"),
    "surge-rules/release/cncidr.txt": (
        "geoip-cn", "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs", "binary"),
    "ruleset/ASN.China": (
        "geoip-cn", "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs", "binary"),
}
# Loyalsoldier private.txt → sing-box 内建 ip_is_private（非 rule_set）
_SB_PRIVATE_TOKEN = "surge-rules/release/private.txt"


def _sb_human_name(token: str) -> str:
    """Surge 规则 token → 人类可读名（解码 URL 转义），供 skip 关键词匹配。

    其他平台（Clash 等）用派生的 provider 名做第二次 skip 检查才能命中
    "Apple News" 这类关键词——因为原始 URL 里是 `Apple%20News`（URL 转义），
    直接按原始 token 匹配会漏判。这里保持同一语义。
    """
    if token.startswith(HOTKIDS_SURGE_PREFIX):
        return Path(unquote(token[len(HOTKIDS_SURGE_PREFIX):])).stem
    if token.startswith("http"):
        return Path(unquote(token)).stem
    return token


def _sb_resolve_our_stem(token: str) -> str | None:
    """Surge 规则 token → 本仓库自有清单 stem（前提：有对应 sing-box/source/<stem>.json）。

    命中 HotKids Surge RULE-SET URL 或可直接作为文件名的 builtin token 时返回 stem，
    否则（外部 URL / 无对应 source）返回 None，交由静态基座处理或跳过。
    """
    if token.startswith(HOTKIDS_SURGE_PREFIX):
        stem = Path(unquote(token[len(HOTKIDS_SURGE_PREFIX):])).stem
    elif token.startswith("http"):
        return None
    else:
        stem = token
    return stem if (SB_SOURCE_DIR / f"{stem}.json").exists() else None


def _gen_singbox_outbounds(group_lines: list[str], skips: list[str]) -> list[dict]:
    """从 Surge [Proxy Group] 生成 sing-box outbounds。

    - smart/地区组（有 policy-regex-filter）→ urltest（节点占位）
    - include-all-proxies 组（🇺🇳 Server）→ selector（节点占位）
    - policy-path 动作组（🚧 AdGuard）→ 不生成 outbound（规则里用 action:reject）
    - 其余 select → selector，候选里 🔘 DIRECT→🔘 Direct，REJECT 变体丢弃

    地区组（urltest）候选默认填入 SB_EXAMPLE_NODES 对应的示例节点（可直接连通，
    改 server/password 即用）；Server 组（include-all-proxies）候选为全部示例节点。
    未识别的地区组退回占位 tag，需订阅工具注入真实节点。
    """
    selectors, urltests, server = [], [], []
    example_nodes: list[dict] = []
    example_tags: list[str] = []
    placeholder_used = False

    def use_example(regex_filter: str) -> str:
        nonlocal placeholder_used
        found = _sb_example_node_for(regex_filter)
        if not found:
            placeholder_used = True
            return SB_PLACEHOLDER
        tag, domain = found
        if tag not in example_tags:
            example_tags.append(tag)
            example_nodes.append(_sb_example_outbound(tag, domain))
        return tag

    for line in group_lines:
        if line.startswith("#"):
            continue
        g = parse_group_line(line)
        if not g:
            continue
        name = g["name"]
        if any(kw in name for kw in SB_SKIP_GROUP_KW) or _is_skipped(name, skips):
            continue
        params = g["params"]
        if "policy-path" in params:                       # 动作组 → 规则里处理
            continue
        if "policy-regex-filter" in params:               # 地区组
            urltests.append({"type": "urltest", "tag": name,
                             "outbounds": [use_example(params["policy-regex-filter"])],
                             "url": "https://www.gstatic.com/generate_204", "interval": "180s"})
        elif params.get("include-all-proxies", "").lower() in ("true", "1"):
            server.append({"type": "selector", "tag": name, "outbounds": []})  # 候选下方回填
        else:
            outs = []
            for p in g["proxies"]:
                if p == "🔘 DIRECT":
                    outs.append(SB_DIRECT_TAG)
                elif p in ("⛔️ REJECT", "📛 REJECT-DROP"):
                    continue
                else:
                    outs.append(p)
            selectors.append({"type": "selector", "tag": name, "outbounds": outs})

    for s in server:                                       # Server 组候选 = 全部示例节点
        s["outbounds"] = list(example_tags) or [SB_PLACEHOLDER]  # 复制，避免多个组共享同一列表

    tail = [*example_nodes, {"type": "direct", "tag": SB_DIRECT_TAG}]
    if placeholder_used:
        tail.append({"type": "direct", "tag": SB_PLACEHOLDER})
    return [*selectors, *server, *urltests, *tail]


def _sb_policy_target(policy: str, out_tags: set[str]) -> dict | None:
    """Surge 策略 → sing-box 规则动作字段：DIRECT/拦截包装策略/已生成出站，否则 None（跳过）。"""
    if policy == "🔘 DIRECT":
        return {"outbound": SB_DIRECT_TAG}
    if policy in ("🚧 AdGuard", "⛔️ REJECT"):
        return {"action": "reject"}
    if policy == "📛 REJECT-DROP":
        return {"action": "reject", "method": "drop"}
    if policy in out_tags:
        return {"outbound": policy}
    return None


def _gen_singbox_rules(
    rule_lines: list[str], out_tags: set[str], skips: list[str]
) -> tuple[list[dict], list[dict]]:
    """从 Surge [Rule] 生成完整 route.rules + rule_set。

    - PROTOCOL,QUIC → {protocol:quic, action:reject}
    - SSH（AND DEST-PORT 22 + TCP）→ {network:tcp, port:22, outbound:🔘 Direct}
    - RULE-SET/DOMAIN-SET 自有清单 → 我方 .srs
    - Loyalsoldier private.txt → 内建 ip_is_private
    - Loyalsoldier proxy/direct/cncidr、VirgilClyne ASN.China → SagerNet 规则集
    - 其余外部规则集（reject/HTTPDNS/ConnersHua/speedtest 等）→ 跳过
    - FINAL / IP-CIDR 保护 / 注释 → 跳过（FINAL 由基座 route.final 承载）
    sniff / hijack-dns 属 sing-box 专属基础设施，无 Surge 等价，留在基座。
    """
    rules: list[dict] = []
    sets: list[dict] = []
    seen_sets: set[str] = set()

    def add_set(tag: str, url: str, fmt: str = "binary") -> None:
        if tag not in seen_sets:
            seen_sets.add(tag)
            sets.append({"type": "remote", "tag": tag, "format": fmt,
                         "url": url, "download_detour": SB_DIRECT_TAG, "update_interval": "1440m"})

    for line in rule_lines:
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        parts = [p.strip() for p in s.split(",")]
        rtype = parts[0].upper()

        if rtype == "PROTOCOL" and len(parts) > 1 and parts[1].upper() == "QUIC":
            rules.append({"protocol": "quic", "action": "reject"})
            continue
        if rtype == "AND" and "DEST-PORT,22" in s.replace(" ", "") and "PROTOCOL,TCP" in s.replace(" ", ""):
            rules.append({"network": "tcp", "port": 22, "outbound": SB_DIRECT_TAG})
            continue
        if rtype not in ("RULE-SET", "DOMAIN-SET") or len(parts) < 3:
            continue

        token, policy = parts[1], parts[2]
        if _should_skip([token, _sb_human_name(token), policy], skips):
            continue
        target = _sb_policy_target(policy, out_tags)
        if target is None:
            continue

        stem = _sb_resolve_our_stem(token)
        if stem:                                           # 自有清单 → 我方 .srs
            if stem in seen_sets:
                continue
            add_set(stem, SB_SRS_PREFIX + quote(stem) + ".srs")
            rules.append({"rule_set": stem, **target})
        elif _SB_PRIVATE_TOKEN in token:                   # 私有网络 → 内建规则
            rules.append({"ip_is_private": True, **target})
        else:                                              # 外部规则集 → 官方等价规则集或跳过
            ext = next((v for k, v in _SB_EXTERNAL_SETS.items() if k in token), None)
            if not ext or ext[0] in seen_sets:
                continue
            add_set(*ext)
            rules.append({"rule_set": ext[0], **target})

    return rules, sets


def _sync_singbox(config: dict, group_lines: list[str], rule_lines: list[str]) -> None:
    """生成 sing-box/config.json：静态基座 splice 生成的 outbounds / 服务规则。"""
    if not SB_BASE_JSON.exists():
        return
    print("\n── sync-config: Surge Profile → sing-box config.json ──")
    skips = config.get("global_skips", []) + config.get("Clash", {}).get("skips", [])
    base = json.loads(SB_BASE_JSON.read_text(encoding="utf-8"))

    outbounds = _gen_singbox_outbounds(group_lines, skips)
    out_tags = {o["tag"] for o in outbounds}
    gen_rules, gen_sets = _gen_singbox_rules(rule_lines, out_tags, skips)

    base["outbounds"] = outbounds
    rules = base["route"]["rules"]
    rules[rules.index("__RULES__"):rules.index("__RULES__") + 1] = gen_rules
    rs = base["route"]["rule_set"]
    rs[rs.index("__RULE_SETS__"):rs.index("__RULE_SETS__") + 1] = gen_sets

    # 引用自洽校验（生成期即失败，避免推出坏配置）
    set_tags = {r["tag"] for r in base["route"]["rule_set"]}
    for o in outbounds:
        for ref in o.get("outbounds", []):
            assert ref in out_tags, f"outbound {o['tag']} 引用不存在: {ref}"
    for r in base["route"]["rules"]:
        if isinstance(r, str):
            raise AssertionError(f"未替换的哨兵: {r}")
        if "outbound" in r:
            assert r["outbound"] in out_tags, f"rule 引用不存在出站: {r['outbound']}"
        for t in (lambda x: [x] if isinstance(x, str) else x or [])(r.get("rule_set")):
            assert t in set_tags, f"rule 引用不存在 rule_set: {t}"
    assert base["route"]["final"] in out_tags
    for srv in base.get("dns", {}).get("servers", []):
        if "detour" in srv:
            assert srv["detour"] in out_tags, f"dns server {srv['tag']} detour 引用不存在: {srv['detour']}"

    body = json.dumps(base, ensure_ascii=False, indent=2) + "\n"
    changed = _write_if_changed(SB_CONFIG_OUT, body)
    print(f"  outbounds={len(outbounds)} | rules={len(gen_rules)} | rule_set={len(gen_sets)}")
    print(f"  {'✓ sing-box/config.json 已更新' if changed else '✓ sing-box/config.json 无变化'}")


# ---------------------------------------------------------------------------
# 主函数
# ---------------------------------------------------------------------------

def main() -> None:
    config = parse_sync_txt()

    surge_src = config.get("Surge", {}).get("source")
    if not surge_src:
        raise ValueError("Surge 块缺少 >> 源文件路径指令")

    proxy_lines, group_lines, rule_lines, surge_mitm_lines, general_lines = \
        parse_surge_profile(REPO_ROOT / surge_src)
    print(f"  Surge: {len(group_lines)} groups, {len(rule_lines)} rules")

    _sync_clash(config, proxy_lines, group_lines, rule_lines)
    _sync_loon(config, proxy_lines, group_lines, rule_lines, surge_mitm_lines)
    _sync_qx(config, proxy_lines, group_lines, rule_lines, surge_mitm_lines)
    _sync_surfboard(config, proxy_lines, group_lines, rule_lines, general_lines, surge_src)
    _sync_singbox(config, group_lines, rule_lines)


if __name__ == "__main__":
    main()
