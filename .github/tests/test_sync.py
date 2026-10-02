"""Offline regression tests: no upstream downloads or user state changes."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import yaml

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import _common as common
from config_sync import parser, common as config_common, clash, stash


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DownloadTests(unittest.TestCase):
    def test_retry_transport_and_keep_http_status(self):
        with patch.object(common.urllib.request, 'urlopen', side_effect=urllib.error.HTTPError(
                'https://example.invalid', 503, 'unavailable', {}, None)) as request, patch.object(common.time, 'sleep'):
            with self.assertRaises(common.DownloadError) as error:
                common.fetch_url('https://example.invalid', 'test')
            self.assertEqual(error.exception.status, 503)
            self.assertEqual(request.call_count, 3)

    def test_404_is_not_retried(self):
        with patch.object(common.urllib.request, 'urlopen', side_effect=urllib.error.HTTPError(
                'https://example.invalid', 404, 'not found', {}, None)) as request:
            with self.assertRaises(common.DownloadError) as error:
                common.fetch_url('https://example.invalid', 'test')
            self.assertEqual(error.exception.status, 404)
            self.assertEqual(request.call_count, 1)

    def test_timeout_is_not_404(self):
        with patch.object(common.urllib.request, 'urlopen', side_effect=TimeoutError('timeout')), patch.object(common.time, 'sleep'):
            with self.assertRaises(common.DownloadError) as error:
                common.fetch_url('https://example.invalid', 'test')
            self.assertIsNone(error.exception.status)

    def test_empty_response_is_failure(self):
        response = io.BytesIO(b' \n')
        with patch.object(common.urllib.request, 'urlopen', return_value=response):
            with self.assertRaises(common.DownloadError):
                common.fetch_url('https://example.invalid', 'test')

    def test_partial_batch_raises_and_deduplicates(self):
        def fetch(url, *_args, **_kwargs):
            if url == 'bad': raise common.DownloadError(url, 'timeout')
            return 'ok'
        with patch.object(common, 'fetch_url', side_effect=fetch) as request:
            with self.assertRaises(common.DownloadBatchError):
                common.prefetch_urls(['ok', 'ok', 'bad'], 'test')
            self.assertEqual(request.call_count, 2)


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.r = load('sync-rules')
        self.m = load('sync-modules')
        self.r.REPO_ROOT = self.m.REPO_ROOT = self.root
        self.r.SURGE_DIR = self.root / 'Surge/RULE-SET'
        self.r.SURGE_DIR.mkdir(parents=True)
        self.r.MERGE_SECTION_TO_FILE = {}
        self.m.OUTPUT_FILE = self.root / 'BlockAds.sgmodule'

    def quiet(self, func):
        with contextlib.redirect_stdout(io.StringIO()): func()

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.root, check=True,
                              capture_output=True, text=True).stdout.strip()

    def commit(self, title):
        self.git('add', '.')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', title)
        return self.git('rev-parse', 'HEAD')

    def members(self):
        (self.r.SURGE_DIR / 'Alpha.list').write_text('# > Alpha\n### Streaming\nDOMAIN,alpha.example\n')
        (self.r.SURGE_DIR / 'Beta.list').write_text('# > Beta\n### Streaming US\nDOMAIN,beta.example\n')
        self.total = self.r.SURGE_DIR / 'Streaming.list'
        self.total.write_text('# > Alpha\nDOMAIN,alpha.example\n\n# > Beta\nDOMAIN,beta.example\n')

    def test_failed_module_source_preserves_output(self):
        self.m.OUTPUT_FILE.write_text('previous complete output')
        self.m.load_urls = lambda: [('ok', ''), ('bad', '')]
        def fetch(url, *_args, **_kwargs):
            if url == 'bad': raise common.DownloadError(url, 'timeout')
            return '#!name=Test\n[Rule]\nDOMAIN,test.example,REJECT\n'
        with patch.object(common, 'fetch_url', side_effect=fetch):
            with self.assertRaises(common.DownloadBatchError): self.quiet(self.m.aggregate)
        self.assertEqual(self.m.OUTPUT_FILE.read_text(), 'previous complete output')

    def test_empty_module_does_not_replace_output(self):
        self.m.OUTPUT_FILE.write_text('previous complete output')
        self.m.load_urls = lambda: [('bad', '')]
        self.m.prefetch_urls = lambda *_a, **_k: {'bad': '#!name=Only metadata'}
        with self.assertRaises(ValueError): self.quiet(self.m.aggregate)
        self.assertEqual(self.m.OUTPUT_FILE.read_text(), 'previous complete output')

    def test_failed_rules_source_preserves_group(self):
        path = self.r.SURGE_DIR / 'Combined.list'; path.write_text('previous complete rules')
        self.r.parse_sync_rules = lambda: {'surge': [
            {'name': 'Combined', 'url': u, 'overrides': {}} for u in ['ok', 'bad']],
            'surge_domainset': [], 'clash': [], 'module': []}
        def fetch(url, *_args, **_kwargs):
            if url == 'bad': raise common.DownloadError(url, 'timeout')
            return 'DOMAIN,test.example\n'
        with patch.object(common, 'fetch_url', side_effect=fetch):
            with self.assertRaises(common.DownloadBatchError): self.quiet(self.r.fetch_external_rules)
        self.assertEqual(path.read_text(), 'previous complete rules')

    def test_global_member_survives_two_rebuilds(self):
        self.members()
        self.total.write_text(self.total.read_text().replace('DOMAIN,alpha.example', 'DOMAIN,new.example'))
        self.r._recently_changed_files = lambda: {'Surge/RULE-SET/Streaming.list'}
        self.quiet(self.r.sync_streaming)
        self.assertIn('### Streaming\n', (self.r.SURGE_DIR/'Alpha.list').read_text())
        once = self.total.read_text()
        self.r._recently_changed_files = lambda: set()
        self.quiet(self.r.sync_streaming)
        self.assertEqual(once, self.total.read_text())
        self.assertIn('new.example', self.total.read_text())

    def test_grouped_member_preserves_every_section(self):
        self.members()
        alpha = self.r.SURGE_DIR/'Alpha.list'
        alpha.write_text(alpha.read_text() + '\n# > Extra\nDOMAIN,extra.example\n')
        self.r.MERGE_SECTION_TO_FILE = {'Alpha': 'Alpha', 'Extra': 'Alpha'}
        self.total.write_text(self.total.read_text()+'\n# > Extra\nDOMAIN,extra.example\n')
        self.r._recently_changed_files = lambda: {'Surge/RULE-SET/Streaming.list'}
        self.quiet(self.r.sync_streaming)
        self.assertIn('DOMAIN,alpha.example', alpha.read_text())
        self.assertIn('DOMAIN,extra.example', alpha.read_text())

    def test_push_range_includes_earlier_commit(self):
        self.git('init', '-q'); self.members(); before = self.commit('baseline')
        self.total.write_text(self.total.read_text().replace('alpha.example', 'new.example'))
        event_sha = self.commit('edit total')
        (self.root/'README.md').write_text('unrelated'); self.commit('later unrelated edit')
        with patch.dict(os.environ, {'SYNC_EVENT_NAME': 'push', 'SYNC_BASE_SHA': before, 'SYNC_EVENT_SHA': event_sha}):
            self.quiet(self.r.sync_streaming)
        self.assertIn('new.example', (self.r.SURGE_DIR/'Alpha.list').read_text())

    def test_conflicting_edits_fail_before_writes(self):
        self.members(); self.total.write_text(self.total.read_text().replace('alpha.example', 'new.example'))
        before = {p: p.read_text() for p in self.r.SURGE_DIR.glob('*.list')}
        self.r._recently_changed_files = lambda: {'Surge/RULE-SET/Streaming.list', 'Surge/RULE-SET/Alpha.list'}
        with self.assertRaisesRegex(ValueError, '同时修改'): self.quiet(self.r.sync_streaming)
        self.assertEqual(before, {p: p.read_text() for p in before})

    def test_consistent_both_sides_are_idempotent(self):
        self.members(); before = self.total.read_text()
        self.r._recently_changed_files = lambda: {'Surge/RULE-SET/Streaming.list', 'Surge/RULE-SET/Alpha.list'}
        self.quiet(self.r.sync_streaming)
        self.assertEqual(before, self.total.read_text())

    def test_schedule_does_not_replay_last_commit(self):
        self.git('init', '-q'); self.members(); self.commit('baseline')
        with patch.dict(os.environ, {'SYNC_EVENT_NAME': 'schedule', 'SYNC_BASE_SHA': '', 'SYNC_EVENT_SHA': ''}):
            self.assertEqual(self.r._recently_changed_files(), set())

    def test_schedule_refuses_pending_aggregate_edits(self):
        self.members()
        self.total.write_text(self.total.read_text().replace('alpha.example', 'pending.example'))
        before = self.total.read_text()
        with patch.dict(os.environ, {'SYNC_EVENT_NAME': 'schedule', 'SYNC_BASE_SHA': ''}):
            with patch.object(self.r, 'fetch_external_rules') as fetch:
                with self.assertRaises(ValueError): self.quiet(self.r.main)
                fetch.assert_not_called()
        self.assertEqual(before, self.total.read_text())

    def test_unavailable_push_history_fails(self):
        self.git('init', '-q'); self.members(); self.commit('baseline')
        with patch.dict(os.environ, {'SYNC_EVENT_NAME': 'push', 'SYNC_BASE_SHA': 'bad-ref', 'SYNC_EVENT_SHA': ''}):
            with self.assertRaises(subprocess.CalledProcessError): self.r._recently_changed_files()


class ConfigTests(unittest.TestCase):
    def test_missing_include_fails(self):
        with patch.dict(parser._url_cache, {}, clear=True), patch.object(parser.urllib.request, 'urlopen', side_effect=TimeoutError):
            with self.assertRaises(RuntimeError): parser._fetch_remote_section('https://example.invalid', 'dns')

    def test_shared_general_injection(self):
        with patch.dict(config_common._GENERAL_INJECT, {'@@test@@': 'value'}, clear=True):
            self.assertEqual(config_common._inject_general('key: @@test@@'), 'key: value')

    def test_stash_extra_groups_stay_before_next_section_comment(self):
        lines = ['proxy-groups:', '  - name: Anchor', '    type: select', '    proxies: [DIRECT]', '',
                 '# Rule Provider documentation', 'rule-providers:', '  foo: {}', 'rules:', '  - MATCH,DIRECT']
        overlay = {'extra_pool_groups': [
            {'name': 'Added', 'insert_after': 'Anchor', 'type': 'fallback', 'filter': 'UK'}]}
        result = stash._stash_apply_overlay(lines, overlay, 'test')
        text = '\n'.join(result)
        self.assertLess(text.index('name: "'), text.index('# Rule Provider documentation'))


class StashGeneralUpstreamTests(unittest.TestCase):
    """Exercise the General include and both generators against isolated inputs."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        scripts = self.root / '.github/scripts'
        enhanced = scripts / 'sync-config/Enhanced'
        enhanced.mkdir(parents=True)
        self.general = self.root / 'Clash/General.yaml'
        self.general.parent.mkdir()
        self.sync_config = scripts / 'sync-config.txt'
        self.sync_config.write_text('''# Clash
>> Clash/Sample.yaml
# > Builtin
<< .github/scripts/sync-config/clash.ini
# > Gist
ReverseProxy => fastly.jsdelivr.net
# > Mapping
LAN => https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/lancidr.mrs

# Stash
>> Clash/Script/Stash.stoverride
''', encoding='utf-8')
        self.ini = scripts / 'sync-config/clash.ini'
        self.ini.write_text('<< Clash/General.yaml\n', encoding='utf-8')
        self.overlay = enhanced / 'MyStash.overlay.json'
        self.overlay.write_text(json.dumps({
            'output': 'Clash/Script/MyStash.js',
            'stash_output': 'Clash/Script/MyStash.stoverride',
            'group_overrides': {'Proxy': {'type': 'url-test', 'interval': 456}},
        }), encoding='utf-8')
        self.lan_source = self.root / 'Surge/RULE-SET/LAN.list'
        self.lan_source.parent.mkdir(parents=True)
        self.lan_source.write_text('''# Canonical LAN fixture
DOMAIN-SUFFIX,local
IP-CIDR,10.0.0.0/8,no-resolve
IP-CIDR6,fc00::/7,no-resolve
''', encoding='utf-8')
        self.lan_asset = self.root / 'Clash/RuleSet/lancidr.txt'
        self.lan_asset.parent.mkdir()
        self.lan_asset.write_text("payload:\n  - '10.0.0.0/8'\n  - 'fc00::/7'\n", encoding='utf-8')
        # URL versioning treats a compiled binary as opaque bytes; no CLI or download is needed.
        self.lan_mrs = self.lan_asset.with_suffix('.mrs')
        self.lan_mrs.write_bytes(b'compiled LAN fixture v1')
        self.inputs = (self.general, self.sync_config, self.ini, self.overlay,
                       self.lan_source, self.lan_asset, self.lan_mrs)
        self.outputs = {
            'Sample': 'Clash/Sample.yaml',
            'Mihomo': 'Clash/Mihomo.yaml',
            'Stash': 'Clash/Script/Stash.stoverride',
            'MyStash': 'Clash/Script/MyStash.stoverride',
        }
        self.script_outputs = {
            'Script': 'Clash/Script/Script.js',
            'MyScript': 'Clash/Script/MyStash.js',
        }
        self.git('init', '-q')
        self.lan_revision = self.commit('Publish initial compiled LAN')

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.root, check=True,
                              capture_output=True, text=True).stdout.strip()

    def commit(self, title):
        self.git('add', '.')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                 'commit', '-qm', title)
        return self.git('rev-parse', 'HEAD')

    def generate(self):
        before = {path: path.read_bytes() for path in self.inputs}
        with contextlib.ExitStack() as stack:
            for module in (parser, config_common, clash, stash):
                stack.enter_context(patch.object(module, 'REPO_ROOT', self.root))
            for module in (parser, config_common):
                stack.enter_context(patch.object(module, 'SYNC_CONFIG_TXT', self.sync_config))
            stack.enter_context(patch.dict(config_common._GENERAL_INJECT, {
                '@@PROXY_TEST_URL@@': 'https://probe.example.invalid/generate_204',
            }, clear=True))
            stack.enter_context(patch.object(parser.urllib.request, 'urlopen',
                side_effect=AssertionError('General synchronization must stay offline')))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            config = parser.parse_sync_txt()
            self.assertEqual(config['Clash']['include_file'], 'Clash/General.yaml')
            clash._sync_clash(config, ['DIRECT = direct'], ['Proxy = select, DIRECT'], [
                'RULE-SET,LAN,DIRECT,no-resolve',
                # A static URL creates a provider mapping; no provider is downloaded.
                'RULE-SET,https://raw.githubusercontent.com/HotKids/Rules/master/Surge/RULE-SET/Upstream.list,Proxy',
                'FINAL,Proxy',
            ])
            sample = self.root / self.outputs['Sample']
            sample_bytes = sample.read_bytes()
            stash._sync_stash(config, [])
            self.assertEqual(sample.read_bytes(), sample_bytes)
        self.assertEqual({path: path.read_bytes() for path in self.inputs}, before)
        outputs = {name: yaml.safe_load((self.root / path).read_text(encoding='utf-8'))
                   for name, path in self.outputs.items()}
        outputs.update({name: self.run_script(path) for name, path in self.script_outputs.items()})
        return outputs

    def run_script(self, path):
        runner = '''const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(process.argv[1], 'utf8');
const context = {config: JSON.parse(fs.readFileSync(0, 'utf8'))};
vm.runInNewContext(source + '\\nresult = main(config);', context);
process.stdout.write(JSON.stringify(context.result));
'''
        subscription = {
            'proxies': [{'name': 'Fixture', 'type': 'socks5',
                         'server': 'node.example.invalid', 'port': 1080}],
            'hosts': {},
            'dns': {},
        }
        result = subprocess.run(['node', '-e', runner, str(self.root / path)],
                                input=json.dumps(subscription), text=True, check=True,
                                capture_output=True)
        return json.loads(result.stdout)

    def generated_bytes(self):
        return {path.relative_to(self.root): path.read_bytes()
                for path in self.root.rglob('*') if path.is_file() and path not in self.inputs
                and '.git' not in path.relative_to(self.root).parts}

    def assert_lan_providers(self, outputs):
        paths = {}
        for name, output in outputs.items():
            with self.subTest(output=name):
                self.assertIn('RULE-SET,LAN,DIRECT,no-resolve', output['rules'])
                provider = output['rule-providers']['LAN']
                self.assertEqual(provider['url'],
                    f'https://fastly.jsdelivr.net/gh/HotKids/Rules@{self.lan_revision}/Clash/RuleSet/lancidr.mrs')
                self.assertEqual(provider['behavior'], 'ipcidr')
                self.assertEqual(provider['format'], 'mrs')
                self.assertTrue(provider['path'].startswith('./Provider/RuleSet/'))
                self.assertEqual(Path(provider['path']).suffix, '.mrs')
                self.assertRegex(Path(provider['path']).stem, r'[0-9a-f]{8,64}')
                paths[name] = provider['path']
                with patch.object(config_common, 'REPO_ROOT', self.root):
                    self.assertEqual(config_common._lan_cache_filename(provider['url'], 'LAN.mrs'),
                                     Path(provider['path']).name)
                self.assertEqual(output['rule-providers']['Upstream']['url'],
                    'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Upstream.yaml')
                self.assertEqual(output['rule-providers']['Upstream']['path'],
                                 './Provider/RuleSet/Upstream.yaml')
        self.assertEqual(len(set(paths.values())), 1)
        return paths

    def test_lan_download_mapping_and_cache_version_follow_effective_ip_rules(self):
        self.general.write_text('''mixed-port: 7890
mode: rule
log-level: info
hosts: {}
dns:
  nameserver:
    - "https://192.0.2.53/dns-query#RULES"
''', encoding='utf-8')
        first = self.generate()
        first_paths = self.assert_lan_providers(first)
        first_bytes = self.generated_bytes()

        self.lan_source.write_text(self.lan_source.read_text(encoding='utf-8').replace(
            '# Canonical LAN fixture', '# Canonical LAN fixture with updated documentation')
            + '# Extra annotation, no effective rule change\n', encoding='utf-8')
        self.lan_asset.write_text('# Updated asset annotation\n'
                                  + self.lan_asset.read_text(encoding='utf-8'), encoding='utf-8')
        self.commit('Update LAN documentation without recompiling the binary')
        comment_only = self.generate()
        self.assertEqual(self.assert_lan_providers(comment_only), first_paths)
        self.assertEqual(self.generated_bytes(), first_bytes)

        self.lan_source.write_text(self.lan_source.read_text(encoding='utf-8')
                                  + 'IP-CIDR,172.16.0.0/12,no-resolve\n', encoding='utf-8')
        self.lan_asset.write_text(self.lan_asset.read_text(encoding='utf-8')
                                 + "  - '172.16.0.0/12'\n", encoding='utf-8')
        self.lan_mrs.write_bytes(b'compiled LAN fixture v2: includes 172.16.0.0/12')
        self.lan_revision = self.commit('Publish recompiled LAN after upstream CIDR change')
        changed = self.generate()
        changed_paths = self.assert_lan_providers(changed)
        for name in first_paths:
            self.assertNotEqual(changed_paths[name], first_paths[name], name)
            self.assertNotEqual(changed[name]['rule-providers']['LAN']['url'],
                                first[name]['rule-providers']['LAN']['url'], name)
            for key in ('url', 'path'):
                self.assertEqual(changed[name]['rule-providers']['Upstream'][key],
                                 first[name]['rule-providers']['Upstream'][key])
        changed_bytes = self.generated_bytes()
        self.generate()
        self.assertEqual(self.generated_bytes(), changed_bytes)

    def test_unpublished_lan_artifact_stops_generation_without_publishing_old_urls(self):
        self.general.write_text('mode: rule\ndns:\n  nameserver: [192.0.2.53]\n', encoding='utf-8')
        self.generate()
        before = self.generated_bytes()
        self.lan_mrs.write_bytes(b'recompiled but not published')
        with self.assertRaisesRegex(RuntimeError, '请先编译并提交规则产物'):
            self.generate()
        self.assertEqual(self.generated_bytes(), before)

    def test_fastly_lan_requires_a_published_asset_but_other_providers_stay_offline(self):
        with patch.object(config_common, 'REPO_ROOT', self.root):
            other = 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Upstream.yaml'
            self.assertEqual(config_common._pin_lan_fastly_urls(other), other)
            with self.assertRaisesRegex(RuntimeError, 'LAN.yaml'):
                config_common._pin_lan_fastly_urls(
                    'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/LAN.yaml')

    def test_general_edits_and_deletions_reach_every_config_and_keep_private_groups(self):
        class GeneralDumper(yaml.SafeDumper):
            def increase_indent(self, flow=False, indentless=False):
                return super().increase_indent(flow, indentless=False)

        generations = [
            ({
                'mixed-port': 7890,
                'mode': 'rule',
                'log-level': 'info',
                'hosts': {'old.example.invalid': '192.0.2.10',
                          'shared.example.invalid': '192.0.2.11'},
                'proxy-hosts': {'old-node.example.invalid': '192.0.2.20',
                                'shared-node.example.invalid': '192.0.2.21'},
                'keep-alive-idle': 27,
                'dns': {
                    'enable': True,
                    'respect-rules': False,
                    'default-nameserver': ['192.0.2.53'],
                    'nameserver': ['https://192.0.2.54/dns-query#RULES'],
                    'fallback': ['https://192.0.2.58/dns-query#RULES'],
                    'nameserver-policy': {
                        'old.example.invalid,alias.example.invalid': ['https://192.0.2.55/dns-query#RULES&h3=true'],
                        'shared.example.invalid': ['192.0.2.56'],
                    },
                    'proxy-server-nameserver': ['https://192.0.2.57/dns-query#RULES'],
                    'fake-ip-filter': ['+.lan', '*.old.example.invalid'],
                },
            }, {
                'follow-rule': True,
                'default-nameserver': ['192.0.2.53'],
                'nameserver': ['https://192.0.2.54/dns-query'],
                'nameserver-policy': {
                    'old.example.invalid': ['https://192.0.2.55/dns-query#h3=true'],
                    'alias.example.invalid': ['https://192.0.2.55/dns-query#h3=true'],
                    'shared.example.invalid': ['192.0.2.56'],
                },
                'proxy-server-nameserver': ['https://192.0.2.57/dns-query'],
                'fake-ip-filter': ['+.lan', '*.old.example.invalid'],
            }),
            ({
                'mixed-port': 7890,
                'mode': 'global',
                'log-level': 'warning',
                'hosts': {'shared.example.invalid': '198.51.100.11',
                          'new.example.invalid': '198.51.100.12'},
                'proxy-hosts': {'shared-node.example.invalid': '198.51.100.21',
                                'new-node.example.invalid': '198.51.100.22'},
                'dns': {
                    'enable': True,
                    'respect-rules': False,
                    'default-nameserver': ['198.51.100.53', '203.0.113.53'],
                    'nameserver': ['https://198.51.100.54/dns-query#h3=true',
                                   'tls://203.0.113.54'],
                    'fallback': ['https://198.51.100.58/dns-query#RULES'],
                    'nameserver-policy': {
                        'shared.example.invalid': ['https://198.51.100.55/dns-query'],
                        'new.example.invalid': 'system',
                    },
                    'proxy-server-nameserver': ['https://198.51.100.57/dns-query'],
                },
            }, {
                'follow-rule': False,
                'default-nameserver': ['198.51.100.53', '203.0.113.53'],
                'nameserver': ['https://198.51.100.54/dns-query#h3=true',
                               'tls://203.0.113.54'],
                'nameserver-policy': {
                    'shared.example.invalid': ['https://198.51.100.55/dns-query'],
                    'new.example.invalid': 'system',
                },
                'proxy-server-nameserver': ['https://198.51.100.57/dns-query'],
            }),
        ]
        for style, dumper in (('indented', GeneralDumper), ('indentless', yaml.SafeDumper)):
            for revision, (general, stash_dns) in enumerate(generations, 1):
                with self.subTest(style=style, revision=revision):
                    self.general.write_text('# Upstream General fixture\n' + yaml.dump(
                        general, Dumper=dumper, sort_keys=False), encoding='utf-8')
                    outputs = self.generate()
                    for name, output in outputs.items():
                        with self.subTest(output=name):
                            for key in ('mode', 'log-level', 'hosts', 'proxy-hosts'):
                                self.assertEqual(output[key], general[key], key)
                            mihomo_outputs = ('Sample', 'Mihomo', 'Script', 'MyScript')
                            expected_dns = general['dns'] if name in mihomo_outputs else stash_dns
                            self.assertEqual(output['dns'], expected_dns)
                            if name in mihomo_outputs:
                                if revision == 1:
                                    self.assertEqual(output['keep-alive-idle'], general['keep-alive-idle'])
                                else:
                                    self.assertNotIn('keep-alive-idle', output)
                            self.assertEqual(output['rules'][-1], 'MATCH,Proxy')
                            group = next(g for g in output['proxy-groups'] if g['name'] == 'Proxy')
                            private = name in ('MyStash', 'MyScript')
                            self.assertEqual(group['type'], 'url-test' if private else 'select')
                            self.assertEqual(group['proxies'], ['DIRECT'])
                            if private:
                                self.assertEqual(group['interval'], 456)
                            if name in ('Stash', 'MyStash'):
                                self.assertNotIn('fallback', output['dns'])
                            if revision == 2:
                                self.assertNotIn('fake-ip-filter', output['dns'])
                                self.assertNotIn('old.example.invalid', output['hosts'])
                                self.assertNotIn('old-node.example.invalid', output['proxy-hosts'])
                                self.assertNotIn('old.example.invalid', output['dns']['nameserver-policy'])
                    for name in ('Stash', 'MyStash'):
                        text = (self.root / self.outputs[name]).read_text(encoding='utf-8')
                        self.assertNotIn('#RULES', text)
                        self.assertNotIn('&RULES', text)
                    once = self.generated_bytes()
                    self.generate()
                    self.assertEqual(self.generated_bytes(), once)


class StashConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / 'Clash/Sample.yaml'
        self.source.parent.mkdir()
        self.source.write_text('''# Clash
# Date: fixture

mixed-port: 7890

dns:
  enable: true
  # 各条目通过 #RULES / #策略名 后缀单独指定出站
  respect-rules: false
  # 引导 DNS：仅用于解析 nameserver 服务器的域名
  # 只能填纯 IP 地址
  default-nameserver:
    - 192.0.2.53
    - 198.51.100.53
  fake-ip-filter:
    - "+.lan"
    - "*.example.invalid"
  # 主 DNS：经代理查询干净结果，防止境外域名请求泄露至国内 DNS 服务商
  nameserver:
    - "https://1.1.1.1/dns-query#RULES"
  nameserver-policy:
    "geosite:private":
      - system
    "geosite:cn":
      - https://doh.pub/dns-query
      - https://dns.alidns.com/dns-query
    "example.invalid":
      - "https://resolver.example.invalid/dns-query#h3=true"
  proxy-server-nameserver:
    - "https://nodes.example.invalid/dns-query"

proxy-groups:
  - name: Proxy
    type: select
    proxies: [DIRECT]

rules:
  - MATCH,Proxy
''', encoding='utf-8')
        self.input_bytes = self.source.read_bytes()
        self.input_dns = yaml.safe_load(self.input_bytes)['dns']
        self.config = {'Clash': {'output': 'Clash/Sample.yaml'},
                       'Stash': {'output': 'Clash/Stash.stoverride'}}

    def generate(self, general_lines=()):
        with patch.object(stash, 'REPO_ROOT', self.root), \
                contextlib.redirect_stdout(io.StringIO()):
            stash._sync_stash(self.config, general_lines)
        self.assertEqual(self.source.read_bytes(), self.input_bytes)
        path = self.root / self.config['Stash']['output']
        return path.read_text(encoding='utf-8'), yaml.safe_load(path.read_text(encoding='utf-8'))

    def replace_source(self, old, new):
        text = self.source.read_text(encoding='utf-8')
        self.assertIn(old, text)
        self.source.write_text(text.replace(old, new), encoding='utf-8')
        self.input_bytes = self.source.read_bytes()
        self.input_dns = yaml.safe_load(self.input_bytes)['dns']

    def assert_aligned_dns(self, dns):
        self.assertIs(dns['follow-rule'], True)
        self.assertEqual(dns['nameserver'], ['https://1.1.1.1/dns-query'])
        self.assertNotIn('respect-rules', dns)
        for key in ('default-nameserver', 'nameserver-policy',
                    'proxy-server-nameserver', 'fake-ip-filter'):
            self.assertEqual(dns[key], self.input_dns[key], key)

    def test_source_rules_dns_keeps_cloudflare_and_supported_values(self):
        text, output = self.generate()
        self.assert_aligned_dns(output['dns'])
        self.assertNotIn('#RULES', text)
        self.assertIn('经代理查询干净结果', text)
        self.assertIn('除 system 外，服务器地址使用 IP；支持基于 IP 的加密 DNS', text)
        self.assertNotIn('只能填纯 IP 地址', text)
        generated_bytes = (self.root / 'Clash/Stash.stoverride').read_bytes()
        self.generate()
        self.assertEqual((self.root / 'Clash/Stash.stoverride').read_bytes(), generated_bytes)

    def test_unrouted_source_keeps_its_nameservers_and_disables_rule_following(self):
        self.replace_source('"https://1.1.1.1/dns-query#RULES"',
                            '"https://resolver.example.invalid/dns-query#h3=true"\n'
                            '    - "https://dns.alidns.com/dns-query"')
        _, output = self.generate()
        self.assertIs(output['dns']['follow-rule'], False)
        self.assertEqual(output['dns']['nameserver'], self.input_dns['nameserver'])

    def test_respect_rules_requests_rule_following_without_a_server_selector(self):
        self.replace_source('respect-rules: false', 'respect-rules: true')
        self.replace_source('https://1.1.1.1/dns-query#RULES', 'https://1.1.1.1/dns-query')
        _, output = self.generate()
        self.assert_aligned_dns(output['dns'])

    def test_policy_rules_selector_requests_rule_following(self):
        self.replace_source('https://1.1.1.1/dns-query#RULES', 'https://1.1.1.1/dns-query')
        self.replace_source('https://resolver.example.invalid/dns-query#h3=true',
                            'https://resolver.example.invalid/dns-query#h3=true&RULES')
        _, output = self.generate()
        self.assertIs(output['dns']['follow-rule'], True)
        self.assertEqual(output['dns']['nameserver-policy']['example.invalid'],
                         ['https://resolver.example.invalid/dns-query#h3=true'])

    def test_independent_and_unsupported_dns_selectors_do_not_enable_rule_following(self):
        self.replace_source('https://1.1.1.1/dns-query#RULES', 'https://1.1.1.1/dns-query')
        self.replace_source('    - 192.0.2.53',
                            '    - "https://192.0.2.53/dns-query#RULES"')
        self.replace_source('https://nodes.example.invalid/dns-query',
                            'https://nodes.example.invalid/dns-query#RULES&h3=true')
        self.replace_source('\nproxy-groups:', '''
  direct-nameserver:
    - "https://direct.example.invalid/dns-query#RULES"
  direct-nameserver-follow-policy: true
  fallback:
    - "https://fallback.example.invalid/dns-query#RULES"

proxy-groups:''')
        text, output = self.generate()
        dns = output['dns']
        self.assertIs(dns['follow-rule'], False)
        self.assertEqual(dns['default-nameserver'],
                         ['https://192.0.2.53/dns-query', '198.51.100.53'])
        self.assertEqual(dns['proxy-server-nameserver'],
                         ['https://nodes.example.invalid/dns-query#h3=true'])
        self.assertNotIn('#RULES', text)
        for key in ('direct-nameserver', 'direct-nameserver-follow-policy', 'fallback'):
            self.assertNotIn(key, dns)

    def test_policy_cleanup_preserves_indent_comments_and_supported_url_options(self):
        self.replace_source('    "example.invalid":\n'
                            '      - "https://resolver.example.invalid/dns-query#h3=true"', '''    "example.invalid":
      - "https://resolver.example.invalid/dns-query#RULES&h3=true" # list comment
      - 'https://named.example.invalid/dns-query#Proxy Group' # named selector
    "scalar.invalid": "https://scalar.example.invalid/dns-query#RULES" # scalar comment
    "time.*.com,ntp.*.com": # shared comment
      # resolver comment
      - "https://time.example.invalid/dns-query#RULES&h3=true" # time comment
      - 223.5.5.5
    "first.invalid,second.invalid": ['https://inline.example.invalid/dns-query#Proxy', 'https://h3.example.invalid/dns-query#h3=true&RULES'] # inline comment''')
        text, output = self.generate()
        policy = output['dns']['nameserver-policy']
        self.assertEqual(policy['example.invalid'],
                         ['https://resolver.example.invalid/dns-query#h3=true',
                          'https://named.example.invalid/dns-query'])
        self.assertEqual(policy['scalar.invalid'], 'https://scalar.example.invalid/dns-query')
        for name in ('time.*.com', 'ntp.*.com'):
            self.assertEqual(policy[name], ['https://time.example.invalid/dns-query#h3=true',
                                           '223.5.5.5'])
            self.assertIn('    "' + name + '": # shared comment\n'
                          '      # resolver comment\n'
                          '      - "https://time.example.invalid/dns-query#h3=true" # time comment',
                          text)
        for name in ('first.invalid', 'second.invalid'):
            self.assertEqual(policy[name], ['https://inline.example.invalid/dns-query',
                                           'https://h3.example.invalid/dns-query#h3=true'])
            self.assertIn('    "' + name + '": [\'https://inline.example.invalid/dns-query\', '
                          '\'https://h3.example.invalid/dns-query#h3=true\'] # inline comment', text)
        self.assertIn('      - "https://resolver.example.invalid/dns-query#h3=true" # list comment', text)
        self.assertIn("      - 'https://named.example.invalid/dns-query' # named selector", text)
        self.assertIn('    "scalar.invalid": "https://scalar.example.invalid/dns-query" # scalar comment', text)
        self.assertNotIn('#RULES', text)
        self.assertNotIn('&RULES', text)

    def test_inline_source_nameservers_are_cleaned_without_losing_comments(self):
        self.replace_source('  nameserver:\n    - "https://1.1.1.1/dns-query#RULES"',
                            '  nameserver: ["https://1.1.1.1/dns-query#RULES"] # main comment')
        text, output = self.generate()
        self.assert_aligned_dns(output['dns'])
        self.assertIn('  nameserver: ["https://1.1.1.1/dns-query"] # main comment', text)

    def test_bare_ip_rule_selectors_are_cleaned_without_changing_domain_filters(self):
        self.replace_source('https://1.1.1.1/dns-query#RULES',
                            'https://1.1.1.1/dns-query')
        self.replace_source('    - "*.example.invalid"',
                            '    - "*.example.invalid"\n'
                            '    - "223.5.5.5#RULES"')
        self.replace_source('    "example.invalid":',
                            '    "198.51.100.53#RULES": system\n'
                            '    "example.invalid":')
        _, output = self.generate()
        self.assertIs(output['dns']['follow-rule'], False)
        self.assertEqual(output['dns']['fake-ip-filter'], self.input_dns['fake-ip-filter'])
        self.assertIn('198.51.100.53#RULES', output['dns']['nameserver-policy'])

        servers = ('223.5.5.5', '223.5.5.5:5353',
                   '2001:db8::53', '[2001:db8::53]:5353')
        for server in servers:
            with self.subTest(server=server):
                original = self.source.read_bytes()
                self.replace_source('"https://1.1.1.1/dns-query"',
                                    '"' + server + '#RULES" # bare IP comment')
                text, output = self.generate()
                self.assertIs(output['dns']['follow-rule'], True)
                self.assertEqual(output['dns']['nameserver'], [server])
                self.assertIn('    - "' + server + '" # bare IP comment', text)
                self.assertEqual(output['dns']['fake-ip-filter'], self.input_dns['fake-ip-filter'])
                self.assertIn('198.51.100.53#RULES', output['dns']['nameserver-policy'])
                self.source.write_bytes(original)
                self.input_bytes = original
                self.input_dns = yaml.safe_load(original)['dns']

    def test_private_overlay_inherits_the_same_dns_without_changing_sample(self):
        directory = self.root / '.github/scripts/sync-config/Enhanced'
        directory.mkdir(parents=True)
        (directory / 'MyStash.overlay.json').write_text(json.dumps({
            'stash_output': 'Clash/MyStash.stoverride',
            'group_overrides': {'Proxy': {'type': 'url-test'}},
        }), encoding='utf-8')
        _, output = self.generate()
        private = yaml.safe_load((self.root / 'Clash/MyStash.stoverride').read_text(encoding='utf-8'))
        self.assertEqual(private['dns'], output['dns'])
        self.assert_aligned_dns(private['dns'])
        self.assertEqual(private['name'], 'MyStash')
        self.assertEqual(private['proxy-groups'][0]['type'], 'url-test')
        self.assertEqual(self.source.read_bytes(), self.input_bytes)

    def test_regeneration_removes_previously_synced_ca_from_both_stash_outputs(self):
        directory = self.root / '.github/scripts/sync-config/Enhanced'
        directory.mkdir(parents=True)
        (directory / 'MyStash.overlay.json').write_text(json.dumps({
            'stash_output': 'Clash/MyStash.stoverride',
            'group_overrides': {'Proxy': {'type': 'url-test'}},
        }), encoding='utf-8')
        for name in ('Stash', 'MyStash'):
            (self.root / f'Clash/{name}.stoverride').write_text(
                'http:\n  ca: old-fixture\n  ca-passphrase: old-password\n')
        general = ['force-http-engine-hosts = api.example.invalid']
        text, output = self.generate(general)
        private_path = self.root / 'Clash/MyStash.stoverride'
        private = yaml.safe_load(private_path.read_text(encoding='utf-8'))
        for result in (output, private):
            self.assertEqual(result['http'], {'force-http-engine': ['api.example.invalid']})
        self.assertEqual(private['proxy-groups'][0]['type'], 'url-test')
        once = private_path.read_bytes()
        text_again, _ = self.generate(general)
        self.assertEqual(text_again, text)
        self.assertEqual(private_path.read_bytes(), once)

    def test_http_engine_sync_preserves_source_http_fields_and_following_comments(self):
        self.replace_source('\nproxy-groups:', '''
http:
  mitm: ['*.example.invalid']
  ca: old-fixture
  ca-passphrase: old-password
  script:
    - name: existing-script
      type: request

# Proxy groups documentation
proxy-groups:''')
        text, output = self.generate(['force-http-engine-hosts = api.example.invalid'])
        self.assertEqual(output['http'], {
            'force-http-engine': ['api.example.invalid'],
            'ca': 'old-fixture', 'ca-passphrase': 'old-password',
            'mitm': ['*.example.invalid'],
            'script': [{'name': 'existing-script', 'type': 'request'}],
        })
        self.assertEqual(text.count('\nhttp:'), 1)
        self.assertIn('# Proxy groups documentation\nproxy-groups:', text)
        self.assertNotIn('http: #!replace', text)

    def test_http_engine_follows_only_active_template_values_in_both_overrides(self):
        directory = self.root / '.github/scripts/sync-config/Enhanced'
        directory.mkdir(parents=True)
        (directory / 'MyStash.overlay.json').write_text(json.dumps({
            'stash_output': 'Clash/MyStash.stoverride',
        }), encoding='utf-8')
        for general, expected in (
            (['force-http-engine-hosts = *.example.invalid, api.example.invalid:8080, *.example.invalid'],
             ['*.example.invalid', 'api.example.invalid:8080']),
            (['force-http-engine-hosts = replacement.invalid'], ['replacement.invalid']),
            (['# force-http-engine-hosts = disabled.invalid',
              '// force-http-engine-hosts = disabled.invalid'], None),
            ([], None),
        ):
            _, public = self.generate(general)
            private = yaml.safe_load((self.root / 'Clash/MyStash.stoverride').read_text())
            for output in (public, private):
                if expected:
                    self.assertEqual(output['http'], {'force-http-engine': expected})
                    self.assertLess(list(output).index('http'), list(output).index('dns'))
                    self.assertLess(list(output).index('http'), list(output).index('rules'))
                else:
                    self.assertNotIn('http', output)


if __name__ == '__main__': unittest.main()
