"""Configuration generation: stash."""

from pathlib import Path
import ipaddress
import json
import re
from urllib.parse import parse_qsl, quote, urlencode

import yaml

from .common import (
    REPO_ROOT,
    _write_stamped_if_changed,
)


# ---------------------------------------------------------------------------
# Stash 覆写（.stoverride）
# ---------------------------------------------------------------------------
#
# Clash/Stash.stoverride 是 Clash/Sample.yaml 的二次转换产物（与 Clash/Mihomo.yaml
# 同一定位）：保留可用于覆写的源设置、注释与排版，应用 Stash 适配及节点继承策略。
# 共用 Clash/General.yaml 的通用设置；HTTP/MITM 设置来自 Surge/Profile.conf 的实际声明。

# 1) 下列 mihomo 顶层参数未获所核验 Stash 官方 YAML 文档确认，连同前置注释省略。
#    部分对应能力由 Stash 内置或应用设置控制；省略不代表功能不存在或字段确定无效。
#    特别是 ipv6: false 的省略不等价于关闭 Stash IPv6，Tunnel 路由开关也非总开关。
#    proxies 是主动省略的例外：该字段可用于 Stash，此覆写保留基础配置中的节点。
_STASH_DROP_TOP = {
    "mixed-port", "allow-lan", "bind-address", "ipv6", "external-controller",
    "unified-delay", "tcp-concurrent", "find-process-mode", "geodata-loader",
    "global-ua", "keep-alive-interval", "geo-auto-update", "geo-update-interval",
    "geox-url", "profile", "ntp", "sniffer", "tun", "proxies",
}


# 2) 从源配置保留的 DNS 子键；规则路由选项转译为 Stash 的 follow-rule。
_STASH_REPLACE_TOP = {"hosts", "dns", "proxy-providers", "proxy-groups",
                      "rule-providers", "rules"}


_STASH_DNS_KEEP = {
    "default-nameserver", "nameserver", "nameserver-policy",
    "proxy-server-nameserver", "fake-ip-filter",
}


_STASH_DNS_SERVER_PREFIXES = ("https://", "tls://", "quic://", "tcp://", "udp://")


_TOP_KEY_RE = re.compile(r"^([A-Za-z][\w-]*):")


_SUB_KEY_RE = re.compile(r"^(\s+)(['\"]?)([^:'\"]+)\2\s*:")


def _yq(value) -> str:
    """YAML 单引号标量（组名 / filter 正则含 emoji、空格、反斜杠，统一加引号最为稳妥）。"""
    return "'" + str(value).replace("'", "''") + "'"


def _stash_panel_argument(argument: str, defaults: dict, stem: str) -> str:
    """写入受 Stash 支持的 Surge 默认参数，保留任务选择和通知隔离。"""
    args = dict(parse_qsl(argument, keep_blank_values=True))
    if args.get("task") == "logs" or args.get("service") == "logs":
        return argument
    if stem == "ip-security-panel":
        keys = ["risk_api", "local_geoapi", "remote_geoapi", "mask_ip", "tw_flag"]
        # Stash IP 面板仅使用免密钥来源；同步时同时移除旧覆写中的凭据。
        args.pop("ipqs_key", None)
        args.pop("maxmind_key", None)
        defaults = dict(defaults)
        if defaults.get("risk_api", "").lower() == "ipqs":
            defaults["risk_api"] = "ippure"
        if defaults.get("remote_geoapi", "").lower() in {"maxmind", "maxmind-zh"}:
            defaults["remote_geoapi"] = "ipapi-zh"
        if args.get("task") == "monitor":
            keys.append("notify")
        # event_delay / panel_interval 只参与 Surge 事件延迟与点击打码，不用于 Stash。
    elif stem == "media-check-panel":
        keys = ["notify"] if args.get("mode") != "collapsed" else []
        if args.get("service", "all") in ("all", "netflix"):
            keys.append("nfprice")
        if args.get("service", "all") in ("all", "gemini"):
            keys.append("geminiapikey")
        # viu 仅供 Surge 汇总面板使用。
    else:
        return argument
    for key in keys:
        if key in defaults:
            args[key] = defaults[key]
        else:
            args.pop(key, None)
    return urlencode(args, quote_via=quote)


