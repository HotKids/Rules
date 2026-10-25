"""Generate the Profile enhancement module from the shared Surge profile."""
import re
from pathlib import PurePosixPath
from urllib.parse import unquote, urlsplit

from _common import write_if_changed
from .common import REPO_ROOT


TEMPLATE = ".github/scripts/sync-config/profile-module.ini"
OUTPUT = "Surge/Module/Profile.sgmodule"
_SECTION = re.compile(r"^\[([^\]]+)\]\s*$")
_REJECT_ACTIONS = {"REJECT", "REJECT-DROP", "REJECT-NO-DROP", "REJECT-TINYGIF"}


def _sections(text):
    sections, current = {}, None
    for line in text.splitlines():
        match = _SECTION.fullmatch(line.strip())
        if match:
            current = match[1]
            if current in sections:
                raise ValueError(f"Duplicate Profile module source section: {current}")
            sections[current] = []
        elif current is not None:
            sections[current].append(line)
    return sections


def _settings(lines):
    values = {}
    for line in lines:
        value = line.strip()
        if not value or value.startswith(("#", ";", "//")) or "=" not in value:
            continue
        key, _, value = value.partition("=")
        values[key.strip()] = value.strip()
    return values


def _general(lines, operations):
    result = []
    for line in lines:
        stripped = line.strip()
        if "=" in line and not stripped.startswith(("#", ";", "//")):
            key, separator, value = line.partition("=")
            operation = operations.get(key.strip().lower())
            if operation is not None:
                # The template owns the merge operation; never duplicate operators.
                value = re.sub(r"^\s*%(?:APPEND|INSERT)%\s*", "", value).strip()
                line = key + separator + " " + (operation + " " if operation else "") + value
        result.append(line)
    return "\n".join(result).strip()


def _rule_fields(line):
    """Locate fields without splitting the sub-rules of a logical rule."""
    fields, start, depth = [], 0, 0
    for index, char in enumerate(line):
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif char == "," and depth == 0:
            fields.append((start, index))
            start = index + 1
    fields.append((start, len(line)))
    return fields


def _rules(lines, aliases, policies, end_rule_set):
    end_index = None
    for index, line in enumerate(lines):
        candidate = re.sub(r"^(?:#|;|//)\s*", "", line.strip())
        fields = _rule_fields(candidate)
        values = [candidate[start:end].strip() for start, end in fields]
        if len(values) >= 2 and values[0] in {"RULE-SET", "DOMAIN-SET"} and PurePosixPath(unquote(urlsplit(values[1]).path)).stem.casefold() == end_rule_set.casefold():
            end_index = index
            break
    if end_index is None:
        raise ValueError(f"Profile module rule boundary not found: {end_rule_set}")
    result, pending = [], []
    for line in lines[:end_index + 1]:
        stripped = line.strip()
        disabled = re.match(r"^(#|;|//)\s*", stripped)
        candidate = stripped[disabled.end():] if disabled else stripped
        fields = _rule_fields(candidate)
        values = [candidate[start:end].strip() for start, end in fields]
        rule = bool(values and re.fullmatch(r"[A-Z][A-Z0-9-]*", values[0]) and len(fields) >= 2)
        if not stripped or (disabled and not rule):
            pending.append(line)
            continue
        if not rule:
            raise ValueError("Cannot parse a rule in the Profile module source prefix")
        compact = re.sub(r"\s+", "", candidate).upper()
        ssh = (values[0] == "DEST-PORT" and values[1] == "22") or (
            values[0] == "AND" and "(DEST-PORT,22)" in compact and "(PROTOCOL,TCP)" in compact)
        if ssh:
            pending.clear()
            continue
        policy_index = 1 if values[0] == "FINAL" else 2
        if len(fields) <= policy_index:
            raise ValueError("Missing rule policy in the Profile module source prefix")
        policy = values[policy_index]
        target = policies.get(policy, policies.get(aliases.get(policy, policy.upper())))
        if target is None:
            raise ValueError(f"Missing Profile module policy mapping: {policy}")
        start, end = fields[policy_index]
        value = candidate[start:end]
        leading = value[:len(value) - len(value.lstrip())]
        trailing = value[len(value.rstrip()):]
        rendered = candidate[:start] + leading + target + trailing + candidate[end:]
        result.extend(pending)
        pending.clear()
        result.append((stripped[:disabled.end()] if disabled else "") + rendered)
    return "\n".join(result).strip()


def render_profile_module(profile_text, template_text):
    source, template = _sections(profile_text), _sections(template_text)
    if "General" not in source:
        raise ValueError("Profile module source is missing [General]")
    if set(template) - {"General", "Rule Selection", "Rule Policy"}:
        raise ValueError("Unsupported Profile module template section")
    metadata = [line for line in template_text.splitlines() if line.startswith("#!")]
    if not any(line.startswith("#!name=") for line in metadata):
        raise ValueError("Profile module template is missing its name")
    operations = {key.lower(): value for key, value in _settings(template.get("General", [])).items()}
    if any(value not in {"", "%APPEND%", "%INSERT%"} for value in operations.values()):
        raise ValueError("Profile module General operations must be APPEND, INSERT or empty")
    policies = _settings(template.get("Rule Policy", []))
    arguments = next((line.partition("=")[2] for line in metadata if line.startswith("#!arguments=")), "")
    names = {item.partition(":")[0].strip() for item in arguments.split(",") if item.strip()}
    for target in policies.values():
        placeholder = re.fullmatch(r"\{\{\{([^{}]+)\}\}\}", target)
        if not (target in _REJECT_ACTIONS or target == "DIRECT" or (placeholder and placeholder[1] in names)):
            raise ValueError("Profile module rule policies must use internal actions or declared arguments")
    aliases = {key: value.split(",", 1)[0].strip().upper()
               for key, value in _settings(source.get("Proxy", [])).items()
               if value.split(",", 1)[0].strip().upper() in _REJECT_ACTIONS | {"DIRECT"}}
    parts = ["\n".join(metadata),
             "# 自动生成：设置与规则跟随 Surge/Profile.conf；模块参数和合并方式在 " + TEMPLATE + " 维护。",
             "[General]\n" + _general(source["General"], operations)]
    if "Host" in source:
        parts.append("[Host]" + ("\n" + "\n".join(source["Host"]).strip() if any(line.strip() for line in source["Host"]) else ""))
    selection = _settings(template.get("Rule Selection", []))
    end_rule_set = selection.get("end-rule-set")
    if not end_rule_set or set(selection) != {"end-rule-set"}:
        raise ValueError("Profile module template needs its end-rule-set boundary")
    rules = _rules(source.get("Rule", []), aliases, policies, end_rule_set)
    parts.append("[Rule]" + ("\n" + rules if rules else ""))
    return "\n\n".join(parts).rstrip() + "\n"


def _sync_profile_module(config):
    source = config.get("Surge", {}).get("source")
    if not source:
        return
    content = render_profile_module((REPO_ROOT / source).read_text(encoding="utf-8"),
                                    (REPO_ROOT / TEMPLATE).read_text(encoding="utf-8"))
    changed = write_if_changed(REPO_ROOT / OUTPUT, content)
    print(f"  ✓ {OUTPUT} {'已更新' if changed else '无变化'}")
