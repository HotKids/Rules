"""Configuration generation: common."""

from datetime import datetime, timezone, timedelta
from pathlib import Path
import re

REPO_ROOT = Path(__file__).resolve().parents[3]


SYNC_CONFIG_TXT = REPO_ROOT / ".github" / "scripts" / "sync-config.txt"


HOTKIDS_SURGE_PREFIX = "https://raw.githubusercontent.com/HotKids/Rules/master/Surge/RULE-SET/"


HOTKIDS_CLASH_PREFIX = "https://raw.githubusercontent.com/HotKids/Rules/master/Clash/RuleSet/"


HOTKIDS_QX_FILTER_PREFIX = "https://raw.githubusercontent.com/HotKids/Rules/master/Quantumult/X/Filter/"


CLASH_UNSUPPORTED_RULE_TYPES = {"URL-REGEX", "USER-AGENT"}


# 注释掉的规则中，这些类型在 Clash 里同样不支持，直接丢弃（不入待输出缓冲区）
_COMMENT_DROP_TYPES = CLASH_UNSUPPORTED_RULE_TYPES | {"AND", "OR", "NOT"}


_SURGE_FLAGS = {"extended-matching", "pre-matching", "force-remote-dns", "no-alert", "enhanced-mode"}


RAW_PREFIX = "https://raw.githubusercontent.com/"


# Surfboard（Android）不适用的 Surge iOS/macOS 专属 General key
# Surge 内建动作名（proxy value 为这些时视为 action proxy）
_SURGE_BUILTIN_ACTIONS = frozenset({"direct", "reject", "reject-tinygif", "reject-drop", "reject-no-drop"})


# Loon 支持的内建动作及其值映射（Surge lowercase → Loon format）
_LOON_SUPPORTED_ACTIONS = frozenset({"direct", "reject"})


_LOON_ACTION_VALUE_MAP = {"direct": "DIRECT", "reject": "REJECT",
                          "reject-tinygif": "REJECT", "reject-drop": "REJECT-DROP", "reject-no-drop": "REJECT"}


_CLASH_SUPPORTED_ACTIONS = frozenset({"direct", "reject", "reject-drop"})


# Surge → Clash 规则类型重命名（含 AND 子规则）
_CLASH_TYPE_RENAMES = {"DEST-PORT": "DST-PORT", "PROTOCOL": "NETWORK"}


# Surge PROTOCOL 值 → Clash NETWORK 值（不支持的值 → 跳过该规则）
_SURGE_PROTOCOL_TO_NETWORK = {"TCP": "TCP", "UDP": "UDP"}


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


# ---------------------------------------------------------------------------
# 通用工具
# ---------------------------------------------------------------------------

_CST = timezone(timedelta(hours=8))


# 冒号后的空格可选：loon/qx 头部经 _process_builtin_* 的 rstrip 会去除
# 空占位 `# Date: ` 的尾空格变成 `# Date:`，仍需能匹配并写入时间戳。
_DATE_LINE_RE = re.compile(r"^# Date:.*$", re.MULTILINE)


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
    content = _inject_general(content)
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
            or 0x2300 <= cp <= 0x23FF  # 杂项技术符号（如 ⏱）
            or 0x2600 <= cp <= 0x27BF  # 杂项符号
            or 0xFE00 <= cp <= 0xFE0F  # 变体选择符
            or 0x1F1E0 <= cp <= 0x1F1FF  # 区域指示符（国旗）
        ):
            result = result[1:].lstrip()
        else:
            break
    return result.strip()


# ---------------------------------------------------------------------------
# URL 映射
# ---------------------------------------------------------------------------

def _expand_shorthand(s: str) -> str:
    """如果不是完整 URL，则补全为 raw.githubusercontent.com 前缀。"""
    if s.startswith("http"):
        return s
    return RAW_PREFIX + s.rstrip("/") + "/"


def map_surge_url(url: str, url_maps: list[tuple[str, str]], prefer_mrs: bool = False) -> str | None:
    """将 Surge 规则 URL 转换为 Clash URL。

    优先级：
    1. 完整 URL 精确匹配（显式声明最优先，可覆盖 HotKids 自动映射）
    2. HotKids 自动映射（prefer_mrs=True 时指向 CI 编译的 .mrs——DOMAIN-SET 源
       必为 domain payload，mrs 编译步必然覆盖）
    3. 最长前缀匹配
    4. 仓库简写（非 http 左侧）匹配
    返回 None 表示无法映射。
    """
    # 1. 完整 URL 精确匹配
    for left, right in url_maps:
        if left.startswith("http") and url == left:
            return right

    # 2. HotKids 自动映射（摊平子目录，与 sync-rules.py 输出一致）
    if HOTKIDS_SURGE_PREFIX in url:
        rest = url[url.index(HOTKIDS_SURGE_PREFIX) + len(HOTKIDS_SURGE_PREFIX):]
        basename = rest.rsplit("/", 1)[-1] if "/" in rest else rest
        for ext in (".list", ".yaml"):
            if basename.endswith(ext):
                basename = basename[: -len(ext)]
                break
        return HOTKIDS_CLASH_PREFIX + basename + (".mrs" if prefer_mrs else ".yaml")

    # 3. 最长前缀匹配
    best_len = 0
    best_result: str | None = None
    for left, right in url_maps:
        if not left.startswith("http"):
            continue
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


