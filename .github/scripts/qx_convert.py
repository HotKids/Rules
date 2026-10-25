"""Strict, local Quantumult X snippets to native Surge module syntax.

This layer translates configuration only. Callers may provide a pure script URL
mapper to attach a shared QX runtime converter; no application's JS is patched.
Unknown executable directives fail instead of disappearing from a published file.
"""
from __future__ import annotations

from collections import OrderedDict
import re
import unicodedata
from urllib.parse import urlsplit


QX_BODY_LIMIT = 4 * 1024 * 1024
_RULE_TYPES = {
    "host": "DOMAIN", "host-suffix": "DOMAIN-SUFFIX",
    "host-keyword": "DOMAIN-KEYWORD", "host-wildcard": "DOMAIN-WILDCARD",
    "ip-cidr": "IP-CIDR", "ip6-cidr": "IP-CIDR6", "ip-cidr6": "IP-CIDR6",
    "geoip": "GEOIP", "ip-asn": "IP-ASN", "dest-port": "DEST-PORT",
    "src-port": "SRC-PORT", "user-agent": "USER-AGENT",
}
_SCRIPT_TYPES = {
    "script-request": ("http-request", False, "request"),
    "script-request-header": ("http-request", False, "request"),
    "script-request-body": ("http-request", True, "request-body"),
    "script-response": ("http-response", False, "response"),
    "script-response-header": ("http-response", False, "response"),
    "script-response-body": ("http-response", True, "response-body"),
    "script-echo-response": ("http-request", True, "echo"),
}
_QX_SECTIONS = {"filter_local", "rewrite_local", "task_local", "mitm"}
_SURGE_SECTIONS = {
    "rule", "script", "general", "map local", "url rewrite", "header rewrite",
    "body rewrite", "host", "proxy", "proxy group", "panel", "rule selection",
    "rule policy", "ssid setting", "port forwarding", "ip rewrite", "replica", "ponte",
}
_REWRITE_RE = re.compile(r"^(\S+)\s+url\s+(\S+)(?:\s+(.*))?$", re.I)
_POLICIES = {"reject", "reject-drop", "reject-tinygif", "direct"}
_CIDR_TYPES = {"ip-cidr", "ip6-cidr", "ip-cidr6"}
_DOMAIN_TYPES = {"host", "host-suffix", "host-keyword", "host-wildcard"}
_REJECT_POLICIES = {"REJECT", "REJECT-DROP", "REJECT-TINYGIF", "REJECT-NO-DROP"}


def is_qx_module(text: str) -> bool:
    """Recognize QX-only syntax without treating native Surge modules as QX."""
    lines = text.lstrip("\ufeff").splitlines()
    # IP-CIDR and several other rule names are shared by both dialects. Prefer
    # native module sections before examining individual rule/URL-looking lines.
    # MITM is deliberately absent: Quantumult X snippets also use that section.
    for raw in lines:
        section = re.fullmatch(r"\[([^]\n]+)\]", raw.strip())
        if section:
            name = section[1].strip().lower()
            if name in _SURGE_SECTIONS or name.startswith(("ruleset ", "wireguard ")):
                return False
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith(("#", ";", "//")):
            continue
        if re.fullmatch(r"\[(?:filter_local|rewrite_local|task_local)\]", line, re.I):
            return True
        if _REWRITE_RE.match(line):
            return True
        kind = line.split(",", 1)[0].strip().lower()
        if "," in line and kind in _RULE_TYPES:
            return True
    return False


def _error(number: int, message: str) -> ValueError:
    # Do not echo upstream source text, URLs, query credentials or body fragments.
    return ValueError(f"QX conversion failed at line {number}: {message}")


def _policy(value: str) -> str:
    return value.upper() if value.lower() in _POLICIES else value


def _script_url(value: str | None, number: int) -> str:
    if not isinstance(value, str) or not value or any(char.isspace() for char in value):
        raise _error(number, "a script requires one HTTP(S) URL")
    try:
        parsed = urlsplit(value)
    except ValueError:
        raise _error(number, "invalid script URL") from None
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise _error(number, "a script requires one HTTP(S) URL")
    return value


