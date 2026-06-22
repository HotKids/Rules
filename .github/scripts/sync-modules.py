#!/usr/bin/env python3
"""
Surge sgmodule 聚合脚本

读取 sync-modules.txt 中的 URL 列表，拉取并合并为单个 sgmodule。
每个来源模块以 # > NAME 分组，按名称首字符排序：数字 → 英文 → 汉字拼音。
"""

import re
import sys
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta
from pathlib import Path
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

from pypinyin import lazy_pinyin

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SYNC_TXT = Path(__file__).resolve().parent / "sync-modules.txt"
OUTPUT_FILE = REPO_ROOT / "Surge" / "Module" / "BlockAds.sgmodule"

_SECTION_RE = re.compile(r"^\[(.+)\]$")
_META_FIELD_RE = re.compile(r"^#!([\w-]+)=(.*)$")

_MITM_BOOL_KEYS = {"skip-server-cert-verify", "h2", "tcp-connection"}

_SECTION_ORDER = ["MITM", "Rule", "Map Local", "Script", "URL Rewrite", "Header Rewrite"]

# arguments-desc 顶部的总说明，始终输出
_ARGS_DESC_GENERAL = (
    "各参数值为对应 App 的域名关键字，默认启用；如需禁用某 App 去广告，"
    "将其改为任意非常见域名值即可（e.g. NO）。"
)


def _sort_key(name: str) -> str:
    """数字 → 英文字母 → 汉字拼音 排序键。"""
    if not name:
        return "~"
    first = name[0]
    if first.isdigit():
        return "0" + name
    if first.isascii() and first.isalpha():
        return "1" + name.lower()
    return "2" + " ".join(lazy_pinyin(name))


def _encode_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    encoded_path = urllib.parse.quote(parsed.path, safe="/-_.~!$&'()*+,;=:@%")
    return urllib.parse.urlunparse(parsed._replace(path=encoded_path))


