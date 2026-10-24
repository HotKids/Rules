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
from config_sync.common import _REGION_CODE, strip_emoji


def _filter_anchors(prefix: str, groups: list[dict]) -> tuple[str, dict[str, str]]:
    """Keep final region/Relay filters in the base's anchor section."""
    declarations, references = {}, {}
    codes = {**_REGION_CODE, "England": "UK", "Germany": "DE"}
    for group in sorted(groups, key=lambda g: "Relay" in g["name"]):
        if not group.get("filter"):
            continue
        name = strip_emoji(group["name"])
        suffix = codes.get(name, "".join(re.findall(r"[A-Za-z0-9]+", name))) or "Group"
        anchor = "Filter" + suffix
        while anchor in declarations:
            anchor += "Group"
        declarations[anchor] = group["filter"]
        references[group["name"]] = anchor
    lines = prefix.splitlines()
    indices = [i for i, line in enumerate(lines) if re.match(r"^  - &Filter\w+\s", line)]
    if declarations and not indices:
        raise ValueError("Missing Mihomo filter anchor section")
    if indices:
        at = indices[0]
        lines = [line for i, line in enumerate(lines) if i not in indices]
        lines[at:at] = [f"  - &{name} {_yaml_sq(value)}" for name, value in declarations.items()]
    lines = ["  # 地区与 Relay 节点筛选正则（基座叠加 overlay 后的结果）"
             if line.startswith("  # 地区节点筛选正则") else line for line in lines]
    return "\n".join(lines) + "\n", references


def _group_lines(source: str, groups: list[dict], references: dict[str, str],
                 tags: dict[str, str] | None = None) -> list[str]:
    comments = _scan_sample_item_comments(source, "proxy-groups")
    lines = ["# ── 策略组 ──", "proxy-groups:"]
    has_region = bool(re.search(r"(?m)^  - &Region\s", source))
    for group in groups:
        if tags and group["name"] in tags:
            lines.append("  # " + tags[group["name"]])
        lines.extend("  " + line for line in comments.get(group["name"], []))
        parts = []
        for key, value in _ordered_group(group).items():
            if has_region and group.get("include-all-providers") and key == "name":
                parts += [f"name: {_yaml_flow(value)}", "<<: *Region"]
            elif has_region and group.get("include-all-providers") and (
                    key == "include-all-providers" or key == "type" and value == "select"):
                continue
            elif key == "filter" and group["name"] in references:
                parts.append(f"filter: *{references[group['name']]}")
            else:
                parts.append(f"{key}: {_yaml_flow(value)}")
        lines.append("  - {" + ", ".join(parts) + "}")
    return lines


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
    tags = {g["name"]: g.pop("_tag") for g in groups if "_tag" in g}
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

    # Retain base settings/subscriptions; update filter anchors to their final values.
    prefix, separator, _ = base.partition("# ── 策略组 ──")
    if not separator:
        raise ValueError("Missing Mihomo proxy group section")
    prefix = prefix.replace("# 本地节点（订阅覆盖此处）", "# 本地节点（手动维护，同步保留）", 1)
    prefix = prefix.replace("# 服务器订阅配置（每小时更新，健康检查用 Cloudflare 204）",
                            "# 服务器订阅配置（手动维护，同步保留）", 1)
    prefix, references = _filter_anchors(prefix, groups)
    data["anchors"] = yaml.safe_load(prefix)["anchors"]
    header = f"# Personal Mihomo configuration: Clash/Mihomo.yaml + {label}\n"
    lines = [header + prefix.rstrip(), "", *_group_lines(base, groups, references, tags)]
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


def _editable_block(text: str, key: str, required: bool = False) -> tuple | None:
    """Read one top-level block without parsing unrelated generated sections."""
    escaped = re.escape(key)
    matches = list(re.finditer(rf"(?m)^(?:{escaped}|'{escaped}'|\"{escaped}\")\s*:[^\n]*(?:\n|$)", text))
    if not matches and not required:
        return None
    if len(matches) != 1:
        raise ValueError(f"Expected one editable {key} block")
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
        value = yaml.safe_load(block)[key]
    except (yaml.YAMLError, KeyError, TypeError):
        raise ValueError(f"Cannot parse the editable {key} block; nothing was published") from None
    return start, end, block, value


def _manual_proxies(text: str) -> tuple[int, int, str, list[dict]]:
    """Validate the required user-owned node list, retaining its source text."""
    start, end, block, proxies = _editable_block(text, "proxies", required=True)
    if not isinstance(proxies, list) or any(
            not isinstance(p, dict) or not isinstance(p.get("name"), str) or not p["name"]
            for p in proxies):
        raise ValueError("Editable proxies must be a list of named nodes")
    if len({p["name"] for p in proxies}) != len(proxies):
        raise ValueError("Editable proxies contain duplicate node names")
    return start, end, block, proxies