def _sync_stash_panel_metadata() -> None:
    """同名 Surge 面板提供 category/icon 和参数默认值；保留 Stash 布局。"""
    panels = REPO_ROOT / "Surge/Module/Pannel"
    for source in sorted(panels.glob("*.sgmodule")):
        target = source.with_suffix(".stoverride")
        if not target.exists():
            continue
        metadata = {}
        for line in source.read_text(encoding="utf-8").splitlines():
            if line.startswith("["):
                break
            match = re.fullmatch(r"#!(category|icon|arguments)=(.*)", line)
            if match:
                metadata.setdefault(match[1], match[2].strip())
        before = target.read_text(encoding="utf-8")
        # 只替换顶层单行元数据，不能改动 tiles 内的 icon。
        lines = [line for line in before.splitlines()
                 if not re.match(r"^(category|icon):", line)]
        at = lines.index("tiles:")
        lines[at:at] = [f"{key}: {_yq(metadata[key])}" for key in ("category", "icon")
                        if metadata.get(key)]
        defaults = {}
        for item in metadata.get("arguments", "").split(","):
            key, separator, value = item.partition(":")
            if separator:
                defaults.setdefault(key.strip(), value.strip())
        for index, line in enumerate(lines):
            match = re.match(r"^(\s+argument:)\s*(.*)$", line)
            if match:
                argument = yaml.safe_load(match[2])
                resolved = _stash_panel_argument(argument, defaults, source.stem)
                if resolved != argument:
                    lines[index] = f"{match[1]} {_yq(resolved)}"
        after = "\n".join(lines) + "\n"
        if after != before:
            target.write_text(after, encoding="utf-8")
            print(f"  ✓ {target.relative_to(REPO_ROOT)} 面板分类/图标/默认参数已同步")


def _stash_clean_nameserver(server: str) -> str:
    """Stash 官方未定义 mihomo 的 nameserver 策略后缀（#RULES / #策略名）；
    只保留官方定义的 h3= 选项，移除 mihomo 策略片段。"""
    if "#" not in server:
        return server
    base, frag = server.split("#", 1)
    options = [part for part in frag.split("&") if part.startswith("h3=")]
    return base + ("#" + "&".join(options) if options else "")


def _stash_is_dns_server(server: str) -> bool:
    """识别 Stash 支持的协议 URL 或裸 IP（可含端口），不匹配普通域名。"""
    base = server.partition("#")[0]
    if base.startswith(_STASH_DNS_SERVER_PREFIXES):
        return True
    try:
        ipaddress.ip_address(base)
        return True
    except ValueError:
        pass
    if base.startswith("["):
        match = re.fullmatch(r"\[([^]]+)\](?::(\d+))?", base)
        if not match:
            return False
        host, port = match.groups()
    else:
        host, sep, port = base.rpartition(":")
        if not sep or not port.isdigit():
            return False
    if port is not None and not 1 <= int(port) <= 65535:
        return False
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def _stash_dns_follow_rule(dns: dict) -> bool:
    """只从普通 DNS 查询的路由要求推导；引导/节点解析使用独立链路。"""
    if dns.get("respect-rules") is True:
        return True
    values = [dns.get("nameserver", [])]
    values.extend((dns.get("nameserver-policy") or {}).values())
    for value in values:
        for server in value if isinstance(value, list) else [value]:
            if isinstance(server, str) and _stash_is_dns_server(server):
                if "RULES" in server.partition("#")[2].split("&"):
                    return True
    return False


def _stash_clean_dns_line(line: str) -> str:
    """按 YAML 标量位置清理服务器片段，保留缩进、引号风格和行尾注释。"""
    if "#" not in line:
        return line
    tokens = list(yaml.scan(line))
    for i in reversed(range(len(tokens))):
        token = tokens[i]
        if not isinstance(token, yaml.tokens.ScalarToken) \
                or not _stash_is_dns_server(token.value):
            continue
        if i + 1 < len(tokens) and isinstance(tokens[i + 1], yaml.tokens.ValueToken):
            # nameserver-policy 域名键不能当作 DNS 服务器标量改写。
            continue
        cleaned = _stash_clean_nameserver(token.value)
        if cleaned == token.value:
            continue
        rendered = (_yq(cleaned) if token.style == "'"
                    else json.dumps(cleaned, ensure_ascii=False) if token.style == '"'
                    else cleaned)
        line = line[:token.start_mark.column] + rendered + line[token.end_mark.column:]
    return line


