#!/usr/bin/env python3
"""Update private client configurations without printing their contents or URL."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request


class PublishError(Exception):
    """A message safe to display in public workflow logs."""


def _apply_manual_proxies(rendered, existing, migrate_inline=False, compact_inline=False, provider_name=None):
    try:
        path = Path(__file__).with_name('render-mihomo-overlay.py')
        spec = importlib.util.spec_from_file_location('render_mihomo_overlay', path)
        renderer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(renderer)
        if migrate_inline:
            existing = renderer.migrate_inline_provider(existing, provider_name)
        if compact_inline:
            existing = renderer.compact_inline_provider(existing, provider_name)
        return renderer.apply_manual_proxies(rendered, existing)
    except Exception:
        # Parser exceptions can contain private node values and source lines.
        raise PublishError('Cannot preserve the manual proxies/proxy-providers blocks; no changes published.') from None


def _render_stash(base_path, mihomo):
    try:
        path = Path(__file__).with_name('render-stash-gist.py')
        spec = importlib.util.spec_from_file_location('render_stash_gist', path)
        renderer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(renderer)
        content = renderer.render(Path(base_path).read_text(encoding='utf-8'), mihomo)
        if not isinstance(content, str) or not content.strip():
            raise ValueError('Empty Stash output')
        return content
    except Exception:
        raise PublishError('Cannot generate stash.yaml; no changes published.') from None


def _request(method, url, token, payload=None):
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode('utf-8')
    request = urllib.request.Request(url, data=body, method=method, headers={
        'Accept': 'application/vnd.github+json',
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json',
        'User-Agent': 'HotKids-Rules-private-gist-sync',
        'X-GitHub-Api-Version': '2022-11-28',
    })
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        raise PublishError(f'Gist request failed (HTTP {error.code}).') from None
    except (OSError, ValueError):
        raise PublishError('Gist request failed; response details omitted.') from None
    if not isinstance(result, dict):
        raise PublishError('Unexpected Gist response; details omitted.')
    return result


def publish(path, migrate_inline=False, compact_inline=False, stash_base=None, provider_name=None):
    gist_id = os.environ.get('MIHOMO_GIST_ID', '').strip()
    token = os.environ.get('GIST_TOKEN', '').strip()
    missing = [name for name, value in (('MIHOMO_GIST_ID', gist_id), ('GIST_TOKEN', token)) if not value]
    if missing:
        raise PublishError('Missing repository Secrets: ' + ', '.join(missing) + '.')
    if not re.fullmatch(r'[0-9a-fA-F]{5,64}', gist_id):
        raise PublishError('MIHOMO_GIST_ID must contain only the Gist ID.')
    try:
        content = Path(path).read_text(encoding='utf-8')
    except (OSError, UnicodeError):
        raise PublishError('Cannot read the generated configuration; details omitted.') from None
    if not content.strip():
        raise PublishError('Refusing to publish an empty configuration.')

    url = 'https://api.github.com/gists/' + gist_id
    gist = _request('GET', url, token)
    if gist.get('public') is not False:
        raise PublishError('Refusing to publish: the target must be a private Gist.')
    files = gist.get('files')
    target = files.get('mihomo.yaml') if isinstance(files, dict) else None
    if not isinstance(target, dict) or target.get('truncated') or not isinstance(target.get('content'), str):
        raise PublishError('Cannot verify the existing mihomo.yaml; no changes published.')
    content = _apply_manual_proxies(content, target['content'], migrate_inline=migrate_inline,
                                   compact_inline=compact_inline, provider_name=provider_name)
    changes = {}
    if target['content'] != content:
        changes['mihomo.yaml'] = {'content': content}
    if stash_base is not None:
        stash_target = files.get('stash.yaml')
        if 'stash.yaml' in files and (
                not isinstance(stash_target, dict) or stash_target.get('truncated')
                or not isinstance(stash_target.get('content'), str)):
            raise PublishError('Cannot verify the existing stash.yaml; no changes published.')
        stash_content = _render_stash(stash_base, content)
        if stash_target is None or stash_target['content'] != stash_content:
            changes['stash.yaml'] = {'content': stash_content}
    if not changes:
        return False
    # One PATCH publishes both derived files together and leaves every other file intact.
    _request('PATCH', url, token, {'files': changes})
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--migrate-inline', action='store_true',
                        help='Explicitly move top-level nodes into a selected inline provider')
    parser.add_argument('--compact-inline', action='store_true',
                        help='Explicitly format inline payload nodes as flow-style lines')
    parser.add_argument('--provider-name',
                        help='Optional target; migration auto-selects a unique existing inline provider')
    parser.add_argument('--stash-base', type=Path,
                        help='Public MyStash override used to generate stash.yaml in memory')
    parser.add_argument('config', help='Path to the generated configuration')
    args = parser.parse_args(argv)
    try:
        changed = publish(args.config, migrate_inline=args.migrate_inline, compact_inline=args.compact_inline,
                          stash_base=args.stash_base, provider_name=args.provider_name)
    except PublishError as error:
        print(str(error), file=sys.stderr)
        return 1
    print('Private Gist updated.' if changed else 'Private Gist already up to date.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
