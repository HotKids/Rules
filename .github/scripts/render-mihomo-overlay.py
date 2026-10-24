#!/usr/bin/env python3
"""Render a personal Mihomo YAML without changing the public base configuration."""
import argparse
import json
from pathlib import Path
import re

import yaml

from config_sync.clash import (
    _apply_overlay,
    _ordered_group,
    _rule_policy_index,
    _scan_sample_item_comments,
    _yaml_flow,
    _yaml_sq,
)


def render(base: str, overlay: dict, label: str) -> str:
    # This target uses one overlay; never silently ignore chained differences.
    if overlay.get("extends"):
        raise ValueError("Chained overlays are not supported by this YAML target")
    supported = {
        "_comment", "output", "stash_output", "disabled_by_default", "rules_insert",
        "group_overrides", "group_proxies_insert", "extra_pool_groups",
        "rule_policy_redirect", "remove_groups", "rename_map", "icon_overrides", "move_after",
    }
    if set(overlay) - supported:
        raise ValueError("Unsupported overlay directive")
    data = yaml.safe_load(base)
    groups, rules = data["proxy-groups"], data["rules"]
    pools = {g["name"]: g.get("filter") for g in groups
             if g.get("include-all-providers") or g.get("use") == ["Server"]}
    structural = set(pools)
    _apply_overlay(groups, pools, rules, structural, overlay, label)

    # Static YAML has no JavaScript switches: apply their declared default state.
    main_group = next((r.split(",", 1)[1] for r in rules if r.startswith("MATCH,")), None)
    referenced = {p for g in groups for p in g.get("proxies", [])}
    optional = {g["name"] for g in groups if not g.get("hidden") and g["name"] != main_group
                and (g["name"] not in structural or g["name"] not in referenced)}
    disabled = overlay.get("disabled_by_default", [])
    if set(disabled) - optional:
        raise ValueError("disabled_by_default references a missing or required group")
    _apply_overlay(groups, pools, rules, structural, {"remove_groups": disabled}, label)
    for group in groups:
        if group["name"] not in pools:
            continue
        # Native provider selection keeps the subscription order and static candidates.
        group["include-all-providers"] = True
        value = pools[group["name"]]
        if value is None:
            group.pop("filter", None)
        else:
            group["filter"] = value

    used = {m[1] for r in rules for m in re.finditer(r"(?:^|\()RULE-SET,([^,()]+),", r)}
    providers = {name: spec for name, spec in data["rule-providers"].items() if name in used}
    if used - providers.keys():
        raise ValueError("A rule references an undefined provider")
    names = {g["name"] for g in groups}
    if len(names) != len(groups):
        raise ValueError("Duplicate proxy group name")
    known = names | {p["name"] for p in data.get("proxies", [])} | {
        "DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE", "GLOBAL",
    }
    if any(set(g.get("proxies", [])) - known for g in groups):
        raise ValueError("A group references an undefined proxy")
    if any(r.split(",")[_rule_policy_index(r.split(","))] not in known for r in rules):
        raise ValueError("A rule references an undefined policy")

    # Retain the base settings, anchors and subscription declarations verbatim.
    prefix, separator, _ = base.partition("# ── 策略组 ──")
    if not separator:
        raise ValueError("Missing Mihomo proxy group section")
    header = f"# Personal Mihomo configuration: Clash/Mihomo.yaml + {label}\n"
    lines = [header + prefix.rstrip(), "", "# ── 策略组 ──", "proxy-groups:"]
    comments = _scan_sample_item_comments(base, "proxy-groups")
    for group in groups:
        lines.extend("  " + line for line in comments.get(group["name"], []))
        lines.append("  - " + _yaml_flow(_ordered_group(group)))
    lines.extend(["", "# ── 规则集 ──", "rule-providers:"])
    for name, spec in providers.items():
        lines.append("  " + _yaml_flow(name) + ": " + _yaml_flow(spec))
    lines.extend(["", "# ── 规则 ──", "rules:"])
    comments = dict(_scan_sample_item_comments(base, "rules").get("__list__", []))
    for rule in rules:
        lines.extend("  " + line for line in comments.get(rule, []))
        lines.append("  - " + _yaml_sq(rule))
    result = "\n".join(lines) + "\n"
    if yaml.safe_load(result) != {**data, "rule-providers": providers}:
        raise ValueError("Rendered YAML differs from the merged configuration")
    return result