def _stash_comment_out(lines: list[str], top_key: str) -> list[str]:
    """将某个顶层块整体注释掉（内容保留，需要时取消注释即可启用）。"""
    start = next((i for i, l in enumerate(lines) if re.match(rf"^{re.escape(top_key)}:", l)), -1)
    if start < 0:
        return lines
    end = next((i for i in range(start + 1, len(lines))
                if lines[i] and not lines[i].startswith((" ", "#"))), len(lines))
    out = list(lines)
    for i in range(start, end):
        if out[i].strip():
            # 该块整体停用，无需保留 #!replace 标记
            out[i] = "# " + out[i].replace(" #!replace", "")
    return out


def _stash_http(lines: list[str], surge_mitm_lines: list[str], general_lines: list[str]) -> list[str]:
    """同步模板实际声明的 CA 和强制 HTTP 引擎列表，按子键合并。"""
    fields = {"ca-p12": "ca", "ca-passphrase": "ca-passphrase"}
    settings = {}
    for line in surge_mitm_lines:
        key, sep, value = line.strip().partition("=")
        if sep and key.strip() in fields:
            settings[fields[key.strip()]] = value.strip()
    for line in general_lines:
        key, sep, value = line.strip().partition("=")
        if sep and key.strip() == "force-http-engine-hosts":
            settings["force-http-engine"] = list(dict.fromkeys(
                host.strip() for host in value.split(",") if host.strip()))
    if not settings:
        return lines

    # 若上游已有 HTTP 设置，仅合并本次从 Surge 读取的字段。
    start = next((i for i, line in enumerate(lines) if line.startswith("http:")), len(lines))
    end = next((i for i in range(start + 1, len(lines))
                if _TOP_KEY_RE.match(lines[i])), len(lines))
    # 后续块的说明不属于 http。
    while end > start and (not lines[end - 1].strip() or lines[end - 1].startswith("#")):
        end -= 1
    http = (yaml.safe_load("\n".join(lines[start:end])) or {}).get("http") or {}
    http.update(settings)
    order = ("force-http-engine", "ca", "ca-passphrase", "mitm", "url-rewrite", "header-rewrite", "body-rewrite", "mock", "script")
    http = {key: http[key] for key in (*order, *http) if key in http}
    block = yaml.safe_dump({"http": http}, allow_unicode=True, sort_keys=False).rstrip().splitlines()
    # Official example: mode/log-level → http → cron/scripts/hosts/dns → proxies/rules.
    # Move the whole block instead of appending certificates after MATCH.
    remaining = lines[:start] + lines[end:]
    following = {"cron", "script-providers", "script", "hosts", "dns", "proxies", "proxy-groups", "proxy-providers", "rule-providers", "rules"}
    insert_at = next((i for i, line in enumerate(remaining)
                      if line.split(":", 1)[0] in following), len(remaining))
    while insert_at > 0 and (not remaining[insert_at - 1].strip() or remaining[insert_at - 1].startswith("#")):
        insert_at -= 1
    block = ["", "# HTTP 设置由 Surge/Profile.conf 的实际声明同步；MITM CA 仍需设备安装并信任。"] + block + [""]
    return remaining[:insert_at] + block + remaining[insert_at:]


