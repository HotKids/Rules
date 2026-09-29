"""Configuration generation: parser."""

from pathlib import Path
import re
import urllib.request
from .common import (
    REPO_ROOT,
    SYNC_CONFIG_TXT,
)


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
            # 拉取失败若继续，会生成并提交缺失整段（如 QX 的 [dns] 块）的配置。
            # 直接中止让 workflow 失败，避免把残缺配置 push 到 master。
            raise RuntimeError(
                f"远程包含拉取失败，中止同步以避免提交缺失段落的配置: {url}: {e}"
            ) from e
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


