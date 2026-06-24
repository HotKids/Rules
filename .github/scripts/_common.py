#!/usr/bin/env python3
"""sync-*.py 共用工具（仅标准库）。

抽取三个同步脚本中重复的文件写入与 URL 下载逻辑：
- write_if_changed: 内容无变化时不写盘
- encode_url:       对 URL path 做百分号编码
- fetch_url:        单个 URL 下载（可选编码）
- prefetch_urls:    线程池并发下载，返回 {原始 url: text_or_None}
"""

import sys
import urllib.request
import urllib.parse
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

# URL path 百分号编码时保留的安全字符
_URL_SAFE = "/-_.~!$&'()*+,;=:@%"


def write_if_changed(path: Path, content: str) -> bool:
    """内容与现有文件一致时跳过写入；写入返回 True，跳过返回 False。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_text(encoding="utf-8") == content:
        return False
    path.write_text(content, encoding="utf-8")
    return True


def encode_url(url: str) -> str:
    """对 URL 的 path 部分做百分号编码（query/host 不变）。"""
    parsed = urllib.parse.urlparse(url)
    encoded_path = urllib.parse.quote(parsed.path, safe=_URL_SAFE)
    return urllib.parse.urlunparse(parsed._replace(path=encoded_path))


def fetch_url(url: str, ua: str, *, encode: bool = False, timeout: int = 30) -> str | None:
    """下载 url，返回文本；失败返回 None。encode=True 时先对 path 百分号编码。"""
    target = encode_url(url) if encode else url
    try:
        req = urllib.request.Request(target, headers={"User-Agent": ua})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8")
    except Exception as e:
        print(f"  [ERR] 下载失败: {url} ({e})", file=sys.stderr)
        return None


def prefetch_urls(
    urls: list[str], ua: str, *, encode: bool = False, max_workers: int = 8
) -> dict[str, str | None]:
    """并发下载 urls，返回 {原始 url: text_or_None}（按原始 url 键，顺序无关）。"""
    results: dict[str, str | None] = {}
    if not urls:
        return results
    with ThreadPoolExecutor(max_workers=min(max_workers, len(urls))) as pool:
        future_to_url = {
            pool.submit(fetch_url, u, ua, encode=encode): u for u in urls
        }
        for future in as_completed(future_to_url):
            results[future_to_url[future]] = future.result()
    return results
