#!/usr/bin/env python3
"""Shared file writes and complete, bounded-retry upstream downloads."""

import sys
import time
import urllib.error
import urllib.request
import urllib.parse
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

_URL_SAFE = "/-_.~!$&'()*+,;=:@%"


def write_if_changed(path: Path, content: str) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_text(encoding="utf-8") == content:
        return False
    path.write_text(content, encoding="utf-8")
    return True


def encode_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    return urllib.parse.urlunparse(parsed._replace(
        path=urllib.parse.quote(parsed.path, safe=_URL_SAFE)))


class DownloadError(RuntimeError):
    def __init__(self, url: str, reason: str, status: int | None = None):
        self.url, self.status = url, status
        label = f"HTTP {status}" if status is not None else "network/content error"
        super().__init__(f"{url}: {label}: {reason}")


class DownloadBatchError(RuntimeError):
    def __init__(self, failures: list[DownloadError]):
        self.failures = failures
        super().__init__("上游下载不完整，中止同步并保留已发布产物：\n" +
                         "\n".join(str(e) for e in failures))


def fetch_url(url: str, ua: str, *, encode: bool = False, timeout: int = 30,
              attempts: int = 3) -> str:
    """Return nonempty UTF-8 text, or raise with the actual HTTP/network error.

    Retry transport errors, 408, 429 and 5xx at most three times. A real 404
    fails immediately; it is never inferred from a timeout or an empty body.
    """
    target = encode_url(url) if encode else url
    attempts = max(1, attempts)
    for attempt in range(attempts):
        retry = False
        try:
            req = urllib.request.Request(target, headers={"User-Agent": ua})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                text = resp.read().decode("utf-8")
            if not text.strip():
                raise DownloadError(url, "empty response")
            return text
        except urllib.error.HTTPError as e:
            error = DownloadError(url, str(e.reason), e.code)
            retry = e.code in (408, 429) or 500 <= e.code < 600
            e.close()
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            error = DownloadError(url, str(e))
            retry = True
        except UnicodeError as e:
            error = DownloadError(url, str(e))
        if not retry or attempt + 1 == attempts:
            raise error
        print(f"  [RETRY {attempt + 1}/{attempts - 1}] {error}", file=sys.stderr)
        time.sleep(min(2 ** attempt, 4))
    raise AssertionError("unreachable")


def prefetch_urls(urls: list[str], ua: str, *, encode: bool = False,
                  max_workers: int = 8) -> dict[str, str]:
    """Fetch every unique source before allowing a caller to replace outputs."""
    unique = list(dict.fromkeys(urls))
    if not unique:
        return {}
    results: dict[str, str] = {}
    failures: list[DownloadError] = []
    with ThreadPoolExecutor(max_workers=min(max_workers, len(unique))) as pool:
        tasks = {pool.submit(fetch_url, u, ua, encode=encode): u for u in unique}
        for task in as_completed(tasks):
            try:
                results[tasks[task]] = task.result()
            except DownloadError as e:
                failures.append(e)
    if failures:
        raise DownloadBatchError(sorted(failures, key=lambda e: e.url))
    return results
