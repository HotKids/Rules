"""Streaming recovery uses committed inputs, never the most recent push alone."""
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


SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import _common


def load_generator():
    spec = importlib.util.spec_from_file_location('streaming_recovery_fixture', SCRIPTS / 'sync-rules.py')
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    return generator


class StreamingRecoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.r = load_generator()
        self.r.REPO_ROOT = self.root
        self.r.SURGE_DIR = self.root / 'Surge/RULE-SET'
        self.r.SURGE_DIR.mkdir(parents=True)
        self.r.MERGE_SECTION_TO_FILE = {}
        self.write('Alpha', '# > Alpha\n### Streaming\nDOMAIN,alpha.example\n')
        self.write('Beta', '# > Beta\n### Streaming US\nDOMAIN,beta.example\n')
        self.write('Streaming_US', '# > Beta\nDOMAIN,beta.example\n')
        self.write('Streaming', '# > Alpha\nDOMAIN,alpha.example\n\n# > Beta\nDOMAIN,beta.example\n')
        self.git('init', '-q')
        self.baseline = self.commit('coherent baseline')

    def path(self, name):
        return self.r.SURGE_DIR / (name + '.list')

    def write(self, name, content):
        self.path(name).write_text(content, encoding='utf-8')

    def replace(self, name, before, after):
        path = self.path(name)
        path.write_text(path.read_text().replace(before, after), encoding='utf-8')

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.root, check=True,
                              capture_output=True, text=True).stdout.strip()

    def commit(self, title):
        self.git('add', '.')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', title)
        return self.git('rev-parse', 'HEAD')

    def snapshot(self):
        return {p.name: p.read_bytes() for p in self.r.SURGE_DIR.glob('*.list')}

    def event(self, base):
        return patch.dict(os.environ, {'SYNC_EVENT_NAME': 'push', 'SYNC_BASE_SHA': base,
                                      'SYNC_EVENT_SHA': self.git('rev-parse', 'HEAD')})

    def run_sync(self, base):
        with self.event(base), contextlib.redirect_stdout(io.StringIO()):
            self.r.sync_streaming()

    def fail_original_run(self, aggregate):
        old, new = ('alpha.example', 'pending.example') if aggregate == 'Streaming' else ('beta.example', 'pending.example')
        self.replace(aggregate, old, new)
        failed_sha = self.commit('A edits aggregate')
        before = self.snapshot()
        rules = {'surge': [], 'surge_domainset': [], 'clash': [], 'module': []}
        with self.event(self.baseline), patch.object(self.r, 'parse_sync_rules', return_value=rules), \
                patch.object(self.r, 'prefetch_urls', side_effect=RuntimeError('upstream unavailable')), \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, 'upstream unavailable'):
                self.r.main()
        self.assertEqual(before, self.snapshot())
        return failed_sha

    def assert_pending_preserved(self, aggregate, later_member):
        failed_sha = self.fail_original_run(aggregate)
        if later_member:
            self.replace('Alpha', 'alpha.example', 'later.example')
        else:
            self.write('Unrelated', 'DOMAIN,unrelated.example\n')
        self.commit('B edits member' if later_member else 'B edits unrelated rule')
        before = self.snapshot()
        with self.event(failed_sha), patch.object(self.r, 'prefetch_urls') as downloads, \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError, '基准中已有未完成'):
                self.r.main()
        downloads.assert_not_called()
        self.assertEqual(before, self.snapshot())

    def test_later_unrelated_push_preserves_failed_total_edit(self):
        self.assert_pending_preserved('Streaming', False)

    def test_later_member_push_preserves_failed_total_edit(self):
        self.assert_pending_preserved('Streaming', True)

    def test_later_unrelated_push_preserves_failed_regional_edit(self):
        self.assert_pending_preserved('Streaming_US', False)

    def test_later_member_push_preserves_failed_regional_edit(self):
        self.assert_pending_preserved('Streaming_US', True)

    def test_normal_total_edit_is_applied(self):
        self.replace('Streaming', 'alpha.example', 'edited.example')
        self.commit('edit total')
        self.run_sync(self.baseline)
        self.assertIn('edited.example', self.path('Alpha').read_text())
        self.assertIn('### Streaming\n', self.path('Alpha').read_text())

    def test_normal_regional_edit_is_applied(self):
        self.replace('Streaming_US', 'beta.example', 'edited.example')
        self.commit('edit regional')
        self.run_sync(self.baseline)
        self.assertIn('edited.example', self.path('Beta').read_text())
        self.assertIn('edited.example', self.path('Streaming').read_text())

    def test_normal_member_edit_rebuilds_aggregates(self):
        self.replace('Beta', 'beta.example', 'edited.example')
        self.commit('edit member')
        self.run_sync(self.baseline)
        self.assertIn('edited.example', self.path('Streaming').read_text())
        self.assertIn('edited.example', self.path('Streaming_US').read_text())

    def test_normal_member_deletion_is_not_mistaken_for_failed_prior_edit(self):
        self.path('Alpha').unlink()
        self.commit('delete member')
        self.run_sync(self.baseline)
        self.assertNotIn('Alpha', self.path('Streaming').read_text())

    def test_normal_member_rename_is_not_mistaken_for_failed_prior_edit(self):
        self.path('Alpha').rename(self.path('Renamed'))
        self.commit('rename member')
        self.run_sync(self.baseline)
        self.assertIn('alpha.example', self.path('Streaming').read_text())
        self.assertFalse(self.path('Alpha').exists())

    def test_normal_region_change_uses_base_membership_for_comparison(self):
        self.replace('Beta', '### Streaming US', '### Streaming')
        self.commit('change region marker')
        self.run_sync(self.baseline)
        self.assertIn('beta.example', self.path('Streaming').read_text())

    def test_already_reconciled_head_is_safe_even_if_base_was_pending(self):
        failed_sha = self.fail_original_run('Streaming')
        self.replace('Alpha', 'alpha.example', 'pending.example')
        self.commit('reconcile both sides')
        before = self.snapshot()
        self.run_sync(failed_sha)
        self.assertEqual(before, self.snapshot())


