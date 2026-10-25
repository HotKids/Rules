#!/usr/bin/env python3
"""Convert annotated Loon sources at runtime and reuse the regular aggregator."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

from _common import fetch_url
from module_convert import parse_module

ROOT = Path(__file__).resolve().parents[2]
LISTING = Path(__file__).with_name('sync-modules.txt')
STABLE = ROOT / 'Surge/Module/BlockAds.sgmodule'
OUTPUT = ROOT / 'Surge/Module/BlockAdsBeta.sgmodule'
LOON_TEMPLATE = 'https://kelee.one/Tool/Loon/Lpx/{name}_remove_ads.lpx'
# This full UA is accepted by the download endpoint. It identifies the HTTP
# client, not the Loon grammar supported by the separately pinned parser.
LOON_UA = 'Loon/3.3.0 CFNetwork/1498.700.2 Darwin/23.6.0'
PARSER_URL = ('https://raw.githubusercontent.com/Script-Hub-Org/Script-Hub/'
              '761f7864785d032cd1d1d616e5a298a0c07aae7d/Rewrite-Parser.beta.js')
PARSER_SHA256 = '189d66701c9119ae5ce638278f531b35e8ba41e2372c7e55f8fa9d0dc58823d5'
JQ_FILE = re.compile(r'response\.json\.jq_file\s*\(\s*([\'"])(https://[^\'"]+)\1')
PLACEHOLDER = re.compile(r'\{\{\{([^{}]+)\}\}\}')
PM_ADVISORY = '逻辑运算符 AND 中的所有子规则必须是支持 pre-matching 的类型, 但 PROTOCOL 不支持'


@lru_cache(maxsize=1)
def load_aggregator():
    spec = importlib.util.spec_from_file_location('blockads_aggregator', Path(__file__).with_name('sync-modules.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def diagnostic_tail(value, *, max_lines=8):
    """Keep a bounded stderr tail without source URLs, query values or credentials."""
    if isinstance(value, bytes):
        value = value.decode('utf-8', errors='replace')
    text = str(value or '')
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
    text = re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', '', text)
    # Match plain, JSON-escaped and percent-encoded URLs before truncating;
    # cutting first could leave an unrecognizable URL/query fragment behind.
    text = re.sub(r'https?(?::|%(?:25)*3a)(?:\\?/|%(?:25)*2f){2}[^\s<>\'"]*',
                  '[URL]', text, flags=re.I)
    text = re.sub(r'[^\s<>\'"=]*_remove_ads\.lpx[^\s<>\'"]*', '[URL]', text, flags=re.I)
    text = re.sub(r'\b(?:Bearer|Basic)\s+[^\s,;\'"<>]+', '[CREDENTIAL]', text, flags=re.I)
    text = re.sub(r'(\b(?:proxy-authorization|authorization|set-cookie|cookie)\b[\'\"]?\s*[:=]\s*)[^\r\n]+',
                  r'\1[REDACTED]', text, flags=re.I)
    text = re.sub(r'''([?&;][^?&;=\s]{1,100}=)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^&#\s]*)''',
                  r'\1[REDACTED]', text)
    text = re.sub(r'''(\b[\w-]*(?:password|passwd|token|secret|api[-_]?key|psk|localtext)\b["']?\s*(?:[:=]|%(?:25)*3[ad])\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)''',
                  r'\1[REDACTED]', text, flags=re.I)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return '\n'.join(line[:240] for line in lines[-max_lines:])


def read_sources(path=LISTING):
    """A semicolon name belongs to exactly the next source, including disabled rows."""
    sources, pending = [], None
    for number, raw in enumerate(Path(path).read_text(encoding='utf-8').splitlines(), 1):
        line = raw.strip()
        if line.startswith(';'):
            pending = line[1:].strip()
            if not re.fullmatch(r'[A-Za-z0-9_-]+', pending):
                raise ValueError(f'第 {number} 行的 Loon 名称无效')
        elif re.match(r'#\s*https?://', line):
            pending = None
        elif line.startswith(('https://', 'http://')):
            fields = [item.strip() for item in line.split(',')]
            if len(fields) != 2 or not fields[1]:
                raise ValueError(f'第 {number} 行需要 URL,别名')
            sources.append({'id': str(number), 'name': pending, 'surge': fields[0], 'alias': fields[1]})
            pending = None
    if not sources:
        raise ValueError('Beta 来源清单为空')
    return sources


def runtime_url(source):
    return LOON_TEMPLATE.format(name=source['name']) if source['name'] else source['surge']


def download_sources(sources, cache=None):
    def get(source):
        name = source['name'] or 'ChinaUnicom'
        if cache:
            path = Path(cache) / (name + ('.lpx' if source['name'] else '.sgmodule'))
            text = path.read_text(encoding='utf-8')
        else:
            try:
                text = fetch_url(runtime_url(source), LOON_UA, encode=True)
            except Exception as error:
                status = getattr(error, 'status', None)
                raise RuntimeError(f'{name}: 来源读取失败' + (f' (HTTP {status})' if status else '')) from None
        if not re.search(r'(?:^|\n)\s*#!(?!error(?:\s|=))[a-z][\w-]*\s*=', text, re.I):
            raise ValueError(f'{name}: 来源缺少可读模块元数据')
        return source['id'], text
    with ThreadPoolExecutor(max_workers=8) as pool:
        return dict(pool.map(get, sources))


def read_arguments(value):
    result = {}
    for field in value.split(','):
        key, sep, default = field.partition(':')
        if sep:
            result[key.strip()] = default.strip()
    return result


def stable_bindings(sources, metadata):
    aliases = {source['alias'] for source in sources}
    matches = [(key, value) for key, value in read_arguments(metadata.get('arguments', '')).items()
               if value in aliases]
    if len(matches) != len(sources) or [value for _, value in matches] != [s['alias'] for s in sources]:
        raise ValueError('正式版参数与来源顺序不一致，保留现有 Beta')
    return dict(zip((s['id'] for s in sources), (key for key, _ in matches)))


def convert_sources(sources, bodies, parser, http_bodies):
    batch = [{'id': source['id'], 'body': bodies[source['id']]} for source in sources if source['name']]
    with tempfile.TemporaryDirectory(prefix='blockads-beta-') as directory:
        path = Path(directory) / 'parser.js'
        path.write_text(parser, encoding='utf-8')
        try:
            run = subprocess.run(['node', str(Path(__file__).with_name('convert-loon.cjs')), '--parser', str(path)],
                                 input=json.dumps({'sources': batch, 'httpBodies': http_bodies}),
                                 text=True, capture_output=True, timeout=180)
        except subprocess.TimeoutExpired as error:
            detail = diagnostic_tail(error.stderr)
            raise RuntimeError('Script-Hub 转换进程超时，保留现有 Beta' + ('\n' + detail if detail else '')) from None
    if run.returncode:
        detail = diagnostic_tail(run.stderr)
        raise RuntimeError(f'Script-Hub 转换进程失败 (exit {run.returncode})，保留现有 Beta'
                           + ('\n' + detail if detail else ''))
    results = json.loads(run.stdout)['results']
    if len(results) != len(batch) or [r.get('id') for r in results] != [s['id'] for s in batch]:
        raise ValueError('Script-Hub 返回的来源不完整')
    output = {}
    for result in results:
        source = next(s for s in sources if s['id'] == result['id'])
        warnings = [d['message'] for d in result.get('diagnostics', []) if d['level'] == 'warning']
        # This optional acceleration flag is inapplicable to PROTOCOL; the
        # official converter keeps the complete AND rule without that flag.
        safe_advisory = warnings and all(w == PM_ADVISORY for w in warnings)
        if result.get('error') or (result.get('unsupported') or warnings) and not safe_advisory:
            raise ValueError(f"{source['name']}: 存在无法等价转换的内容，保留现有 Beta")
        if safe_advisory:
            if '(PROTOCOL,QUIC)' not in result['text']:
                raise ValueError(f"{source['name']}: 转换遗漏 QUIC 规则")
            print(f"  [INFO] {source['name']}: 保留 QUIC 规则，未添加不适用的 pre-matching")
        output[source['id']] = result['text']
    for source in sources:
        if not source['name']:
            output[source['id']] = bodies[source['id']]
    return output


def normalize_source(text, display, header_args, module_name=None):
    metadata, sections = parse_module(text)
    metadata['name'] = module_name or display + '去广告'
    # Loon may refresh this date without changing rules; omit it from Beta groups.
    metadata.pop('date', None)
    defaults = read_arguments(metadata.get('arguments', ''))
    retained = {}
    substitutions = {}
    for key, default in defaults.items():
        combined = display + '-' + key
        if combined in header_args:
            retained[key] = header_args[combined]
        else:
            substitutions[key] = default
    if retained:
        metadata['arguments'] = ','.join(f'{k}:{v}' for k, v in retained.items())
    else:
        metadata.pop('arguments', None)
    # The aggregate keeps the existing human-written parameter help verbatim.
    metadata.pop('arguments-desc', None)
    for section, lines in sections.items():
        for index, line in enumerate(lines):
            line = PLACEHOLDER.sub(lambda m: substitutions.get(m[1], m[0]), line)
            lines[index] = line
    result = '\n'.join(f'#!{k}={v}' for k, v in metadata.items()) + '\n'
    for section, lines in sections.items():
        result += '\n' + (f'[{section}]\n' if section else '') + '\n'.join(lines) + '\n'
    return result


def generate(sources, converted, stable_text, output=OUTPUT):
    aggregator = load_aggregator()
    metadata, _ = parse_module(stable_text)
    bindings = stable_bindings(sources, metadata)
    header_args = read_arguments(metadata.get('arguments', ''))
    # Keep the regular module's exact application headings, including spaces.
    names = {}
    for line in stable_text.splitlines():
        if line.startswith('# > '):
            name = line[4:].split(' · ', 1)[0]
            names[name.replace('去广告', '').strip()] = name
    normalized = {source['id']: normalize_source(converted[source['id']], bindings[source['id']], header_args,
                                                names.get(bindings[source['id']]))
                  for source in sources}
    metadata['name'] = metadata['name'] + ' Beta'
    # Render to a temporary destination so validation failures cannot replace
    # the last complete Beta module.
    with tempfile.TemporaryDirectory(prefix='blockads-beta-render-') as directory:
        content = aggregator.aggregate(url_alias_list=[(s['id'], s['alias']) for s in sources],
                                       source_texts=normalized, output_file=Path(directory) / 'Beta.sgmodule',
                                       metadata=metadata, preserve_arguments=True)
    expected = {key: value for key, value in metadata.items() if key != 'date'}
    actual, sections = parse_module(content)
    if {key: value for key, value in actual.items() if key != 'date'} != expected:
        raise ValueError('Beta 头部与正式版不一致')
    missing = set(PLACEHOLDER.findall(content)) - set(header_args)
    if missing:
        raise ValueError('Beta 存在未定义参数: ' + ', '.join(sorted(missing)))
    if re.search(r'https?://[^\s\'"<>]*_remove_ads\.lpx', content):
        raise ValueError('Beta 产物包含不应展开的来源链接')
    if aggregator._write_stamped_if_changed(Path(output), content):
        print('✓ BlockAdsBeta.sgmodule 已更新')
    else:
        print('✓ BlockAdsBeta.sgmodule 无变化')
    return content


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument('--cache', type=Path, help='已下载来源的临时目录，仅供本地验证')
    args.add_argument('--parser', type=Path, help='已下载且校验过的官方解析器')
    args.add_argument('--http-bodies', type=Path, help='已下载的远程 jq_file 响应，仅供本地验证')
    options = args.parse_args()
    sources = read_sources()
    bodies = download_sources(sources, options.cache)
    parser = options.parser.read_text(encoding='utf-8') if options.parser else fetch_url(PARSER_URL, LOON_UA)
    if hashlib.sha256(parser.encode()).hexdigest() != PARSER_SHA256:
        raise ValueError('Script-Hub 解析器校验失败')
    if options.http_bodies:
        dependencies = json.loads(options.http_bodies.read_text(encoding='utf-8'))
    else:
        urls = list(dict.fromkeys(m[2] for body in bodies.values() for m in JQ_FILE.finditer(body)))
        with ThreadPoolExecutor(max_workers=8) as pool:
            dependencies = dict(zip(urls, pool.map(lambda url: fetch_url(url, LOON_UA, encode=True), urls)))
    converted = convert_sources(sources, bodies, parser, dependencies)
    generate(sources, converted, STABLE.read_text(encoding='utf-8'))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Keep the failure summary above the already bounded eight-line stderr.
        message = diagnostic_tail(error, max_lines=9)
        print('BlockAds Beta: ' + message, file=sys.stderr)
        sys.exit(1)
