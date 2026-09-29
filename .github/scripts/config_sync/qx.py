"""Configuration generation: qx."""

from pathlib import Path
import re
from .common import (
    HOTKIDS_QX_FILTER_PREFIX,
    HOTKIDS_SURGE_PREFIX,
    PendingHeaders,
    REPO_ROOT,
    _COMMENT_DROP_TYPES,
    _anchor_matches,
    _derive_tag,
    _is_skipped,
    _rename_lookup,
    _should_skip,
    _write_stamped_if_changed,
    parse_group_line,
    strip_emoji,
)


# ---------------------------------------------------------------------------
# 生成 QX [policy]
# ---------------------------------------------------------------------------

# QX 无 reject-drop 变体（→ reject）；有 reject-tinygif 原生支持（保留）
_QX_PROXY_MAP = {"🚫 REJECT": "reject", "⛔️ REJECT": "reject",
                 "📛 REJECT-DROP": "reject", "💢 REJECT-TINYGIF": "reject-tinygif",
                 "🔘 DIRECT": "direct"}


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

    # select + 借全量节点池（如 ⏱️ Speedtest ← 🇺🇳 Server）→ 全节点 server-tag-regex
    if gtype == "select" and "include-other-group" in params and not params.get("policy-regex-filter"):
        return f"static={emit_name}, server-tag-regex=.*{icon_part}"

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