class RulesBatchTests(unittest.TestCase):
    def setUp(self):
        self.r = load_generator()
        self.rules = {'surge': [{'url': 'https://example.invalid/rule'}],
                      'surge_domainset': [], 'clash': [],
                      'module': [{'url': 'https://example.invalid/module'}]}

    def test_parse_once_and_share_one_rule_module_download_batch(self):
        events = []
        batch = {'https://example.invalid/rule': 'rule text',
                 'https://example.invalid/module': 'module text'}
        def fetch(urls, *_args, **kwargs):
            self.assertEqual(set(urls), set(batch))
            self.assertTrue(kwargs['encode'])
            events.append('download')
            return batch
        def stage(name):
            def apply(rules, prefetched):
                self.assertIs(rules, self.rules)
                self.assertIs(prefetched, batch)
                events.append(name)
            return apply
        with patch.object(self.r, '_check_idle_streaming'), \
                patch.object(self.r, 'parse_sync_rules', return_value=self.rules) as parse, \
                patch.object(self.r, 'prefetch_urls', side_effect=fetch) as download, \
                patch.object(self.r, 'fetch_external_rules', side_effect=stage('rules')), \
                patch.object(self.r, 'fetch_external_modules', side_effect=stage('modules')), \
                patch.object(self.r, 'sync_streaming') as streaming, \
                patch.object(self.r, 'convert_all') as convert, \
                patch.object(self.r, 'cleanup_stale') as cleanup, contextlib.redirect_stdout(io.StringIO()):
            self.r.main()
        parse.assert_called_once_with()
        download.assert_called_once()
        self.assertEqual(events, ['download', 'rules', 'modules'])
        streaming.assert_called_once_with(prechecked=True)
        convert.assert_called_once_with(self.rules)
        cleanup.assert_called_once_with(self.rules)

    def test_module_download_failure_happens_before_any_rule_or_module_writes(self):
        def fetch(url, *_args, **_kwargs):
            if url.endswith('/module'):
                raise _common.DownloadError(url, 'timeout')
            return 'rule text'
        with patch.object(self.r, '_check_idle_streaming'), \
                patch.object(self.r, 'parse_sync_rules', return_value=self.rules), \
                patch.object(_common, 'fetch_url', side_effect=fetch), \
                patch.object(self.r, 'fetch_external_rules') as rules, \
                patch.object(self.r, 'fetch_external_modules') as modules, \
                patch.object(self.r, 'sync_streaming') as streaming, \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(_common.DownloadBatchError):
                self.r.main()
        rules.assert_not_called()
        modules.assert_not_called()
        streaming.assert_not_called()


if __name__ == '__main__':
    unittest.main()
