"""Prepare Loon Module sources through the pinned, local Script-Hub bridge.

Conversion and secondary downloads complete before the synchronization runner
writes any output. Third-party application JavaScript is never executed here.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import urlsplit

from module_convert import parse_module


PARSER_URL = ("https://raw.githubusercontent.com/Script-Hub-Org/Script-Hub/"
              "761f7864785d032cd1d1d616e5a298a0c07aae7d/Rewrite-Parser.beta.js")
PARSER_SHA256 = "189d66701c9119ae5ce638278f531b35e8ba41e2372c7e55f8fa9d0dc58823d5"
JQ_FILE = re.compile(r'response\.json\.jq_file\s*\(\s*([\'"])(https://[^\'"]+)\1')
PM_ADVISORY = "逻辑运算符 AND 中的所有子规则必须是支持 pre-matching 的类型, 但 PROTOCOL 不支持"


def is_loon_module(url: str, text: str) -> bool:
    """Recognize Loon filenames or executable syntax, never inherited metadata."""
    if urlsplit(url).path.lower().endswith((".plugin", ".lpx")):
        return True
    return bool(re.search(r"(?mi)^\s*(?:request|response)\s+if\s+\$\{", text)
                or re.search(r"(?mi)^\s*(?:http-request|http-response)\s+\S+\s+script-path=", text)
                or re.search(r"(?mi)^\s*\[Rewrite\]\s*$", text))


def normalize_loon_metadata(original: str, converted: str) -> str:
    """Keep descriptive provenance while dropping Loon-only header fields."""
    source_meta, _ = parse_module(original)
    metadata, sections = parse_module(converted)
    source_meta = {key.lower(): value for key, value in source_meta.items()}
    def field(key):
        return next((name for name in metadata if name.lower() == key), key)

    original_note = source_meta.get("original") or metadata.get(field("original"))
    if original_note:
        description = metadata.get(field("desc"), "")
        if description != original_note and not description.endswith(r"\n" + original_note):
            metadata[field("desc")] = description + (r"\n" if description else "") + original_note
    if source_meta.get("category"):
        metadata[field("category")] = source_meta["category"]
    elif not metadata.get(field("category")) and source_meta.get("tag"):
        metadata[field("category")] = source_meta["tag"]
    for key in list(metadata):
        if key.lower() not in {"original", "tag", "loon_version"}:
            continue
        metadata.pop(key, None)
    lines = [f"#!{key}={value}" for key, value in metadata.items()]
    for section, content in sections.items():
        content = list(content)
        while content and not content[0].strip():
            content.pop(0)
        while content and not content[-1].strip():
            content.pop()
        lines += [""] + ([f"[{section}]"] if section else []) + content
    return "\n".join(lines).rstrip() + "\n"


def _validate_converted(text: str) -> None:
    from loon_scripts import parse_script_options

    _, sections = parse_module(text)
    if any(section.lower() in {"rewrite", "rewrite_local", "task_local"} for section in sections):
        raise ValueError("Loon conversion left executable source syntax")
    for line in sections.get("Script", []):
        if not line.strip() or line.lstrip().startswith(("#", "//", ";")):
            continue
        label, separator, value = line.partition("=")
        options = parse_script_options(value)
        if not separator or not label.strip() or options.get("type") not in {
                "http-request", "http-response", "cron", "event", "generic"}:
            raise ValueError("Loon conversion did not produce a native Surge script")


def convert_loon_sources(sources: dict[str, str], download) -> dict[str, str]:
    """Convert one complete, ordered batch without writing repository files."""
    if not sources:
        return {}
    dependencies = list(dict.fromkeys(match[2] for text in sources.values()
                                      for match in JQ_FILE.finditer(text)))
    fetched = download([PARSER_URL, *dependencies])
    parser = fetched.get(PARSER_URL)
    if (not isinstance(parser, str)
            or hashlib.sha256(parser.encode("utf-8")).hexdigest() != PARSER_SHA256):
        raise ValueError("Loon parser verification failed")
    http_bodies = {url: fetched.get(url) for url in dependencies}
    if any(not isinstance(body, str) or not body.strip() for body in http_bodies.values()):
        raise ValueError("Loon remote dependency is missing or empty")
    batch = [{"id": str(index), "body": text} for index, text in enumerate(sources.values())]
    with tempfile.TemporaryDirectory(prefix="loon-module-conversion-") as directory:
        parser_path = Path(directory) / "parser.js"
        parser_path.write_text(parser, encoding="utf-8")
        try:
            run = subprocess.run(
                ["node", str(Path(__file__).with_name("convert-loon.cjs")), "--parser", str(parser_path)],
                input=json.dumps({"sources": batch, "httpBodies": http_bodies}),
                capture_output=True, text=True, timeout=180,
            )
        except (OSError, subprocess.TimeoutExpired):
            raise RuntimeError("Loon conversion requires a working Node.js bridge within its time limit") from None
    if run.returncode:
        # stderr/stdout may contain source content; never echo them into CI.
        raise RuntimeError(f"Loon conversion bridge failed (exit {run.returncode})")
    try:
        results = json.loads(run.stdout)["results"]
        if (not isinstance(results, list) or len(results) != len(batch)
                or [row.get("id") for row in results] != [row["id"] for row in batch]):
            raise ValueError
    except (ValueError, TypeError, KeyError, AttributeError):
        raise ValueError("Loon conversion bridge returned an incomplete batch") from None
    converted = {}
    for (url, original), result in zip(sources.items(), results):
        identifier = "source-" + hashlib.sha256(url.encode("utf-8")).hexdigest()[:12]
        diagnostics = result.get("diagnostics", [])
        if not isinstance(diagnostics, list) or any(not isinstance(row, dict) for row in diagnostics):
            raise ValueError(f"Loon conversion returned invalid diagnostics: {identifier}")
        warnings = [row.get("message") for row in diagnostics if row.get("level") == "warning"]
        advisory_only = warnings and all(warning == PM_ADVISORY for warning in warnings)
        if (result.get("error") or any(row.get("level") == "error" for row in diagnostics)
                or (result.get("unsupported") or warnings) and not advisory_only):
            raise ValueError(f"Loon source cannot be converted without unsupported content: {identifier}")
        text = result.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("Loon conversion produced empty output")
        if advisory_only and "(PROTOCOL,QUIC)" not in text:
            raise ValueError("Loon conversion omitted its QUIC rule")
        _validate_converted(text)
        converted[url] = normalize_loon_metadata(original, text)
    return converted


def prepare_loon_modules(entries, prefetched, root, download_scripts):
    """Prepare native Loon configs and their independent script adapters."""
    from loon_scripts import prepare_loon_scripts

    originals = dict(prefetched)
    loon_sources = {}
    for entry in entries:
        url = entry["url"]
        text = prefetched.get(url) or ""
        if is_loon_module(url, text):
            if not isinstance(text, str) or not text.strip():
                raise ValueError("Loon source download is empty")
            loon_sources.setdefault(url, text)
    converted = {**originals, **convert_loon_sources(loon_sources, download_scripts)}
    return prepare_loon_scripts(entries, originals, converted, Path(root), download_scripts)