# ── [General] 跨平台设置的单一来源注入 ──────────────────────────────
# 各平台基座（loon.ini / qx.ini）用 @@占位符@@ 引用 Profile.conf [General] 的规范值，
# 生成时统一替换，避免同一设置在多个基座里手工维护/漂移。
_GENERAL_INJECT: dict[str, str] = {}


def _general_value(general_lines: list[str], key: str) -> str:
    """从 Profile.conf [General] 提取 `key = value` 的 value（忽略注释行）。"""
    for line in general_lines:
        s = line.strip()
        if s.startswith("#") or "=" not in s:
            continue
        k, _, v = s.partition("=")
        if k.strip() == key:
            return v.strip()
    return ""


def _build_general_inject(general_lines: list[str]) -> dict[str, str]:
    """从 Profile.conf [General] 构造占位符 → 规范值映射。

    单一来源的作用域是「受限的」：只覆盖真正跨平台同构、可扁平复用的项
    （测速 url、超时、fallback-dns、geoip mmdb），注入进扁平配置的
    Loon / QX / Surfboard / sing-box 基座，以及 clash.ini 里 provider 的
    health-check.url（Clash 全局唯一的测速 url，同样单一来源）。

    刻意不覆盖 Clash 的 DNS / geox-url：这些由 Clash/General.yaml 自管。
    Clash 的 DNS 模型（nameserver-policy / fallback / fake-ip /
    proxy-server-nameserver）远比 Surge 扁平的 `dns-server` 丰富，
    geox-url 还含 geoip.dat/geosite.dat/asn 等 Surge 无对应的项，
    强行用占位符注入只会破坏而非改善。因此二者是互补边界、非冲突：
    任何一份产物里同一 key 都只有一处定义，不存在竞争。
    """
    dns = _general_value(general_lines, "dns-server")
    dns_lines = "\n".join(f"server={x.strip()}" for x in dns.split(",") if x.strip())
    return {
        "@@PROXY_TEST_URL@@": _general_value(general_lines, "proxy-test-url"),
        "@@DIRECT_TEST_URL@@": _general_value(general_lines, "internet-test-url"),
        "@@TEST_TIMEOUT@@": _general_value(general_lines, "test-timeout"),
        "@@GEOIP_MMDB@@": _general_value(general_lines, "geoip-maxmind-url"),
        "@@FALLBACK_DNS@@": dns,               # 逗号分隔（Loon dns-server 形式）
        "@@FALLBACK_DNS_LINES@@": dns_lines,   # server=X 逐行（QX [dns] 形式）
    }


def _inject_general(text: str) -> str:
    """把基座里的 @@占位符@@ 替换为 Profile.conf [General] 规范值。
    占位符被引用但源值缺失 → 报错，避免静默生成空值坏配置。"""
    for ph, val in _GENERAL_INJECT.items():
        if ph in text:
            if not val:
                raise ValueError(f"占位符 {ph} 被引用，但 Profile.conf [General] 缺少对应值")
            text = text.replace(ph, val)
    return text


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
    for ext in (".yaml", ".yml", ".txt", ".list", ".conf", ".mrs"):
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

    优先级：cidr（文件名含）/ geoip（路径含）→ ipcidr；.txt → domain；其他 → classical
    """
    filename = url.rstrip("/").rsplit("/", 1)[-1].lower()
    stem = filename
    for ext in (".yaml", ".yml", ".txt", ".list", ".conf", ".mrs"):
        if stem.endswith(ext):
            stem = stem[: -len(ext)]
            break
    if "cidr" in stem or "/geoip/" in url.lower():
        return "ipcidr"
    if filename.endswith(".txt"):
        return "domain"
    return "classical"


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


_REGION_CODE = {
    "Hong Kong": "HK",
    "Taiwan": "TW",
    "Singapore": "SG",
    "Japan": "JP",
    "America": "US",
    "Server": "UN",
}
