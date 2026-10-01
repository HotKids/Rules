"""Surge modules → Stash overrides, generated locally without a conversion service.

Format mapping reference: Script-Hub-Org/Script-Hub (Rewrite-Parser.js).
Native fields: https://stash.wiki/http-engine/rewrite and /script/rewrite-requests.
This converter preserves source order and reports unsupported directives in the output.
"""
import re
from pathlib import PurePosixPath

import yaml


def module_targets(name):
    """An extension selects one format; an unqualified name selects both."""
    path = PurePosixPath(name)
    if not name or path.is_absolute() or any(p in (".", "..") for p in name.split("/")) or "\\" in name:
        raise ValueError(f"Invalid module output name: {name!r}")
    suffix = path.suffix.lower()
    if suffix in (".sgmodule", ".stoverride"):
        return [str(path.with_suffix(suffix))]
    if suffix:
        raise ValueError(f"Module format must be .sgmodule or .stoverride: {name}")
    return [name + ".sgmodule", name + ".stoverride"]


def parse_module(text):
    metadata, sections = {}, {}
    preamble = []
    section = None
    for raw in text.lstrip("\ufeff").splitlines():
        line = raw.strip()
        if line.startswith("#!") and "=" in line:
            key, value = line[2:].split("=", 1)
            metadata.setdefault(key.strip(), value.strip())
        elif re.fullmatch(r"\[[^]\n]+\]", line):
            section = line[1:-1]
            sections.setdefault(section, [])
        elif section:
            sections[section].append(raw.rstrip())
        elif line.startswith(("#", "//")):
            preamble.append(raw.rstrip())
    if not sections:
        raise ValueError("Module is empty or has no Surge sections")
    if preamble:
        sections = {"": preamble, **sections}
    return metadata, sections


def _unquote(value):
    return value[1:-1] if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0] else value


def _arguments(value):
    result = {}
    for item in value.split(","):
        key, sep, default = item.partition(":")
        if sep:
            result.setdefault(key.strip(), default.strip())
    return result


def merge_modules(sources):
    """sources = [(url, text, overrides)]; first source owns descriptive metadata."""
    metadata, sections, urls = {}, {}, []
    arguments = {}
    for index, (url, text, overrides) in enumerate(sources):
        meta, parsed = parse_module(text)
        meta.update(overrides)
        if index == 0:
            metadata = meta.copy()
        # Arguments are executable defaults, not descriptive metadata. Keep later
        # unique defaults so their placeholders work; duplicate keys use the first.
        for key, value in _arguments(meta.get("arguments", "")).items():
            arguments.setdefault(key, value)
        if url not in urls:
            urls.append(url)
        for section, lines in parsed.items():
            target = sections.setdefault(section, [])
            for line in lines:
                if line.strip() and line not in target:
                    target.append(line)
    if arguments:
        metadata["arguments"] = ",".join(f"{k}:{v}" for k, v in arguments.items())

    # Repeated hostname assignments would override earlier modules. Merge lists
    # explicitly; scalar settings follow the first declaration.
    for section in ("MITM", "General", "Host"):
        if section not in sections:
            continue
        output, positions = [], {}
        for line in sections[section]:
            if not line.strip() or line.lstrip().startswith(("#", "//")) or "=" not in line:
                output.append(line)
                continue
            key, value = (v.strip() for v in line.split("=", 1))
            list_key = (section, key) in (("MITM", "hostname"), ("General", "force-http-engine-hosts"))
            if key not in positions:
                positions[key] = len(output)
                output.append(line)
            elif list_key:
                previous = output[positions[key]].split("=", 1)[1].strip()
                values = _hosts(previous) + _hosts(value)
                prefix = "%APPEND% " if "%APPEND%" in previous + value else ""
                output[positions[key]] = key + " = " + prefix + ", ".join(dict.fromkeys(values))
            elif output[positions[key]].split("=", 1)[1].strip() != value:
                output.append("# Merge: first declaration retained; ignored: " + line)
        sections[section] = output

    # Surge labels must also remain unique; renaming does not change request matches.
    used = set()
    scripts = []
    for line in sections.get("Script", []):
        if line.lstrip().startswith(("#", "//")) or "=" not in line:
            scripts.append(line)
            continue
        name, value = line.split("=", 1)
        name = name.strip()
        unique, count = name, 2
        while unique in used:
            unique = f"{name}__{count}"
            count += 1
        used.add(unique)
        scripts.append(f"{unique} = {value.strip()}")
    if "Script" in sections:
        sections["Script"] = scripts
    return metadata, sections, urls


def _hosts(value):
    return [v.strip() for v in value.replace("%APPEND%", "").split(",") if v.strip()]


def render_surge(module):
    metadata, sections, urls = module
    lines = [f"#!{k}={v}" for k, v in metadata.items()]
    lines += [""] + [f"### fork from {url}" for url in urls]
    for section, content in sections.items():
        lines += [""] + ([f"[{section}]"] if section else []) + content
    return "\n".join(lines).rstrip() + "\n"


