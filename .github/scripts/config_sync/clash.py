"""Configuration generation: clash."""

from _common import write_if_changed as _write_if_changed
from pathlib import Path
import copy
import json
import re
import yaml
from .common import (
    _REGION_CODE,
    CLASH_UNSUPPORTED_RULE_TYPES,
    HOTKIDS_CLASH_PREFIX,
    HOTKIDS_RAW_BASE,
    PendingHeaders,
    REPO_ROOT,
    _CLASH_BUILTIN_PREFERRED,
    _CLASH_SUPPORTED_ACTIONS,
    _CLASH_TYPE_RENAMES,
    _COMMENT_DROP_TYPES,
    _SURGE_FLAGS,
    _SURGE_PROTOCOL_TO_NETWORK,
    _anchor_matches,
    _apply_gist_reverse_proxy,
    _behavior_from_url,
    _derive_provider_name,
    _fmt_group,
    _is_skipped,
    _load_policy_path_proxy_lines,
    _lan_cache_filename,
    _merge_action_lines,
    _parse_provider_urls,
    _resolve_builtin_from_repo,
    _should_skip,
    _write_stamped_if_changed,
    map_surge_url,
    parse_group_line,
    strip_emoji,
)


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
        # format 显式声明：二进制 mrs 产物（MetaCubeX 官方 / 本仓库 CI 编译）；
        # Sukka Ruleset（ruleset.skk.moe 及其镜像）的 Clash 产物为纯文本；其余 yaml
        if clash_url.endswith(".mrs"):
            entry["format"] = "mrs"
        elif "ruleset.skk.moe" in clash_url:
            entry["format"] = "text"
        else:
            entry["format"] = "yaml"
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
        # Clash 无 REJECT-TINYGIF 内建/wrapper 组，策略降级到 ⛔️ REJECT（有 wrapper group）
        parts = ["⛔️ REJECT" if p == "💢 REJECT-TINYGIF" else p for p in parts]
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
                    # 纯 ipcidr payload 的自有产物（如 LAN → lancidr）必有 CI 编译的 .mrs
                    if behavior == "ipcidr" and clash_url.startswith(HOTKIDS_CLASH_PREFIX):
                        clash_url = clash_url.rsplit(".", 1)[0] + ".mrs"
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

                clash_url = map_surge_url(url_or_builtin, url_maps,
                                          prefer_mrs=(rule_type == "DOMAIN-SET"))
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
            ext = ".mrs" if info.get("format") == "mrs" else ".yaml"
            path_file = f"{pname.replace(' ', '_')}{ext}"
        path_file = _lan_cache_filename(clash_url, path_file)
        rp_lines += [
            f"  {pname}:",
            "    type: http",
            f"    behavior: {behavior}",
            f"    format: {info.get('format', 'yaml')}",
            f"    path: ./Provider/RuleSet/{path_file}",
            f"    url: {clash_url}",
            "    interval: 86400",
            "",
        ]

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
# Clash 覆写脚本（Script.js）：解析生成后的 Mihomo.yaml，转译为等效 JS
# ---------------------------------------------------------------------------

_JS_IDENT_RE = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")


# 已知基础设置的展示顺序；通用键从源配置动态读取，不以此表限制透传范围。
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
            "主 DNS 经 #RULES 走代理拿干净结果，防境外域名泄露给国内 DNS；nameserver-policy 按声明顺序先窄后宽：",
            "内网域名交系统解析器、NTP 用裸 IP UDP（校时不依赖 TLS）、国内域名国内 DoH 就近解析；代理节点/DIRECT 域名同走国内 DoH",
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


# 节点、策略、规则与 YAML 锚点由各自的生成步骤处理，不能作为通用设置重复输出。
_CLASH_STRUCTURAL_KEYS = frozenset({
    "proxies", "proxy-providers", "proxy-groups", "rule-providers", "rules", "anchors",
})


