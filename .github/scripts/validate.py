#!/usr/bin/env python3
"""Shared CI/publish gate. Runs offline unless --regenerate is requested."""
import argparse
import ast
import json
from pathlib import Path
import subprocess
import sys

import yaml

ROOT = Path(__file__).resolve().parents[2]


def run(*command):
    subprocess.run(command, cwd=ROOT, check=True)


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument('--regenerate', action='store_true')
    options = args.parse_args()
    if options.regenerate:
        run(sys.executable, '.github/scripts/sync-config.py')
    counts = dict(python=0, javascript=0, yaml=0, json=0)
    for folder in ('.github/scripts', '.github/tests'):
        for p in sorted((ROOT / folder).rglob('*.py')):
            ast.parse(p.read_text(encoding='utf-8'), filename=str(p)); counts['python'] += 1
    for folder in ('Clash/Script', 'Surge/Module/Scripts'):
        for p in sorted((ROOT / folder).glob('*.js')):
            run('node', '--check', str(p)); counts['javascript'] += 1
    for folder in ('.github', 'Clash', 'Surge/Module/Pannel', 'sing-box'):
        for p in sorted((ROOT / folder).rglob('*')):
            if p.name == 'snell-panel-ci.yml': continue
            if p.suffix in ('.yaml', '.yml', '.stoverride'):
                data = yaml.safe_load(p.read_text(encoding='utf-8')); counts['yaml'] += 1
                if p.suffix == '.stoverride':
                    if not isinstance(data, dict): raise ValueError(f'{p}: expected mapping')
                    providers = data.get('script-providers', {})
                    for tile in data.get('tiles', []):
                        if tile.get('name') not in providers:
                            raise ValueError(f'{p}: missing script provider for {tile.get("name")}')
            if p.suffix == '.json':
                json.loads(p.read_text(encoding='utf-8')); counts['json'] += 1
    sample = yaml.safe_load((ROOT/'Clash/Sample.yaml').read_text())
    mihomo = yaml.safe_load((ROOT/'Clash/Mihomo.yaml').read_text())
    mihomo.pop('anchors', None)
    for group in sample['proxy-groups']:
        if group.get('use') == ['Server']:
            del group['use']; group['include-all-providers'] = True
    if sample != mihomo: raise ValueError('Sample.yaml and Mihomo.yaml differ semantically')
    run(sys.executable, '-m', 'unittest', 'discover', '-s', '.github/tests', '-p', 'test_*.py')
    run('node', '--test', '.github/tests/panels.cjs')
    print('Validation passed:', counts)


if __name__ == '__main__': main()
