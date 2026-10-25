#!/usr/bin/env python3
"""Shared file writes and complete, bounded-retry upstream downloads."""

import sys
import math
import re
import time
import urllib.error
import urllib.request
import urllib.parse
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from email.utils import parsedate_to_datetime
from datetime import timezone

_URL_SAFE = "/-_.~!$&'()*+,;=:@%"


def write_if_changed(path: Path, content: str, *, normalize_patterns=(),
                     normalize_count: int = 0) -> bool:
    """Compare optional normalized text, but write the original supplied content."""
    normalize_patterns = tuple(normalize_patterns)
    def comparable(text):
        for pattern in normalize_patterns:
            text = re.sub(pattern, "", text, count=normalize_count)
        return text

    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and comparable(path.read_text(encoding="utf-8")) == comparable(content):
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
        reason = re.sub(r"https?://[^\s\"'<>]+", lambda match: safe_url(match[0]), str(reason))
        super().__init__(f"{safe_url(url)}: {label}: {reason}")


class DownloadBatchError(RuntimeError):
    def __init__(self, failures: list[DownloadError]):
        self.failures = failures
        super().__init__("上游下载不完整，中止同步并保留已发布产物：\n" +
                         "\n".join(str(e) for e in failures))


def safe_url(url: str) -> str:
    """Keep a useful source label without logging credentials, query or fragment."""
    try:
        parsed = urllib.parse.urlsplit(url)
        return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc.rsplit("@", 1)[-1],
                                        parsed.path, "[redacted]" if parsed.query else "", ""))
    except ValueError:
        return "[invalid URL]"


def _retry_after(headers) -> float | None:
    value = headers.get("Retry-After") if headers is not None else None
    if value is None:
        return None
    value = str(value).strip()
    if value.isdecimal():
        return min(float(value), 30)
    try:
        date = parsedate_to_datetime(value)
        if date.tzinfo is None:
            date = date.replace(tzinfo=timezone.utc)
        return min(max(date.timestamp() - time.time(), 0), 30)
    except (TypeError, ValueError, OverflowError):
        return None


def fetch_url(url: str, ua: str, *, encode: bool = False, timeout: float = 30,
              attempts: int = 3, total_timeout: float | None = None) -> str:
    """Return nonempty UTF-8 text, or raise with the actual HTTP/network error.

    Retry empty bodies, transport errors, 408, 429 and 5xx. Retry-After is
    capped at 30 seconds; all requests and waits share a finite time budget.
    Real 404 and Unicode errors fail immediately.
    """
    target = encode_url(url) if encode else url
    attempts = max(1, attempts)
    budget = timeout * attempts if total_timeout is None else total_timeout
    if not all(math.isfinite(value) and value > 0 for value in (timeout, budget)):
        raise ValueError("Download timeouts must be finite positive numbers")
    deadline = time.monotonic() + budget
    error = DownloadError(url, "download time budget exhausted")
    for attempt in range(attempts):
        retry = False
        delay = None
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise error
        try:
            req = urllib.request.Request(target, headers={"User-Agent": ua})
            with urllib.request.urlopen(req, timeout=min(timeout, remaining)) as resp:
                text = resp.read().decode("utf-8")
            if not text.strip():
                error = DownloadError(url, "empty response")
                retry = True
            else:
                if time.monotonic() > deadline:
                    raise DownloadError(url, "download time budget exhausted")
                return text
        except urllib.error.HTTPError as e:
            error = DownloadError(url, str(e.reason), e.code)
            retry = e.code in (408, 429) or 500 <= e.code < 600
            if retry:
                delay = _retry_after(e.headers)
            e.close()
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            error = DownloadError(url, str(e))
            retry = True
        except UnicodeError as e:
            error = DownloadError(url, str(e))
        if not retry or attempt + 1 == attempts:
            raise error
        delay = min(2 ** attempt, 4) if delay is None else delay
        if delay >= deadline - time.monotonic():
            raise error
        print(f"  [RETRY {attempt + 1}/{attempts - 1}] {error}", file=sys.stderr)
        time.sleep(delay)
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