def _csv_value(value: str, number: int) -> str:
    """Quote comma-bearing Surge Script values without changing regex escapes."""
    # The downstream legacy options reader recognizes comma + option-key even
    # inside quotes. Refuse that ambiguity rather than changing native parsing
    # semantics or publishing a truncated pattern/URL.
    if ('"' in value or "\r" in value or "\n" in value
            or re.search(r",\s*[a-z][a-z0-9-]*\s*=", value)):
        raise _error(number, "script field cannot be expressed losslessly in Surge CSV")
    return '"' + value + '"' if "," in value else value


def _script_prefix(value: str) -> str:
    """Keep human-readable module titles while excluding label syntax hazards."""
    if not isinstance(value, str):
        raise ValueError("QX script prefix must be a safe module title")
    if any(char in "=," or unicodedata.category(char) in {"Cc", "Cs", "Zl", "Zp"}
           for char in value):
        raise ValueError("QX script prefix must be a safe module title")
    value = value.strip()
    if not value or len(value) > 256 or value.startswith(("#", ";", "//")):
        raise ValueError("QX script prefix must be a safe module title")
    return value


def convert_qx_module(text: str, *, script_url=None, body_limit: int = QX_BODY_LIMIT,
                      script_prefix: str | None = None, script_start: int = 0) -> str:
    """Return a Surge module, optionally mapping ``script_url(url, kind)``.

    Kinds are request, request-body, response, response-body, echo and cron.
    Echo remains a distinct mapper kind although its Surge type is http-request.
    This lets the JS runtime convert QX's flat mock response without inventing a
    private ``argument`` parameter or changing the upstream script's arguments.
    Script labels use the effective module title and a one-based suffix without
    zero padding, e.g. ``Module title_1``. By default the title comes from the
    source metadata (or QX when absent); callers merging multiple sources can
    pass the effective title and continue numbering with ``script_start``.
    """
    if not isinstance(text, str) or not text.strip():
        raise ValueError("QX module is empty")
    if not isinstance(body_limit, int) or isinstance(body_limit, bool) or body_limit <= 0:
        raise ValueError("QX body limit must be a positive number of bytes")
    if not isinstance(script_start, int) or isinstance(script_start, bool) or script_start < 0:
        raise ValueError("QX script start must be a nonnegative integer")
    source_lines = text.lstrip("\ufeff").splitlines()
    if script_prefix is None:
        script_prefix = "QX"
        for raw in source_lines:
            line = raw.strip()
            if line.startswith("#!"):
                key, sep, value = line[2:].partition("=")
                if sep and key.strip() == "name":
                    script_prefix = value.strip() or "QX"
                    break
    script_prefix = _script_prefix(script_prefix)
    metadata, sections = OrderedDict(), OrderedDict()
    preamble, current, scripts, active = [], None, script_start, 0

    def add(section, line):
        sections.setdefault(section, []).append(line)

    def mapped_url(value, kind, number):
        original = _script_url(value, number)
        return _script_url(script_url(original, kind) if script_url else original, number)

    for number, raw in enumerate(source_lines, 1):
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#!"):
            key, sep, value = line[2:].partition("=")
            if not sep or not key.strip():
                raise _error(number, "invalid metadata")
            metadata.setdefault(key.strip(), value.strip())
            continue
        if line.startswith(("#", ";", "//")):
            comment = raw.rstrip() if line.startswith("#") else "# " + line.lstrip(";/ ")
            preamble.append(comment)
            continue
        if line.startswith("["):
            match = re.fullmatch(r"\[([^]\n]+)\]", line)
            if not match or match[1].lower() not in _QX_SECTIONS:
                raise _error(number, "unsupported section")
            current = match[1].lower()
            continue

        hostname = re.fullmatch(r"hostname\s*=\s*(.*)", line, re.I)
        if hostname:
            if current not in {None, "mitm"}:
                raise _error(number, "hostname appears outside the MITM section")
            names = [value.strip() for value in hostname[1].split(",")]
            if not names or any(not name or re.search(r"\s", name) for name in names):
                raise _error(number, "invalid MITM hostname list")
            add("MITM", "hostname = %APPEND% " + ", ".join(names))
            active += 1
            continue

        rewrite = _REWRITE_RE.match(line)
        if rewrite:
            if current not in {None, "rewrite_local"}:
                raise _error(number, "rewrite appears outside rewrite_local")
            pattern, action, value = rewrite.groups()
            action = action.lower()
            if action in _SCRIPT_TYPES:
                kind, requires_body, mapper_kind = _SCRIPT_TYPES[action]
                url = mapped_url(value, mapper_kind, number)
                scripts += 1
                options = [f"type={kind}", f"pattern={_csv_value(pattern, number)}"]
                if requires_body:
                    options += ["requires-body=true", f"max-size={body_limit}"]
                options.append(f"script-path={_csv_value(url, number)}")
                add("Script", f"{script_prefix}_{scripts} = " + ",".join(options))
            elif action in {"reject-200", "reject-dict", "reject-array", "reject-img"}:
                if value:
                    raise _error(number, "unexpected value after a reject action")
                payload = {"reject-200": 'data-type=text data=""',
                           "reject-dict": 'data-type=text data="{}"',
                           "reject-array": 'data-type=text data="[]"',
                           "reject-img": "data-type=tiny-gif"}[action]
                add("Map Local", f"{pattern} {payload} status-code=200")
            elif action == "reject":
                if value:
                    raise _error(number, "unexpected value after reject")
                add("URL Rewrite", f"{pattern} - reject")
            elif action in {"302", "307"}:
                if not value or any(c.isspace() for c in value):
                    raise _error(number, "a redirect requires one replacement URL")
                add("URL Rewrite", f"{pattern} {value} {action}")
            else:
                raise _error(number, "unsupported URL action")
            active += 1
            continue

        if current == "task_local":
            task = re.fullmatch(r"((?:\S+\s+){4}\S+)\s+(https?://[^,\s]+)(.*)", line)
            if not task:
                raise _error(number, "unsupported scheduled task")
            cron, url, rest = task.groups()
            options = {}
            if rest:
                if not rest.startswith(","):
                    raise _error(number, "invalid task options")
                for item in rest[1:].split(","):
                    key, sep, value = item.partition("=")
                    if not sep or key.strip() not in {"tag", "enabled"}:
                        raise _error(number, "unsupported task option")
                    options[key.strip()] = value.strip()
            enabled = options.get("enabled", "true").lower()
            if enabled not in {"true", "false"}:
                raise _error(number, "invalid task enabled value")
            if enabled == "true":
                scripts += 1
                # Preserve a tag as a comment, not an unchecked script label.
                if options.get("tag"):
                    add("Script", "# " + options["tag"])
                add("Script", f'{script_prefix}_{scripts} = type=cron,cronexp="{cron}",'
                    f'script-path={_csv_value(mapped_url(url, "cron", number), number)}')
            active += 1
            continue

        fields = [value.strip() for value in line.split(",")]
        kind = fields[0].lower()
        if kind in _RULE_TYPES:
            if current not in {None, "filter_local"}:
                raise _error(number, "filter appears outside filter_local")
            if len(fields) < 3 or any(not value for value in fields):
                raise _error(number, "invalid filter rule")
            flags = [flag.lower() for flag in fields[3:]]
            if any(flag not in {"no-resolve", "extended-matching"} for flag in flags):
                raise _error(number, "unsupported filter flag")
            if "no-resolve" in flags and kind not in _CIDR_TYPES | {"geoip", "ip-asn"}:
                raise _error(number, "no-resolve does not apply to this filter")
            if "extended-matching" in flags and kind not in _DOMAIN_TYPES:
                raise _error(number, "extended-matching does not apply to this filter")
            policy = _policy(fields[2])
            # Modules precede the profile's domain rules. CIDR rejects should
            # inspect known destination IPs without forcing DNS for every domain.
            if kind in _CIDR_TYPES and policy in _REJECT_POLICIES and "no-resolve" not in flags:
                flags.append("no-resolve")
            # Domain rejects also inspect sniffed SNI/Host when clients connect
            # by IP, while routing and custom policies retain source semantics.
            if kind in _DOMAIN_TYPES and policy in _REJECT_POLICIES and "extended-matching" not in flags:
                flags.append("extended-matching")
            add("Rule", ",".join([_RULE_TYPES[kind], fields[1], policy] + flags))
            active += 1
            continue
        raise _error(number, "unsupported executable directive")

    if not active:
        raise ValueError("QX module has no active supported directives")
    lines = [f"#!{key}={value}" for key, value in metadata.items()]
    if preamble:
        lines += [""] + preamble
    for section, content in sections.items():
        lines += ["", f"[{section}]"] + content
    return "\n".join(lines).strip() + "\n"