def fetch_url(url: str) -> tuple[str, str | None]:
    try:
        encoded = _encode_url(url)
        req = urllib.request.Request(encoded, headers={"User-Agent": "sync-modules/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return url, resp.read().decode("utf-8")
    except Exception as e:
        print(f"  [ERR] 下载失败: {url}\n        {e}", file=sys.stderr)
        return url, None


def parse_sgmodule(text: str) -> dict:
    """解析 sgmodule，返回 {meta: {k:v}, sections: {name: [lines]}}。"""
    meta: dict[str, str] = {}
    sections: dict[str, list[str]] = defaultdict(list)
    current = None

    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        m = _META_FIELD_RE.match(stripped)
        if m:
            meta[m.group(1)] = m.group(2).strip()
            continue
        m = _SECTION_RE.match(stripped)
        if m:
            current = m.group(1)
            continue
        if current is not None:
            sections[current].append(stripped)

    return {"meta": meta, "sections": sections}


def _sub_alias(text: str, keyword: str, display: str) -> str:
    """将 text 中作为域名标签出现的 keyword 替换为占位符 {{{display}}}。

    keyword 为域名关键字（如 ithome），display 为参数键名（如 IT之家）。
    替换条件（任一即可）：
      - 紧跟在点号后（`.` 或转义的 `\\.`），命中域名前/中段标签；
      - 紧邻竖线/右括号前（`|` `)`），命中 `\\.(mgtv|hunantv)\\.` 这类域名
        候选组里作为标签后缀的关键字。
    由此命中域名部分（napi.ithome.com → napi.{{{IT之家}}}.com），而不会误伤
    脚本名（移除12306开屏广告）、script-path 路径（.../12306/12306_remove.js）
    或路径候选组（(caixinapp|...) 里的 caixin 因前面是 `(` 而不会被替换）。
    """
    esc = re.escape(keyword)
    repl = "{{{" + display + "}}}"
    return re.compile(rf"(?<=\.){esc}|{esc}(?=\\?\.|[|)])").sub(lambda _m: repl, text)


def _merge_mitm(
    entries: list[tuple[str, list[str]]],
    name_to_alias: dict[str, str],
    name_to_display: dict[str, str],
) -> list[str]:
    """合并多个来源的 [MITM] 块：hostname 去重合并，布尔键取 true 优先。

    每条 hostname 按其所属模块的 alias 做域名替换。
    """
    host_map: dict[str, str] = {}  # 原始 hostname -> 替换后 hostname（按原始去重/排序）
    bool_flags: dict[str, str] = {}
    other: list[str] = []

    for name, lines in entries:
        alias = name_to_alias.get(name)
        display = name_to_display.get(name, alias or "")
        for line in lines:
            if not line.strip():
                continue
            if "=" not in line:
                other.append(line)
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip()

            if key == "hostname":
                val = re.sub(r"^%APPEND%\s*", "", val)
                for h in val.split(","):
                    h = h.strip()
                    if h and h not in host_map:
                        host_map[h] = _sub_alias(h, alias, display) if alias else h
            elif key in _MITM_BOOL_KEYS:
                if bool_flags.get(key) != "true":
                    bool_flags[key] = val
            else:
                other.append(line)

    result = list(other)
    for k, v in bool_flags.items():
        result.append(f"{k} = {v}")
    if host_map:
        merged = ", ".join(host_map[k] for k in sorted(host_map))
        result.append(f"hostname = %APPEND% {merged}")
    return result


def load_urls() -> list[tuple[str, str]]:
    """返回 (url, alias) 列表；alias 为空字符串表示无别名。"""
    result: list[tuple[str, str]] = []
    for line in SYNC_TXT.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "," in stripped:
            url, alias = stripped.split(",", 1)
            result.append((url.strip(), alias.strip()))
        else:
            result.append((stripped, ""))
    return result


def read_output_meta() -> dict[str, str]:
    meta: dict[str, str] = {}
    if not OUTPUT_FILE.exists():
        return meta
    for line in OUTPUT_FILE.read_text(encoding="utf-8").splitlines():
        m = _META_FIELD_RE.match(line.strip())
        if m:
            meta[m.group(1)] = m.group(2).strip()
    return meta


def write_if_changed(path: Path, content: str) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_text(encoding="utf-8") == content:
        return False
    path.write_text(content, encoding="utf-8")
    return True


def aggregate():
    url_alias_list = load_urls()
    if not url_alias_list:
        print("[WARN] sync-modules.txt 中无 URL 条目")
        return

    existing_meta = read_output_meta()

    url_list = [url for url, _ in url_alias_list]
    url_to_alias = {url: alias for url, alias in url_alias_list if alias}

    print(f"并发拉取 {len(url_list)} 个 sgmodule …")
    results: dict[str, str | None] = {}
    with ThreadPoolExecutor(max_workers=min(8, len(url_list))) as pool:
        futures = {pool.submit(fetch_url, u): u for u in url_list}
        for fut in as_completed(futures):
            url, text = fut.result()
            results[url] = text

    # {section: [(name, [lines]), ...]}  按原顺序收集
    section_entries: dict[str, list[tuple[str, list[str]]]] = defaultdict(list)
    # name -> hostname 注释字符串（用于各 section 内的 # hostname = ... 提示行）
    module_hostnames: dict[str, str] = {}
    # name -> 上游模块日期（仅年月日，用于判断是否仍在维护）
    module_dates: dict[str, str] = {}
    # name -> 上游模块描述
    module_descs: dict[str, str] = {}
    # 模块名 -> 该模块自带 arguments 列表 [(key, "key:default"), ...]
    module_args: dict[str, list[tuple[str, str]]] = {}
    # 按 url 顺序记录成功解析的模块名（用于 #!arguments 排序与分组）
    ordered_modules: list[str] = []
    # 合并后的 upstream arguments-desc：key -> desc（保序去重）
    merged_args_desc: dict[str, str] = {}
    # 模块名 -> alias（域名关键字），用于在各 section 内做域名替换
    name_to_alias: dict[str, str] = {}
    # 模块名 -> display（参数键名 = 模块名去掉“去广告”）
    name_to_display: dict[str, str] = {}

    for url, alias in url_alias_list:
        text = results.get(url)
        if not text:
            continue
        parsed = parse_sgmodule(text)
        name = parsed["meta"].get("name", url)
        if name not in ordered_modules:
            ordered_modules.append(name)
        if alias:
            display = name.replace("去广告", "").strip() or alias
            name_to_alias[name] = alias
            name_to_display[name] = display
        # 提取上游 date（只保留年月日）
        raw_date = parsed["meta"].get("date", "")
        if raw_date:
            module_dates[name] = raw_date.split()[0]
        # 提取上游 desc
        desc = parsed["meta"].get("desc", "")
        if desc:
            module_descs[name] = desc
        # 收集该模块自带 arguments（保序），输出时紧跟在该模块的域名开关之后
        mod_arg_list: list[tuple[str, str]] = []
        for arg_entry in parsed["meta"].get("arguments", "").split(","):
            arg_entry = arg_entry.strip()
            if not arg_entry:
                continue
            key = arg_entry.split(":")[0].strip()
            if key:
                mod_arg_list.append((key, arg_entry))
        if mod_arg_list:
            module_args[name] = mod_arg_list
        for desc_entry in parsed["meta"].get("arguments-desc", "").split("\n"):
            desc_entry = desc_entry.strip()
            if not desc_entry:
                continue
            key = desc_entry.split(":")[0].strip()
            if key and key not in merged_args_desc:
                merged_args_desc[key] = desc_entry
        # 提取该模块自身的 hostname
        mitm_lines = parsed["sections"].get("MITM", [])
        for line in mitm_lines:
            if "=" in line:
                k, _, v = line.partition("=")
                if k.strip() == "hostname":
                    v = re.sub(r"^%APPEND%\s*", "", v.strip())
                    if v:
                        module_hostnames[name] = v
                    break
        for section, lines in parsed["sections"].items():
            non_empty = [l for l in lines if l.strip()]
            if non_empty:
                section_entries[section].append((name, non_empty))
        print(f"  ✓ {name}")

    # 对每个 section 内的条目按名称排序（MITM 单独处理）
    for sec in section_entries:
        if sec != "MITM":
            section_entries[sec].sort(key=lambda x: _sort_key(x[0]))

    # 构建输出（name/desc/category/remark 保留手动维护值，date 取当前同步时间）
    now = datetime.now(tz=timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S")
    out: list[str] = []
    out.append(f"#!name={existing_meta.get('name', 'LoonKissSurge 合集')}")
    out.append(f"#!desc={existing_meta.get('desc', '自动聚合，每日更新')}")
    if "author" in existing_meta:
        out.append(f"#!author={existing_meta['author']}")
    out.append(f"#!category={existing_meta.get('category', 'HotKids')}")
    if "remark" in existing_meta:
        out.append(f"#!remark={existing_meta['remark']}")
    # 写入合并后的 arguments：按模块顺序，每个模块先写其域名开关（display:keyword，
    # 默认值=域名关键字=启用），紧跟该模块自带的 arguments，便于辨识归属。
    all_args: dict[str, str] = {}
    for name in ordered_modules:
        alias = name_to_alias.get(name)
        display = name_to_display.get(name)
        if alias and display not in all_args:
            all_args[display] = f"{display}:{alias}"
        for key, entry in module_args.get(name, []):
            all_args.setdefault(key, entry)
    if all_args:
        out.append(f"#!arguments={','.join(all_args.values())}")
    desc_parts = [_ARGS_DESC_GENERAL, *merged_args_desc.values()]
    out.append("#!arguments-desc=" + "\\n".join(desc_parts))
    out.append(f"#!date={now}")
    out.append("")

    written_sections: set[str] = set()

    def write_section(sec: str):
        entries = section_entries.get(sec, [])
        if not entries:
            return
        out.append(f"[{sec}]")
        if sec == "MITM":
            out.extend(_merge_mitm(entries, name_to_alias, name_to_display))
        else:
            first = True
            for name, lines in entries:
                if not first:
                    out.append("")
                alias = name_to_alias.get(name)
                display = name_to_display.get(name, alias or "")
                date_suffix = f" · {module_dates[name]}" if name in module_dates else ""
                out.append(f"# > {name}{date_suffix}")
                if name in module_descs:
                    out.append(f"# desc = {module_descs[name]}")
                if sec == "Script" and name in module_hostnames:
                    hint = module_hostnames[name]
                    if alias:
                        hint = _sub_alias(hint, alias, display)
                    out.append(f"# hostname = {hint}")
                out.extend(_sub_alias(line, alias, display) if alias else line for line in lines)
                first = False
        out.append("")
        written_sections.add(sec)

    for sec in _SECTION_ORDER:
        write_section(sec)

    for sec in section_entries:
        if sec not in written_sections:
            write_section(sec)

    content = "\n".join(out).rstrip("\n") + "\n"

    if write_if_changed(OUTPUT_FILE, content):
        print(f"\n✓ {OUTPUT_FILE.relative_to(REPO_ROOT)} 已更新")
    else:
        print(f"\n✓ {OUTPUT_FILE.relative_to(REPO_ROOT)} 无变化")


if __name__ == "__main__":
    aggregate()