def _manual_proxies(text: str) -> tuple[int, int, str, list[dict]]:
    """Read only this top-level block; old unrelated YAML errors must not lose nodes."""
    matches = list(re.finditer(r"(?m)^proxies:[^\n]*(?:\n|$)", text))
    if len(matches) != 1:
        raise ValueError("Expected one editable proxies block")
    start, after_key = matches[0].span()
    following = re.search(r"(?m)^(?:[A-Za-z_][\w-]*|'[^'\n]+'|\"[^\"\n]+\")\s*:", text[after_key:])
    end = after_key + following.start() if following else len(text)
    block = text[start:end]
    # Section comments before the next top-level key belong to that next section.
    lines = block.splitlines(keepends=True)
    while len(lines) > 1 and (not lines[-1].strip() or lines[-1].lstrip().startswith("#")):
        end -= len(lines.pop())
    block = text[start:end]
    try:
        proxies = yaml.safe_load(block)["proxies"]
    except (yaml.YAMLError, KeyError, TypeError):
        raise ValueError("Cannot parse the editable proxies block; nothing was published") from None
    if not isinstance(proxies, list) or any(
            not isinstance(p, dict) or not isinstance(p.get("name"), str) or not p["name"]
            for p in proxies):
        raise ValueError("Editable proxies must be a list of named nodes")
    if len({p["name"] for p in proxies}) != len(proxies):
        raise ValueError("Editable proxies contain duplicate node names")
    return start, end, block, proxies


def apply_manual_proxies(rendered: str, existing: str) -> str:
    """Preserve the Gist's editable proxies verbatim and include those nodes in pools."""
    _, _, manual, proxies = _manual_proxies(existing)
    start, end, _, _ = _manual_proxies(rendered)
    result = rendered[:start] + manual.rstrip("\n") + "\n" + rendered[end:]
    try:
        data = yaml.safe_load(result)
        groups = data["proxy-groups"]
        node_names = [p["name"] for p in proxies]
        group_names = {g["name"] for g in groups}
        if group_names.intersection(node_names):
            raise ValueError("Editable node names conflict with generated groups")
        for group in groups:
            if not (group.get("include-all-providers") or group.get("use") == ["Server"]):
                continue
            pattern = group.get("filter")
            # Match the existing MyScript.js filters while keeping manual node order.
            matched = [name for name in node_names if not pattern or re.search(pattern, name, re.ASCII)]
            candidates = list(group.get("proxies", []))
            candidates.extend(name for name in matched if name not in candidates)
            if candidates:
                group["proxies"] = candidates
        comments = _scan_sample_item_comments(rendered, "proxy-groups")
        lines = ["# ── 策略组 ──", "proxy-groups:"]
        for group in groups:
            lines.extend("  " + line for line in comments.get(group["name"], []))
            lines.append("  - " + _yaml_flow(_ordered_group(group)))
        start = result.index("# ── 策略组 ──")
        end = result.index("# ── 规则集 ──")
        result = result[:start] + "\n".join(lines) + "\n\n" + result[end:]
        if yaml.safe_load(result) != data:
            raise ValueError("Manual node merge failed validation")
    except (yaml.YAMLError, KeyError, TypeError, ValueError, re.error):
        # Never expose node credentials through parser messages or tracebacks.
        raise ValueError("Cannot merge the editable proxies block; nothing was published") from None
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--overlay", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.resolve() in {args.base.resolve(), args.overlay.resolve()}:
        parser.error("Output must be separate from the source files")
    result = render(args.base.read_text(encoding="utf-8"),
                    json.loads(args.overlay.read_text(encoding="utf-8")), args.overlay.name)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(result, encoding="utf-8")
    print("Personal Mihomo configuration rendered and validated")


if __name__ == "__main__":
    main()