def _sync_stash(config: dict, surge_mitm_lines: list[str], general_lines=()) -> None:
    """Clash/Sample.yaml → Clash/Stash.stoverride（只改 Stash 与 mihomo 的差异点）。"""
    out_path = config.get("Stash", {}).get("output")
    clash_out = config.get("Clash", {}).get("output")
    if not out_path or not clash_out:
        return
    base_path = REPO_ROOT / clash_out
    if not base_path.exists():
        return

    print("\n── sync-config: Clash Sample.yaml → Stash .stoverride ──")
    src = base_path.read_text(encoding="utf-8").splitlines()
    source_dns = (yaml.safe_load("\n".join(src)) or {}).get("dns") or {}
    follow_rule = _stash_dns_follow_rule(source_dns)

    out: list[str] = []
    buf: list[str] = []          # 待决的注释 / 空行（跟随其后的键一起保留或丢弃）
    top = ""                     # 当前顶层键
    keep_top = True
    dns_keep = True              # dns 块内当前子键是否保留
    dns_key = ""                 # 当前 DNS 子键，fake-ip-filter 不清理服务器片段
    policy_split: list[str] | None = None   # 逗号拼接键待展开的域名
    policy_val: list[str] = []              # 该键的值行
    policy_tail = ""                       # 原键行的空格/注释
    skip_use_items = False                  # use: 的列表项（已换成 include-all）
    skip_provider_health = False            # Provider 健康检查由 Stash 策略组接管
    changes: list[str] = []

    def flush() -> None:
        # 省略某个键时，其两侧的空行会在删除处相邻叠加；此处舍弃与已输出空行相邻的
        # 前导空行，避免出现源文件没有的空行堆积（源本身的空行结构保持不变）。
        while buf and not buf[0].strip() and out and not out[-1].strip():
            buf.pop(0)
        out.extend(buf)
        buf.clear()

    # 文件头（首个顶层键之前的注释/空行，含 # Clash / # Date / # Author / # 通用设置）
    # 始终保留：其不属于任何键，不应随被省略的首个键一同丢失。
    first_key = next((i for i, l in enumerate(src) if _TOP_KEY_RE.match(l)), 0)
    header = [l.rstrip() for l in src[:first_key]]
    if header and header[0].startswith("# Clash"):
        del header[0]
    header = [l for l in header if not l.startswith("# Author:")]
    # 紧贴首个键的那段注释是该键的说明（首个键必为被省略的 mixed-port），
    # 一并省略，避免遗留无主注释；靠空行分隔的分区标题（# 通用设置）保留。
    while header and header[-1].lstrip().startswith("#"):
        header.pop()
    out.extend(header)

    for raw in src[first_key:]:
        line = raw.rstrip()
        stripped = line.strip()

        # ── 逗号拼接的 nameserver-policy 键：收集值行后按域名展开 ──
        if policy_split is not None:
            # YAML 允许列表项与所属键采用相同缩进（PyYAML 默认写法）。
            indent = len(line) - len(line.lstrip())
            if indent >= 6 or (indent == 4 and stripped.startswith("- ")):
                policy_val.append(_stash_clean_dns_line(line))
                continue
            for dom in policy_split:
                out.append(f'    "{dom}":{policy_tail}')
                out.extend(policy_val)
            policy_split, policy_val = None, []
            # 继续按普通行处理当前行

        m_top = _TOP_KEY_RE.match(line)
        if m_top:
            top = m_top.group(1)
            skip_provider_health = False
            keep_top = top not in _STASH_DROP_TOP
            if not keep_top:
                buf.clear()
                changes.append(f"略去 {top}")
                continue
            flush()
            out.append(f"{line} #!replace" if top in _STASH_REPLACE_TOP else line)
            if top == "dns":
                # Stash 没有逐上游 #RULES；主解析跟随规则，节点解析仍使用独立链路。
                routed = "true" if follow_rule else "false"
                out += [
                    ("  # DNS 查询按现有代理规则出站；代理节点域名使用独立 DNS 解析。"
                     if follow_rule else
                     "  # DNS 查询直接出站，不经代理规则转发；解析服务器由 nameserver-policy 选择。"),
                    f"  follow-rule: {routed}",
                    "",
                ]
                changes.append(f"dns: 保留源 nameserver / follow-rule={routed}")
            continue

        if skip_provider_health:
            if not stripped:
                buf.append(line)
                continue
            if len(line) - len(line.lstrip()) > 4:
                continue
            skip_provider_health = False

        if not stripped or stripped.startswith("#"):
            buf.append(line)
            continue

        if not keep_top:
            buf.clear()
            continue

        indent = len(line) - len(line.lstrip())
        m_sub = _SUB_KEY_RE.match(line)

        # use 引用的是本仓库自己的 provider，而它在 Stash 产物里已停用；
        # 改用 include-all 从基础配置的 proxies 取节点（filter 仍照常生效）。
        if skip_use_items:
            if indent >= 6 and not m_sub:
                continue
            skip_use_items = False
        if top == "proxy-groups" and indent == 4 and m_sub and m_sub.group(3).strip() == "use":
            flush()
            out.append("    include-all: true")
            skip_use_items = True
            changes.append("proxy-groups: use → include-all")
            continue

        # ── dns：按 Stash 支持的子键过滤 ──
        if top == "dns" and indent == 2 and m_sub and not stripped.startswith("- "):
            key = m_sub.group(3).strip()
            dns_key = key
            dns_keep = key in _STASH_DNS_KEEP
            if not dns_keep:
                buf.clear()
                continue
            if key == "nameserver-policy":
                buf = ["  # 分域名 DNS 策略：精确域名 > 通配域名 > geosite；多个 geosite 按配置顺序匹配"
                       if l.strip().startswith("# 分域名 DNS 策略") else l for l in buf]
            elif key == "default-nameserver":
                buf = ["  # 除 system 外，服务器地址使用 IP；支持基于 IP 的加密 DNS"
                       if l.strip() == "# 只能填纯 IP 地址" else l for l in buf]
            flush()
            out.append(_stash_clean_dns_line(line) if key != "fake-ip-filter" else line)
            continue
        if top == "dns" and not dns_keep \
                and (indent > 2 or stripped.startswith("- ")):
            buf.clear()
            continue

        # 服务器可出现在列表、policy 单值或行内数组中；不改原缩进和注释。
        if top == "dns" and dns_keep and dns_key != "fake-ip-filter":
            cleaned = _stash_clean_dns_line(line)
            if cleaned != line:
                changes.append("DNS 服务器去 mihomo 策略后缀")
            line = cleaned

        # nameserver-policy：逗号拼接多域名的单键是 mihomo 专属；Stash 只认
        # 「精确域名 / 通配域名 / geosite:<name>」，拼接键将被视作字面域名，无法命中。
        if top == "dns" and dns_key == "nameserver-policy" \
                and indent == 4 and m_sub and "," in m_sub.group(3):
            flush()
            domains = [d.strip() for d in m_sub.group(3).split(",") if d.strip()]
            suffix = line[m_sub.end():]
            if suffix.strip() and not suffix.lstrip().startswith("#"):
                out.extend(f'    "{dom}":{suffix}' for dom in domains)
                changes.append(f"nameserver-policy 拆键 ×{len(domains)}")
                continue
            policy_split = domains
            policy_val = []
            policy_tail = suffix
            changes.append(f"nameserver-policy 拆键 ×{len(policy_split)}")
            continue

        # ── provider：type 是 mihomo 专属；header 在 Stash 中为 headers ──
        if top in ("proxy-providers", "rule-providers"):
            key = m_sub.group(3).strip() if m_sub else ""
            if top == "proxy-providers" and indent == 4 and key == "health-check":
                buf.clear()
                skip_provider_health = True
                changes.append("proxy-providers: 健康检查交由策略组")
                continue
            if key == "type":
                buf.clear()
                continue
            if key == "header":
                flush()
                out.append(line.replace("header:", "headers:", 1))
                changes.append("proxy-providers: header → headers")
                continue

        # 只还原仓库里的境外 QUIC 限制规则，不改其他 UDP/443 或兜底规则。
        if top == "rules" and stripped.startswith("- "):
            condition = "AND,((NETWORK,UDP),(DST-PORT,443),(NOT,((OR,((GEOSITE,cn),(GEOIP,CN))))))"
            rule = stripped[2:]
            if rule.startswith(condition + ","):
                rest = rule[len(condition) + 1:].split(",")
                if rest[0] in ("⛔️ REJECT", "REJECT"):
                    if "no-track" not in rest[1:]:
                        rest.append("no-track")
                    native = condition.replace("(NETWORK,UDP),(DST-PORT,443)", "(PROTOCOL,QUIC)")
                    line = "  - " + native + "," + ",".join(rest)
                    buf = ["  # 拦截境外 QUIC，排除国内域名/IP；no-track 隐藏该规则的连接记录"
                           if l.strip().startswith("# 境外 QUIC（UDP 443）") else l for l in buf]
                    changes.append("rules: 境外 QUIC → PROTOCOL,QUIC / no-track")

        flush()
        out.append(line)

    if policy_split is not None:
        for dom in policy_split:
            out.append(f'    "{dom}":{policy_tail}')
            out.extend(policy_val)

    # 覆写列表的展示元数据放在配置主体之前；私人覆写继承后只改 name/desc。
    insert_at = next((i for i, l in enumerate(out) if l.startswith("# Date:")), -1) + 1
    out[insert_at:insert_at] = [
        "",
        f"name: {Path(out_path).stem}",
        "desc: 自动生成（sync-config.py 从 Clash/Sample.yaml 转译），请勿手动修改；通用设置请修改 Clash/General.yaml，策略/规则及 HTTP/MITM 设置请修改 Surge/Profile.conf。",
        "author: '@HotKids'",
        "category: HotKids",
        'icon: "https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Want.png"',
    ]

    out = _stash_comment_out(out, "proxy-providers")
    out = _stash_group_health_checks(out)
    out = _stash_http(out, surge_mitm_lines, general_lines)

    body = "\n".join(out).rstrip() + "\n"
    changed = _write_stamped_if_changed(REPO_ROOT / out_path, body)
    for note in dict.fromkeys(changes):
        print(f"    · {note}")
    print(f"  {'✓ ' + out_path + ' 已更新' if changed else '✓ ' + out_path + ' 无变化'}")

    _sync_stash_overlays(out)


