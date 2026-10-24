#!/usr/bin/env python3
"""Build standalone Stash YAML from MyStash and the private Mihomo node sources."""
import re

import yaml


_METADATA = {'name', 'desc', 'author', 'category', 'icon'}


class _FlowDumper(yaml.SafeDumper):
    pass


_FlowDumper.add_representer(str, lambda dumper, value:
    dumper.represent_scalar('tag:yaml.org,2002:str', value,
                           style='"' if value.splitlines() != [value] else None))


def _flow(value):
    return yaml.dump(value, Dumper=_FlowDumper, allow_unicode=True,
                     default_flow_style=True, sort_keys=False, width=10**9).rstrip()


def render(stash_base_text: str, mihomo_text: str) -> str:
    try:
        base = yaml.safe_load(stash_base_text)
        source = yaml.safe_load(mihomo_text)
    except yaml.YAMLError:
        raise ValueError('Cannot parse the Stash base or private node sources') from None
    if not isinstance(base, dict) or not isinstance(source, dict):
        raise ValueError('Configuration must be a mapping')
    if 'proxies' in base or 'proxy-providers' in base:
        raise ValueError('The Stash override must inherit its node sources')
    nodes, by_name, remote = [], {}, {}

    def add_nodes(items):
        if not isinstance(items, list):
            raise ValueError('Node sources must contain a list')
        for node in items:
            if not isinstance(node, dict) or not isinstance(node.get('name'), str) or not node['name']:
                raise ValueError('Invalid node definition')
            name = node['name']
            if name in by_name:
                if by_name[name] != node:
                    raise ValueError('Conflicting duplicate node definitions')
                continue
            nodes.append(node)
            by_name[name] = node

    top_nodes = source.get('proxies')
    add_nodes(top_nodes if top_nodes is not None else [])
    providers = source.get('proxy-providers')
    providers = providers if providers is not None else {}
    if not isinstance(providers, dict):
        raise ValueError('Invalid provider mapping')
    for name, provider in providers.items():
        if not isinstance(provider, dict):
            raise ValueError('Invalid provider definition')
        kind = provider.get('type', 'http')
        if kind == 'inline':
            if set(provider) - {'type', 'payload', 'health-check'}:
                raise ValueError('Unsupported inline provider options')
            payload = provider.get('payload')
            add_nodes(payload if payload is not None else [])
            continue
        if kind != 'http' or not isinstance(provider.get('url'), str) or not provider['url']:
            raise ValueError('Stash requires inline nodes or an HTTP provider URL')
        allowed = {'type', 'url', 'path', 'interval', 'filter', 'header', 'headers', 'health-check'}
        if set(provider) - allowed:
            raise ValueError('Unsupported remote provider options')
        item = {key: value for key, value in provider.items() if key not in {'type', 'header', 'health-check'}}
        if 'header' in provider:
            if 'headers' in provider and provider['header'] != provider['headers']:
                raise ValueError('Conflicting provider headers')
            item['headers'] = provider['header']
        # Stash health checks are managed by the groups from MyStash.stoverride.
        remote[name] = item

    lines = [line for line in stash_base_text.splitlines()
             if not re.match(r'^(?:name|desc|author|category|icon):', line)]
    text = re.sub(r'[ \t]+#!(?:replace|override|append)\b', '', '\n'.join(lines))
    prefix, separator, suffix = text.partition('\nproxy-groups:')
    if not separator:
        raise ValueError('Missing Stash proxy groups')
    marker = re.search(r'(?m)^# 服务器订阅配置\s*$', prefix)
    if marker:
        prefix = prefix[:marker.start()]
    out = ['# 来源：Clash/Script/MyStash.stoverride；节点复用同一 Gist 的 mihomo.yaml。',
           '# 请在 mihomo.yaml 维护节点，再运行同步 Action 更新本文件。',
           prefix.strip(), '', '# 节点（自动复用 mihomo.yaml）']
    if nodes:
        out.append('proxies:')
        out.extend('  - ' + _flow(node) for node in nodes)
    else:
        out.append('proxies: []')
    if remote:
        out.extend(['', '# 远程代理集（复用 mihomo.yaml）', 'proxy-providers:'])
        out.extend('  ' + _flow(name).removesuffix('\n...') + ': ' + _flow(item)
                   for name, item in remote.items())
    out.extend(['', 'proxy-groups:' + suffix])
    result = '\n'.join(out).rstrip() + '\n'
    expected = {key: value for key, value in base.items() if key not in _METADATA}
    expected['proxies'] = nodes
    if remote:
        expected['proxy-providers'] = remote
    try:
        actual = yaml.safe_load(result)
    except yaml.YAMLError:
        raise ValueError('Generated Stash configuration is invalid') from None
    if actual != expected:
        raise ValueError('Generated Stash configuration differs from its sources')
    return result
