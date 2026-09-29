"""Configuration generation: singbox."""

from _common import write_if_changed as _write_if_changed
from pathlib import Path
from urllib.parse import quote, unquote
import json
from .common import (
    HOTKIDS_SURGE_PREFIX,
    REPO_ROOT,
    _inject_general,
    _is_skipped,
    _should_skip,
    parse_group_line,
)


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
SB_SKIP_GROUP_KW = ("Gateway", "Apple TV")


# 各地区示例节点（占位用途：sing-box 无订阅机制，先内置一份可直接连通的示例
# Shadowsocks 节点，便于直接修改 server/password 试用；真实使用请用订阅工具替换）
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
    # Loyalsoldier reject 已由 sync-rules # >> Clash 收编（Clash/RuleSet/Reject.yaml +
    # sing-box/source/Reject.json），此处映射到本仓库编译的 .srs
    "surge-rules/release/reject.txt": (
        "Reject", "https://raw.githubusercontent.com/HotKids/Rules/master/sing-box/rule-set/Reject.srs", "binary"),
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
                             "url": "@@PROXY_TEST_URL@@", "interval": "180s",
                             "tolerance": 50})
        elif params.get("include-all-proxies", "").lower() in ("true", "1"):
            server.append({"type": "selector", "tag": name, "outbounds": []})  # 候选下方回填
        else:
            outs = []
            for p in g["proxies"]:
                if p == "🔘 DIRECT":
                    outs.append(SB_DIRECT_TAG)
                elif p in ("⛔️ REJECT", "📛 REJECT-DROP", "💢 REJECT-TINYGIF"):
                    continue
                else:
                    outs.append(p)
            # 无静态候选的 include-other-group 组（如 ⏱️ Speedtest ← 🇺🇳 Server）→ 嵌套目标组
            if not outs and (other := params.get("include-other-group", "")):
                outs = [other]
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
    if policy in ("🚧 AdGuard", "⛔️ REJECT", "💢 REJECT-TINYGIF"):
        return {"action": "reject"}  # sing-box 无 tinygif，REJECT-TINYGIF 降级为 reject
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
            # 境外 QUIC 拦截、国内放行（geosite-cn/geoip-cn 反选；
            # reject 默认方式回 RST/ICMP 促使快速回退 TCP）
            rules.append({
                "type": "logical",
                "mode": "and",
                "rules": [
                    {"protocol": "quic"},
                    {"rule_set": ["geosite-cn", "geoip-cn"], "invert": True},
                ],
                "action": "reject",
            })
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

    body = _inject_general(json.dumps(base, ensure_ascii=False, indent=2) + "\n")
    changed = _write_if_changed(SB_CONFIG_OUT, body)
    print(f"  outbounds={len(outbounds)} | rules={len(gen_rules)} | rule_set={len(gen_sets)}")
    print(f"  {'✓ sing-box/config.json 已更新' if changed else '✓ sing-box/config.json 无变化'}")