def _clash_base_sections(data: dict) -> list[tuple[str, list[tuple[str, list[str]]]]]:
    """保留既有分节，把源中新增的通用顶层键按声明顺序追加，避免静默丢失。"""
    sections: list[tuple[str, list[tuple[str, list[str]]]]] = []
    known_keys: set[str] = set()
    for section, items in _CLASH_BASE_SECTIONS:
        known_keys.update(key for key, _ in items)
        present = [(key, comments) for key, comments in items if key in data]
        if present:
            sections.append((section, present))
    extra = [(key, []) for key in data
             if key not in known_keys and key not in _CLASH_STRUCTURAL_KEYS]
    if extra:
        sections.append(("其他通用设置", extra))
    return sections


def _js_string(s: str) -> str:
    escaped = (s.replace("\\", "\\\\").replace("'", "\\'")
               .replace("\r", "\\r").replace("\n", "\\n"))
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
    `AND/OR/NOT,(...),POLICY` 策略始终为最后一个逗号分段（括号内的逗号
    不影响判断：策略本身不含逗号，取 -1 仍然成立）；其余类型固定是
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
      因此「移除某组但保留其规则」可以两者搭配（如 📛 REJECT-DROP 组移除、
      其规则落点改指 ⛔️ REJECT）。
    - remove_groups：整组移除（如 📛 REJECT-DROP），同时从其余分组的 proxies 候选
      里剔除对它的引用、移除 rules 中以其为策略目标的行。
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
    - rules_insert：在锚点规则（before/after 子串匹配某条规则）前/后插入自定义
      规则行（如 Telegram 前插 IP-ASN/IP-CIDR 分区分流）。落点分组须已存在、用
      基座 emoji 名书写，后续 rename_map 会一并改写。

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

    # rules_insert：在锚点规则（before/after 子串匹配）前/后插入自定义规则行。
    # 放在最后——落点分组此刻已全部就位（含 extra_pool_groups 新增的 England/Germany
    # 等）。落点用本 overlay 生成态的分组名书写；若被 extends 的下游 overlay 有
    # rename_map（如 clashbox），会在其自身处理里一并把这些新规则的策略级联改名。
    for spec in overlay.get("rules_insert", []):
        new_rules = list(spec.get("rules", []))
        if not new_rules:
            continue
        for r in new_rules:
            parts = r.split(",")
            idx = _rule_policy_index(parts)
            if idx < len(parts):
                _get_group(parts[idx].strip(), f"rules_insert 落点 {r!r}")
        before, after = spec.get("before"), spec.get("after")
        anchor = before if before is not None else after
        if anchor is None:
            raise ValueError(f"{overlay_label} 的 rules_insert 需指定 before 或 after 锚点")
        pos = next((i for i, r in enumerate(rules) if anchor in r), None)
        if pos is None:
            raise ValueError(
                f"{overlay_label} 的 rules_insert 锚点 {anchor!r} 未匹配任何规则"
            )
        at = pos if before is not None else pos + 1
        rules[at:at] = new_rules


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
        "# 自动生成（sync-config.py 从 Clash/Sample.yaml 转译），请勿手动修改；通用设置请修改 Clash/General.yaml，策略/规则请修改 Surge/Profile.conf。",
        "",
    ]

    # 与 Script.js 共用分节，源中的新增通用字段同样透传。
    for section, items in _clash_base_sections(cfg):
        L.append(f"# ── {section} ──")
        L.append("")
        for key, comments in items:
            for cline in comments:
                L.append(f"# {cline}")
            L.append(f"{_yaml_flow(key)}: {_yaml_flow(cfg[key])}")
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
        "  - &UrlTest {type: url-test, interval: 300, tolerance: 20, lazy: true, url: '@@PROXY_TEST_URL@@', timeout: 2000, max-failed-times: 3, include-all-providers: true, hidden: true}",
        "  - &FallBack {type: fallback, interval: 300, lazy: true, url: '@@PROXY_TEST_URL@@', timeout: 2000, max-failed-times: 3, include-all-providers: true, hidden: true}",
        "  - &LoadBalance {type: load-balance, interval: 300, lazy: true, strategy: consistent-hashing, url: '@@PROXY_TEST_URL@@', timeout: 2000, max-failed-times: 3, include-all-providers: true, hidden: true}",
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
        L.append(f"  {name}: {{<<: *Remote, behavior: {rp['behavior']}, format: {rp.get('format', 'yaml')}, "
                 f"path: {_yaml_flow(rp['path'])}, url: {_yaml_flow(rp['url'])}}}")
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

    用于 Clash Verge Rev / FlClash / Bettbox 等支持「Enhance Script」的客户端：直接对任意订阅（如
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
    _rp_order = ("type", "behavior", "format", "path", "url", "interval", "proxy")
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
    # 给既有分组（如 📧 Mail）追加 filter 只是使其一并纳入全部节点，不改变它本来是
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
    # 被其他分组引用的结构性池组（Server / 地区）同样视为核心组，均不纳入可选开关。
    # 无人引用的叶子池组（如 ⏱️ Speedtest，仅自身规则使用）可以开关。
    main_group_name = next((r.split(",", 1)[1] for r in rules if r.startswith("MATCH,")), None)
    referenced_names = {p for g in groups for p in (g.get("proxies") or [])}
    optional_group_names = [
        g["name"] for g in groups
        if not g.get("hidden") and g["name"] != main_group_name
        and (g["name"] not in structural_pool_names or g["name"] not in referenced_names)
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
            " * 自动生成，请勿手动修改：由 sync-config.py 从 Surge/Profile.conf 与 Clash/General.yaml（经",
            f" * Clash/Mihomo.yaml）叠加 sync-config/Enhanced/{overlay_label}（私人差异声明）",
            " * 而来，直接修改本文件将在下次同步时被覆盖。通用设置请修改 Clash/General.yaml；",
            " * 策略/规则请修改 Surge/Profile.conf；",
            " * 私人差异（改名 / 换图标 / 额外分组 / 分组类型 / 候选节点 / 默认开关等）",
            f" * 请改 {overlay_label}。",
        ]
    else:
        source_lines = [
            " * 自动生成，请勿手动修改：由 sync-config.py 从 Surge/Profile.conf 与 Clash/General.yaml（经",
            " * Clash/Mihomo.yaml）转译而来，直接修改本文件将在下次同步时被覆盖；",
            " * 通用设置请修改 Clash/General.yaml，策略/规则请修改 Surge/Profile.conf。",
        ]

    lines = [
        "/**",
        " * mihomo 覆写脚本（Enhance Script）· HotKids/Rules",
        " *",
        " * 用途：在 Clash Verge Rev / FlClash / Bettbox 等支持「覆写脚本」的 mihomo 客户端里，对任意订阅",
        " * （如 https://sub.hotkids.me）动态套用本仓库 Surge/Profile.conf 与 Clash/General.yaml 的",
        " * 策略组、分流规则与基础设置，不必依赖机场自带配置。",
        " *",
        *source_lines,
        " *",
        " * 本地唯一可临时修改的是下方 ruleOptionsEnable 的取值，用于按需开关某个分组。",
        " *",
        " * 仓库：https://github.com/HotKids/Rules",
        " */",
        "",
        "// 适配 Bettbox 自定义配置参数",
        "const Compatible_With_Bettbox = { ruleOptionsEnable: true };",
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
    # 基础设置：分节 + 注释与 Mihomo.yaml 共享同一来源，新通用键不另设白名单，
    # 单行紧凑输出（与锚点版的 flow 单行风格对齐）
    for section, items in _clash_base_sections(data):
        lines.append(f"  // ── {section} ──")
        for key, comments in items:
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