def _manual_proxy_providers(text: str) -> tuple | None:
    block = _editable_block(text, "proxy-providers")
    if block is not None and block[3] is not None and not isinstance(block[3], dict):
        raise ValueError("Editable proxy-providers must be a mapping or empty")
    return block


def migrate_inline_provider(existing: str) -> str:
    """One-time, explicitly requested move; normal synchronization never calls this."""
    node_start, node_end, _, nodes = _manual_proxies(existing)
    if not nodes:
        return existing
    original = _manual_proxy_providers(existing)
    providers = dict(original[3] or {}) if original is not None else {}
    if "Manual" in providers:
        raise ValueError("The Manual provider already exists; no migration applied")
    providers["Manual"] = {
        "type": "inline", "payload": nodes,
        "health-check": {"enable": True, "url": "http://cp.cloudflare.com/generate_204", "interval": 600},
    }

    class IndentedDumper(yaml.SafeDumper):
        def increase_indent(self, flow=False, indentless=False):
            return super().increase_indent(flow, False)

    block = yaml.dump({"proxy-providers": providers}, Dumper=IndentedDumper,
                      allow_unicode=True, sort_keys=False, width=1000)
    replacements = [(node_start, node_end, "proxies: []\n")]
    if original is not None:
        replacements.append((*original[:2], block))
    result = existing
    for start, end, content in sorted(replacements, reverse=True):
        result = result[:start] + content + result[end:]
    if original is None:
        at = _manual_proxies(result)[1]
        result = result[:at] + "\n" + block + result[at:]
    moved = _manual_proxy_providers(result)[3]
    if _manual_proxies(result)[3] or moved != providers or moved["Manual"]["payload"] != nodes:
        raise ValueError("Inline provider migration failed validation")
    return result


def compact_inline_provider(existing: str) -> str:
    """Explicit formatting only: keep each Manual payload node on one flow-style line."""
    original = _manual_proxy_providers(existing)
    providers = original[3] if original is not None else None
    provider = providers.get("Manual") if isinstance(providers, dict) else None
    if not isinstance(provider, dict) or provider.get("type") != "inline":
        raise ValueError("The Manual inline Provider is missing")
    nodes = provider.get("payload")
    if not isinstance(nodes, list) or any(not isinstance(node, dict) for node in nodes):
        raise ValueError("The Manual payload must be a node list")

    class FlowNode(dict):
        pass

    class CompactDumper(yaml.SafeDumper):
        def increase_indent(self, flow=False, indentless=False):
            return super().increase_indent(flow, False)

    CompactDumper.add_representer(FlowNode, lambda dumper, node:
        dumper.represent_mapping('tag:yaml.org,2002:map', node, flow_style=True))
    CompactDumper.add_representer(str, lambda dumper, value:
        dumper.represent_scalar('tag:yaml.org,2002:str', value,
                               style='"' if value.splitlines() != [value] else None))
    updated = {**providers, "Manual": {**provider, "payload": [FlowNode(node) for node in nodes]}}
    block = yaml.dump({"proxy-providers": updated}, Dumper=CompactDumper,
                      allow_unicode=True, sort_keys=False, width=10**9)
    if yaml.safe_load(block)["proxy-providers"] != providers:
        raise ValueError("Compact node formatting changed provider data")
    start, end = original[:2]
    return existing[:start] + block + existing[end:]


def apply_manual_proxies(rendered: str, existing: str) -> str:
    """Preserve both user-owned node source blocks and include inline nodes in pools."""
    _, _, manual, proxies = _manual_proxies(existing)
    providers = _manual_proxy_providers(existing)
    start, end, _, _ = _manual_proxies(rendered)
    result = rendered[:start] + manual.rstrip("\n") + "\n" + rendered[end:]
    generated_providers = _editable_block(result, "proxy-providers")
    provider_text = providers[2].rstrip("\n") + "\n" if providers is not None else ""
    if generated_providers is not None:
        start, end = generated_providers[:2]
        result = result[:start] + provider_text + result[end:]
    elif provider_text:
        at = result.index("# ── 策略组 ──")
        result = result[:at] + provider_text + "\n" + result[at:]
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
        references = {}
        for line in rendered.splitlines():
            if not (match := re.search(r"^  - \{name: (.*?), .*\bfilter: \*(Filter\w+)", line)):
                continue
            references[yaml.safe_load(match[1])] = match[2]
        lines = _group_lines(rendered, groups, references)
        start = result.index("# ── 策略组 ──")
        end = result.index("# ── 规则集 ──")
        result = result[:start] + "\n".join(lines) + "\n\n" + result[end:]
        if yaml.safe_load(result) != data:
            raise ValueError("Manual node merge failed validation")
    except (yaml.YAMLError, KeyError, TypeError, ValueError, re.error):
        # Never expose node credentials through parser messages or tracebacks.
        raise ValueError("Cannot merge the editable proxies/proxy-providers blocks; nothing was published") from None
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