# ── Enhanced/*.overlay.json → Stash 私人定制版 ────────────────────────────
#
# overlay 声明的是「相对基座的私人差异」，本身与输出格式无关（_apply_overlay 面向
# 解析后的 groups/rules 结构，供 Script.js 使用）。Stash 侧为文本级转译（需保留
# Sample.yaml 的注释与排版），因此这里按同一份 overlay 在文本层实现对应改写。
# 只有声明了 stash_output 的 overlay 才会产出 .stoverride；未实现的指令直接报错，
# 避免私人差异被静默丢弃。
_STASH_OVERLAY_OK = {
    "_comment", "output", "stash_output", "extends",
    "disabled_by_default", "rules_insert", "group_overrides",
    "group_proxies_insert", "extra_pool_groups",
}


def _stash_group_spans(lines: list[str]) -> dict[str, tuple[int, int]]:
    """定位 proxy-groups 块内每个组的行区间 {组名: (起, 止)}（止为开区间）。"""
    # 键行可能带 #!replace 行内标记，按前缀匹配而不是全等
    start = next((i for i, l in enumerate(lines) if re.match(r"^proxy-groups:", l)), -1)
    if start < 0:
        return {}
    end = next((i for i in range(start + 1, len(lines))
                if lines[i] and not lines[i].startswith((" ", "#"))), len(lines))
    # 下一顶层块的前导注释不属于最后一个组，否则追加/删除组会穿过这段说明。
    # 从块尾回扫，只排除顶格注释；保留组内缩进注释与原有空行。
    for i in range(end - 1, start, -1):
        if not lines[i].strip():
            continue
        if lines[i].startswith("#"):
            end = i
        else:
            break
    # 组间保留一个空行，多余的分节空行留在说明之前。
    while end > start + 2 and not lines[end - 1].strip() and not lines[end - 2].strip():
        end -= 1
    spans: dict[str, tuple[int, int]] = {}
    cur, cur_start = None, None
    for i in range(start + 1, end):
        m = re.match(r"^  - name:\s*(.+?)\s*$", lines[i])
        if m:
            if cur is not None:
                spans[cur] = (cur_start, i)
            cur, cur_start = m.group(1).strip().strip("'\""), i
    if cur is not None:
        spans[cur] = (cur_start, end)
    return spans


