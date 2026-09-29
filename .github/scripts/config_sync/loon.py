"""Configuration generation: loon."""

from .common import (
    _REGION_CODE,
    PendingHeaders,
    REPO_ROOT,
    _COMMENT_DROP_TYPES,
    _LOON_ACTION_VALUE_MAP,
    _LOON_SUPPORTED_ACTIONS,
    _anchor_matches,
    _derive_tag,
    _is_skipped,
    _rename_lookup,
    _resolve_builtin_from_repo,
    _should_skip,
    _write_stamped_if_changed,
    parse_group_line,
    strip_emoji,
)


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


# ---------------------------------------------------------------------------
# 生成 Loon [Proxy Group]
# ---------------------------------------------------------------------------

# 地区代码表：组名（去 emoji）→ 代码，供 Loon [Remote Filter] tag 与 Clash 锚点版
# （Mihomo.yaml）的 &Filter<code> 共用命名。未列出的组回退为组名（去 emoji 去空格）。


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
        # select + 借全量节点池（如 ⏱️ Speedtest ← 🇺🇳 Server）→ 全节点 Filter
        if gtype == "select" and not params.get("policy-regex-filter"):
            fm_val = filter_map.get(name, "FilterUN")
            filter_name = fm_val.split(",")[0].strip()
            return f"{name} = select,{filter_name}{icon_part}"
        return None  # 其余由 builtin inject_names 或 FilterMap 覆盖

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
        # Loon 支持 REJECT-DROP；无 REJECT-TINYGIF，降级到 REJECT
        emit_policy = {"📛 REJECT-DROP": "REJECT-DROP", "💢 REJECT-TINYGIF": "REJECT"}.get(policy, policy)
        out.append(f"{url}, policy={emit_policy}, tag={tag}, enabled=true")

    return "\n".join(out)


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


