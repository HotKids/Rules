"""Configuration generation: surfboard."""

from .common import (
    PendingHeaders,
    REPO_ROOT,
    _COMMENT_DROP_TYPES,
    _SURGE_FLAGS,
    _anchor_matches,
    _filter_proxy_lines_for_platform,
    _is_skipped,
    _parse_surge_alt_groups,
    _should_skip,
    _write_stamped_if_changed,
    parse_group_line,
)


# Surfboard 不支持的规则类型（Android 无 MITM，无 IPv6 实现；DOMAIN-REGEX 未记录）
SURFBOARD_UNSUPPORTED_RULE_TYPES = {"URL-REGEX", "USER-AGENT", "GEOSITE", "IP-CIDR6", "DOMAIN-REGEX"}


# Surfboard 支持的内建动作（无 MITM，不支持 TINYGIF/DROP）
_SURFBOARD_SUPPORTED_ACTIONS = frozenset({"direct", "reject"})


# Surfboard [General] 白名单：仅保留这些 key
_SURFBOARD_KEEP_GENERAL_KEYS = frozenset({
    "dns-server", "doh-server", "skip-proxy", "proxy-test-url", "always-real-ip",
})


# Surge key → Surfboard 等价 key（重命名）
_SURFBOARD_GENERAL_KEY_RENAMES = {"encrypted-dns-server": "doh-server"}


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


_SURFBOARD_SKIP_PARAMS = {"icon-url", "evaluate-before-use", "no-alert", "include-other-group"}


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
        members = list(g["proxies"])
        # Surfboard 无 include-other-group：无静态候选时嵌套目标组（如 ⏱️ Speedtest ← 🇺🇳 Server）
        if not members and (other := g["params"].get("include-other-group", "")):
            members = [other]
        tokens = [gtype] + members
        params = dict(g["params"])
        # smart → url-test 降级时显式补 Surge 系默认容差，避免依赖 Surfboard 的隐式默认
        if g["type"] == "smart":
            params.setdefault("tolerance", "100")
        for k, v in params.items():
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
        # policy-path 定义的拦截包装策略 → 内建动作（策略可能不在行尾，如后接 no-resolve）
        # REJECT-DROP → REJECT（Surfboard 无 DROP）；REJECT-TINYGIF 为 Surfboard 原生支持，保留
        keep = [{"📛 REJECT-DROP": "REJECT", "💢 REJECT-TINYGIF": "REJECT-TINYGIF"}.get(p, p) for p in keep]
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