def _options(value, separator):
    # Delimit at option keys, not every comma/space: patterns contain {1,3},
    # arguments contain JSON with unescaped quotes, and cron expressions contain spaces.
    pattern = rf"(?:^|{separator})\s*([a-z][a-z0-9-]*)\s*="
    matches = list(re.finditer(pattern, value))
    result = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(value)
        result[match[1]] = _unquote(value[match.end():end].strip())
    return result


def _rule_parts(line):
    parts, start, depth, quote = [], 0, 0, None
    for index, char in enumerate(line):
        if char in "\"'" and (index == 0 or line[index - 1] != "\\"):
            quote = None if quote == char else char if quote is None else quote
        if quote:
            continue
        if char == "(": depth += 1
        elif char == ")": depth -= 1
        elif char == "," and depth == 0:
            parts.append(line[start:index].strip()); start = index + 1
    parts.append(line[start:].strip())
    return parts


def render_stash(module, output_name):
    metadata, sections, urls = module
    defaults = _arguments(metadata.get("arguments", ""))
    meta_keys = ("name", "desc", "author", "icon", "category", "homepage", "date", "version", "openUrl")
    result = {k: metadata[k] for k in meta_keys if k in metadata}
    result.setdefault("name", PurePosixPath(output_name).stem)
    http, providers, cron, warnings = {}, {}, [], []
    rules = []

    def warn(section, line):
        message = f"[{section}] {line}"
        if message not in warnings: warnings.append(message)

    def append(key, value):
        target = http.setdefault(key, [])
        if value not in target: target.append(value)

    def substitute(match):
        if match[1] not in defaults:
            raise ValueError(f"{output_name}: unresolved argument {match[1]}")
        return defaults[match[1]]

    for section, lines in sections.items():
        for raw in lines:
            if raw.lstrip().startswith(("#", "//")): continue
            line = re.sub(r"\{\{\{([^{}]+)\}\}\}", substitute, raw).strip()
            if not line or line.startswith(("#", "//")): continue
            if section == "Rule":
                parts = _rule_parts(line)
                if len(parts) < 3:
                    warn(section, line); continue
                kind, value, policy, *flags = parts
                if flags:
                    ignored = [f for f in flags if f != "no-resolve"]
                    if ignored: warn(section, "Surge-only options omitted: " + ",".join(ignored))
                if kind == "URL-REGEX" and policy.startswith("REJECT"):
                    action = {"REJECT": "reject", "REJECT-TINYGIF": "reject-img",
                              "REJECT-DROP": "reject-200", "REJECT-NO-DROP": "reject"}.get(policy)
                    if action: append("url-rewrite", f"{_unquote(value)} - {action}")
                    else: warn(section, line)
                    continue
                supported = {"DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "DOMAIN-WILDCARD", "IP-CIDR", "IP-CIDR6",
                             "IP-ASN", "GEOIP", "DEST-PORT", "DST-PORT", "SRC-PORT", "SRC-IP", "SRC-IP-CIDR", "AND", "OR", "NOT"}
                if kind not in supported:
                    warn(section, line); continue
                if policy.startswith("REJECT-"): policy = "REJECT"
                rule = ",".join([kind, value, policy] + (["no-resolve"] if "no-resolve" in flags else []))
                rule = re.sub(r"\bDEST-PORT,", "DST-PORT,", rule)
                rule = re.sub(r"\bSRC-IP,", "SRC-IP-CIDR,", rule)
                if rule not in rules: rules.append(rule)
            elif section in ("MITM", "General"):
                key, sep, value = line.partition("=")
                key = key.strip()
                if sep and (section, key) in (("MITM", "hostname"), ("General", "force-http-engine-hosts")):
                    for host in _hosts(value):
                        if host.startswith("!"): raise ValueError(f"{output_name}: unsupported hostname syntax: {host}")
                        else: append("mitm" if section == "MITM" else "force-http-engine", host)
                elif section == "MITM" and key in ("ca-p12", "ca-passphrase"):
                    # Keep CA management in the user's base configuration, not third-party modules.
                    warn(section, key + " omitted; use the base configuration CA")
                else: warn(section, line)
            elif section == "URL Rewrite":
                match = re.fullmatch(r"(.+)\s+(\S+)\s+(\S+)", line)
                if not match:
                    warn(section, line); continue
                pattern, replacement, action = match.groups()
                action = {"header": "transparent", "reject-tinygif": "reject-img"}.get(action, action)
                if action not in {"302", "307", "transparent", "reject", "reject-200", "reject-img", "reject-dict", "reject-array"}:
                    warn(section, line); continue
                append("url-rewrite", f"{pattern} {replacement} {action}")
            elif section in ("Body Rewrite", "Header Rewrite"):
                match = re.fullmatch(r"http-(request|response)(-jq)?\s+(\S+)\s+(.+)", line)
                if not match:
                    warn(section, line); continue
                direction, jq, pattern, expression = match.groups()
                if section == "Body Rewrite":
                    append("body-rewrite", f"{pattern} {direction}-{'jq' if jq else 'replace-regex'} {_unquote(expression) if jq else expression}")
                elif expression.startswith("header-"):
                    append("header-rewrite", f"{pattern} {direction}-{expression[7:]}")
                else: warn(section, line)
            elif section == "Map Local":
                pattern, sep, options = line.partition(" ")
                opts = _options(options, r"\s+")
                kind = opts.get("data-type", "text")
                if not sep or kind not in ("text", "base64", "tiny-gif") or "data-path" in opts or set(opts) - {"data-type", "data", "status-code", "header"}:
                    warn(section, line); continue
                body = opts.get("data", "")
                if kind == "tiny-gif":
                    kind, body = "base64", "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
                mock = {"match": pattern, kind: body, "status-code": int(opts.get("status-code", 200))}
                if not 100 <= mock["status-code"] <= 599: raise ValueError("Invalid mock status code")
                headers = {"Content-Type": "image/gif"} if opts.get("data-type") == "tiny-gif" else {}
                for header in opts.get("header", "").split("|"):
                    key, sep, value = header.partition(":")
                    if sep: headers[key.strip()] = value.strip()
                if headers: mock["headers"] = headers
                append("mock", mock)
            elif section == "Script":
                label, sep, options = line.partition("=")
                opts = _options(options.strip(), ",")
                kind, url = opts.get("type"), opts.get("script-path", "")
                if not sep or kind not in ("http-request", "http-response", "cron") or not url.startswith(("https://", "http://")):
                    warn(section, line); continue
                if kind == "cron" and not opts.get("cronexp") or kind != "cron" and not opts.get("pattern"):
                    raise ValueError(f"{output_name}: missing script match/cronexp: {label}")
                # Scope provider names by module so separate overrides cannot overwrite each other.
                name = PurePosixPath(output_name).with_suffix("").as_posix().replace("/", "-") + "-" + label.strip()
                candidate, number = name, 2
                while candidate in providers:
                    candidate = f"{name}__{number}"; number += 1
                name = candidate
                providers[name] = {"url": url, "interval": int(opts.get("script-update-interval", 86400))}
                script = {"name": name}
                if kind == "cron": script["cron"] = opts["cronexp"]
                else: script.update({"match": opts["pattern"], "type": kind[5:]})
                for key, target in (("requires-body", "require-body"), ("binary-body-mode", "binary-mode")):
                    if key in opts:
                        if opts[key].lower() not in ("true", "false", "0", "1"): raise ValueError(f"Invalid boolean: {key}")
                        script[target] = opts[key].lower() in ("true", "1")
                if "max-size" in opts: script["max-size"] = max(0, int(opts["max-size"]))
                if "timeout" in opts:
                    timeout = float(opts["timeout"])
                    script["timeout"] = int(timeout) if timeout.is_integer() else timeout
                if "argument" in opts: script["argument"] = opts["argument"]
                if "engine" in opts:
                    engine = {"webview": "webkit", "jsc": "jsc", "auto": "auto"}.get(opts["engine"])
                    if engine: script["engine"] = engine
                    else: warn(section, "Unsupported engine: " + opts["engine"])
                known = {"type", "script-path", "pattern", "cronexp", "script-update-interval", "requires-body", "binary-body-mode", "max-size", "timeout", "argument", "engine"}
                for key in opts.keys() - known: warn(section, "Unsupported option: " + key)
                if kind == "cron": cron.append(script)
                else: append("script", script)
            else:
                warn(section, line)
    if http:
        order = ("force-http-engine", "mitm", "url-rewrite", "header-rewrite", "body-rewrite", "mock", "script")
        result["http"] = {key: http[key] for key in order if key in http}
    if cron: result["cron"] = {"script": cron}
    if providers: result["script-providers"] = providers
    if rules: result["rules"] = rules
    comments = ["# Generated by .github/scripts/module_convert.py; edit sync-rules.txt instead."]
    comments += [f"# Source: {url}" for url in urls]
    comments += ["# " + line.lstrip("#/ ") for line in sections.get("", [])]
    # Defaults are already resolved; Surge's parameter editor instructions do not apply to Stash.
    comments += [f"# {k}: {v}" for k, v in metadata.items()
                 if k not in meta_keys and k not in ("arguments", "arguments-desc")]
    if defaults: comments += ["# Surge 参数已按默认值展开。"]
    # Routine Surge rule-option omissions stay in Action logs, not in the override.
    comments += ["# Not converted: " + warning for warning in warnings
                 if not warning.startswith("[Rule] Surge-only options omitted: ")]
    return "\n".join(comments) + "\n" + yaml.safe_dump(result, allow_unicode=True, sort_keys=False, width=1000), warnings
