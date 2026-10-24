#!/usr/bin/env python3
"""Update only mihomo.yaml in a private Gist; never print its contents or URL."""
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


def _apply_manual_proxies(rendered, existing):
    try:
        path = Path(__file__).with_name('render-mihomo-overlay.py')
        spec = importlib.util.spec_from_file_location('render_mihomo_overlay', path)
        renderer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(renderer)
        return renderer.apply_manual_proxies(rendered, existing)
    except Exception:
        # Parser exceptions can contain private node values and source lines.
        raise PublishError('Cannot preserve the manual proxies/proxy-providers blocks; no changes published.') from None


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


def publish(path):
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
    content = _apply_manual_proxies(content, target['content'])
    if target['content'] == content:
        return False
    # PATCH leaves all other files, the description and visibility unchanged.
    _request('PATCH', url, token, {'files': {'mihomo.yaml': {'content': content}}})
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config', help='Path to the generated configuration')
    args = parser.parse_args(argv)
    try:
        changed = publish(args.config)
    except PublishError as error:
        print(str(error), file=sys.stderr)
        return 1
    print('Private Gist updated.' if changed else 'Private Gist already up to date.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