def _stash_group_health_checks(lines: list[str]) -> list[str]:
    """为自动选路组补齐 Stash 检测参数；保留显式配置，不修改手动 select 组。"""
    lines = list(lines)
    for s, e in reversed(list(_stash_group_spans(lines).values())):
        if not any(re.match(r"^    type:\s*(?:fallback|url-test)\s*$", l) for l in lines[s:e]):
            continue
        missing = [f"    {key}: {value}" for key, value in (("interval", "600"), ("lazy", "true"))
                   if not any(re.match(rf"^    {key}:", l) for l in lines[s:e])]
        if not missing:
            continue
        at = next((i for i in range(s, e) if re.match(r"^    filter:", lines[i])), e)
        while at > s and not lines[at - 1].strip():
            at -= 1
        lines[at:at] = missing
    return lines


def _stash_render_group(g: dict) -> list[str]:
    """按 Sample.yaml 的引号风格与字段顺序渲染一个新增策略组。

    源风格：name 用双引号、proxies 条目不加引号、filter 用单引号；
    字段顺序 name → type → icon → hidden → use/proxies → 测速参数 → filter。
    """
    out = [f'  - name: "{g["name"]}"', f"    type: {g.get('type', 'select')}"]
    if g.get("icon"):
        out.append(f"    icon: {g['icon']}")
    if g.get("hidden"):
        out.append("    hidden: true")
    # 池组的节点来源：与基座地区组写法一致，从基础配置的 proxies 中按 filter 筛选
    out.append("    include-all: true")
    for key in ("interval", "tolerance", "lazy"):
        if key in g:
            out.append(f"    {key}: {g[key]}")
    if g.get("filter"):
        out.append(f"    filter: {_yq(g['filter'])}")
    out.append("")  # 组间空行，与 Sample.yaml 一致
    return out


