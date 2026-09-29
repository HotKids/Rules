"""Offline regression tests: no upstream downloads or user state changes."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

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


if __name__ == '__main__': unittest.main()
