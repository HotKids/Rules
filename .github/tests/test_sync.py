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
from config_sync import parser, common as config_common, stash


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


class StashDNSTests(unittest.TestCase):
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

    def generate(self):
        with patch.object(stash, 'REPO_ROOT', self.root), \
                contextlib.redirect_stdout(io.StringIO()):
            stash._sync_stash(self.config)
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


if __name__ == '__main__': unittest.main()