# 组内字段的规范顺序（与 Sample.yaml 一致），group_overrides 新增字段时按此定位
_STASH_FIELD_ORDER = ["name", "type", "icon", "hidden", "include-all", "use", "proxies",
                      "interval", "tolerance", "lazy", "filter"]


def _stash_apply_overlay(lines: list[str], overlay: dict, label: str) -> list[str]:
    """把一份 overlay 的差异叠加到已转译好的 Stash 文本上（就地返回新列表）。"""
    unknown = set(overlay) - _STASH_OVERLAY_OK
    if unknown:
        raise ValueError(
            f"{label}: Stash 转译尚未实现这些 overlay 指令 {sorted(unknown)}；"
            f"请在 _stash_apply_overlay 中补齐，避免私人差异被静默丢弃"
        )
    lines = list(lines)
    notes: list[str] = []

    # 展示字段替换为本定制版专属内容，避免与基座在覆写列表中同名
    for i, l in enumerate(lines):
        if l.startswith("name: "):
            lines[i] = f"name: {Path(overlay['stash_output']).stem}"
        elif l.startswith("desc: "):
            lines[i] = (f"desc: 自动生成（sync-config.py 从 Clash/Sample.yaml 转译，"
                        f"叠加 {label}），请勿手动修改；通用设置请修改 Clash/General.yaml，"
                        f"策略/规则及 HTTP/MITM 设置请修改 Surge/Profile.conf，私人差异请修改 {label}。")

    # 1) group_overrides：改写既有组的字段（filter 为 null 表示移除该行）
    for name, patch in (overlay.get("group_overrides") or {}).items():
        span = _stash_group_spans(lines).get(name)
        if span is None:
            raise ValueError(f"{label}: group_overrides 引用了不存在的分组 {name!r}")
        s, e = span
        for key, val in patch.items():
            idx = next((i for i in range(s, e)
                        if re.match(rf"^    {re.escape(key)}:", lines[i])), None)
            if val is None:
                if idx is not None:
                    del lines[idx]
                continue
            rendered = (f"    {key}: {_yq(val)}" if key == "filter"
                        else f"    {key}: {'true' if val is True else val}")
            if idx is not None:
                lines[idx] = rendered
            else:
                # 按 Sample.yaml 的字段顺序插到第一个「应排在它之后」的字段前
                rank = _STASH_FIELD_ORDER.index(key) if key in _STASH_FIELD_ORDER else len(_STASH_FIELD_ORDER)
                at = e
                for i in range(s, e):
                    m2 = re.match(r"^    ([\w-]+):", lines[i])
                    if m2 and m2.group(1) in _STASH_FIELD_ORDER \
                            and _STASH_FIELD_ORDER.index(m2.group(1)) > rank:
                        at = i
                        break
                lines.insert(at, rendered)
        notes.append(f"{name}: 覆盖 {'/'.join(patch)}")

    # 2) group_proxies_insert：在候选列表里紧邻锚点插入
    for name, spec in (overlay.get("group_proxies_insert") or {}).items():
        span = _stash_group_spans(lines).get(name)
        if span is None:
            raise ValueError(f"{label}: group_proxies_insert 引用了不存在的分组 {name!r}")
        s, e = span
        anchor = spec.get("after") or spec.get("before")
        idx = next((i for i in range(s, e)
                    if lines[i].strip().strip("-").strip().strip("'\"") == anchor), None)
        if idx is None:
            raise ValueError(f"{label}: {name} 的候选里找不到锚点 {anchor!r}")
        at = idx + 1 if spec.get("after") else idx
        lines[at:at] = [f"      - {p}" for p in spec["insert"]]
        notes.append(f"{name}: 候选插入 {len(spec['insert'])} 项")

    # 3) extra_pool_groups：整组新增，插入至锚点组之后
    for g in (overlay.get("extra_pool_groups") or []):
        spans = _stash_group_spans(lines)
        anchor = g.get("insert_after")
        if anchor not in spans:
            raise ValueError(f"{label}: extra_pool_groups 的锚点分组 {anchor!r} 不存在")
        at = spans[anchor][1]
        lines[at:at] = _stash_render_group(g)
        notes.append(f"新增分组 {g['name']}")

    # 4) rules_insert：在锚点规则前/后插入
    for spec in (overlay.get("rules_insert") or []):
        anchor = spec.get("after") or spec.get("before")
        idx = next((i for i, l in enumerate(lines)
                    if l.startswith("  - ") and anchor in l), None)
        if idx is None:
            raise ValueError(f"{label}: rules_insert 找不到锚点规则 {anchor!r}")
        at = idx + 1 if spec.get("after") else idx
        lines[at:at] = [f"  - {r}" for r in spec["rules"]]
        notes.append(f"规则插入 {len(spec['rules'])} 条")

    # 5) disabled_by_default：静态配置没有运行时开关，按声明整组移除——
    #    移除该组、以其为落点的规则，以及其余组候选中对它的引用，
    #    并清理因此不再被任何 RULE-SET 引用的规则集。
    for name in (overlay.get("disabled_by_default") or []):
        spans = _stash_group_spans(lines)
        if name not in spans:
            raise ValueError(f"{label}: disabled_by_default 引用了不存在的分组 {name!r}")
        s, e = spans[name]
        # 组前的注释行一并移除
        while s > 0 and lines[s - 1].lstrip().startswith("#"):
            s -= 1
        del lines[s:e]
        lines = [l for l in lines
                 if not (l.startswith("  - ") and l.rstrip().endswith(name))
                 and not (l.strip().startswith("- ") and l.strip().strip("-").strip().strip("'\"") == name)]
        notes.append(f"移除分组 {name}（含其规则与候选引用）")

    # 清理不再被引用的规则集
    used = {m.group(1) for l in lines if (m := re.match(r"^  - RULE-SET,([^,]+),", l))}
    rp = next((i for i, l in enumerate(lines) if re.match(r"^rule-providers:", l)), -1)
    rp_end = next((i for i in range(rp + 1, len(lines))
                   if lines[i] and not lines[i].startswith((" ", "#"))), len(lines)) if rp >= 0 else -1
    if rp >= 0:
        kept, i, dropped = [], rp + 1, []
        while i < rp_end:
            m = re.match(r"^  (['\"]?)([^:'\"]+)\1:\s*$", lines[i])
            if m:
                nm = m.group(2).strip()
                j = i + 1
                while j < rp_end and (not lines[j].strip() or lines[j].startswith("    ")):
                    j += 1
                if nm not in used:
                    dropped.append(nm)
                else:
                    kept.extend(lines[i:j])
                i = j
                continue
            kept.append(lines[i])
            i += 1
        if dropped:
            lines[rp + 1:rp_end] = kept
            notes.append(f"清理无引用规则集 {', '.join(dropped)}")

    for n in notes:
        print(f"    · {n}")
    return _stash_group_health_checks(lines)


def _sync_stash_overlays(base_lines: list[str]) -> None:
    """为声明了 stash_output 的 overlay 各产出一份 Stash 定制版覆写。"""
    enhanced = REPO_ROOT / ".github" / "scripts" / "sync-config" / "Enhanced"
    for path in sorted(enhanced.glob("*.overlay.json")):
        overlay = json.loads(path.read_text(encoding="utf-8"))
        target = overlay.get("stash_output")
        if not target:
            continue
        print(f"  ── overlay: {path.name} → {target} ──")
        lines = _stash_apply_overlay(base_lines, overlay, path.name)
        body = "\n".join(lines).rstrip() + "\n"
        changed = _write_stamped_if_changed(REPO_ROOT / target, body)
        print(f"  {'✓ ' + target + ' 已更新' if changed else '✓ ' + target + ' 无变化'}")
