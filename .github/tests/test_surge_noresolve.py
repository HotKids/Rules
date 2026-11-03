"""CIDR flags survive source refreshes without changing rule content or layout."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))


class SurgeNoResolveTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('surge_noresolve_fixture', SCRIPTS / 'sync-rules.py')
        self.runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.runner)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.runner.REPO_ROOT = self.root
        self.runner.SURGE_DIR = self.root / 'Surge/RULE-SET'
        self.runner.SURGE_DIR.mkdir(parents=True)
        self.rules = {'surge': [], 'surge_domainset': [], 'clash': [], 'module': []}

    def quiet(self, function, *args):
        with contextlib.redirect_stdout(io.StringIO()):
            return function(*args)

    def test_cidr_flags_are_added_before_comments_and_preserve_existing_options(self):
        examples = {
            '  IP-CIDR,192.0.2.0/24\r\n': '  IP-CIDR,192.0.2.0/24,no-resolve\r\n',
            'IP-CIDR6,2001:db8::/32,Proxy,pre-matching  # no-resolve is only a comment':
                'IP-CIDR6,2001:db8::/32,Proxy,pre-matching,no-resolve  # no-resolve is only a comment',
            'IP-CIDR,192.0.2.1/32,REJECT ; note': 'IP-CIDR,192.0.2.1/32,REJECT,no-resolve ; note',
            'IP-CIDR,192.0.2.1/32,   // note': 'IP-CIDR,192.0.2.1/32,no-resolve   // note',
            'IP-CIDR,192.0.2.1/32  #!REQUIREMENT CORE_VERSION>=22':
                'IP-CIDR,192.0.2.1/32,no-resolve  #!REQUIREMENT CORE_VERSION>=22',
        }
        unchanged = [
            'IP-CIDR6,2001:db8::/32,pre-matching,NO-RESOLVE  // note',
            '# IP-CIDR,192.0.2.1/32', '; IP-CIDR6,2001:db8::/32', '// IP-CIDR,192.0.2.0/24',
            'DOMAIN,no-resolve.example', 'GEOIP,CN', 'IP-ASN,13335',
        ]
        for source, expected in [*examples.items(), *((line, line) for line in unchanged)]:
            with self.subTest(source=source):
                self.assertEqual(self.runner.ensure_cidr_no_resolve(source), expected)
                self.assertEqual(self.runner.ensure_cidr_no_resolve(expected), expected)

    def test_quoted_policy_text_is_not_an_option_or_comment(self):
        for policy in ['"foo,no-resolve,bar"', '"Proxy # note; // literal"',
                       '"Proxy ending \\\\"', '"Proxy with \\"quoted\\" text"']:
            source = 'IP-CIDR,192.0.2.1/32,' + policy
            with self.subTest(policy=policy):
                expected = source + ',no-resolve'
                self.assertEqual(self.runner.ensure_cidr_no_resolve(source), expected)
                self.assertEqual(self.runner.ensure_cidr_no_resolve(expected), expected)

    def test_logical_rules_add_flags_only_inside_cidr_leaves(self):
        source = ('AND,((DOMAIN,example.invalid),(OR,((IP-CIDR,192.0.2.0/24),'
                  '(NOT,((IP-CIDR6,2001:db8::/32,no-resolve)))))),"Proxy (IP-CIDR,keep)" // note')
        expected = source.replace('(IP-CIDR,192.0.2.0/24)', '(IP-CIDR,192.0.2.0/24,no-resolve)')
        self.assertEqual(self.runner.ensure_cidr_no_resolve(source), expected)
        self.assertEqual(self.runner.ensure_cidr_no_resolve(expected), expected)

    def test_upstream_refresh_normalizes_missing_flags_before_writing(self):
        url = 'https://example.invalid/ip/reject.conf'
        self.rules['surge'] = [{'url': url, 'name': 'Bogus', 'overrides': {}}]
        source = ('# upstream comment\n# > Bogus\nIP-CIDR,192.0.2.0/24\n'
                  'IP-CIDR6,2001:db8::/32\nIP-CIDR,198.51.100.0/24,no-resolve\n')
        expected = ('### fork from ' + url + '\n# > Bogus\nIP-CIDR,192.0.2.0/24,no-resolve\n'
                    'IP-CIDR6,2001:db8::/32,no-resolve\nIP-CIDR,198.51.100.0/24,no-resolve\n')
        with contextlib.redirect_stdout(io.StringIO()):
            self.runner.fetch_external_rules(self.rules, {url: source})
        target = self.runner.SURGE_DIR / 'Bogus.list'
        self.assertEqual(target.read_text(), expected)
        with contextlib.redirect_stdout(io.StringIO()):
            self.runner.fetch_external_rules(self.rules, {url: source})
        self.assertEqual(target.read_text(), expected)

    def test_local_pass_preserves_bytes_and_does_not_adopt_manual_edits(self):
        manual = self.runner.SURGE_DIR / 'Local.list'
        managed = self.runner.SURGE_DIR / 'Managed.list'
        edited = self.runner.SURGE_DIR / 'Edited.list'
        manual.write_bytes(b'# Keep this exact heading\r\n\r\n  IP-CIDR,192.0.2.0/24 // local')
        original = b'# managed\nIP-CIDR6,2001:db8::/32\n'
        managed.write_bytes(original)
        edited.write_bytes(b'# user changed this\nIP-CIDR,198.51.100.0/24\n')
        managed_name = managed.relative_to(self.root).as_posix()
        edited_name = edited.relative_to(self.root).as_posix()
        old_edited_hash = hashlib.sha256(b'old managed content').hexdigest()
        state = self.root / self.runner.RULE_OWNERS_FILE
        state.parent.mkdir(parents=True)
        state.write_text(json.dumps({'version': 1, 'files': {
            managed_name: hashlib.sha256(original).hexdigest(), edited_name: old_edited_hash,
        }}))
        self.quiet(self.runner.normalize_local_surge_cidrs)
        self.assertEqual(manual.read_bytes(), b'# Keep this exact heading\r\n\r\n  IP-CIDR,192.0.2.0/24,no-resolve // local')
        self.assertEqual(managed.read_bytes(), b'# managed\nIP-CIDR6,2001:db8::/32,no-resolve\n')
        owners = self.runner._rule_owners()
        self.assertEqual(owners[managed_name], hashlib.sha256(managed.read_bytes()).hexdigest())
        self.assertEqual(owners[edited_name], old_edited_hash)
        self.assertNotIn(manual.relative_to(self.root).as_posix(), owners)
        with patch.object(Path, 'write_bytes') as write:
            self.quiet(self.runner.normalize_local_surge_cidrs)
            write.assert_not_called()

    def test_local_pass_rejects_symlinks_without_touching_the_target(self):
        external = self.root / 'outside.list'
        external.write_text('IP-CIDR,192.0.2.0/24\n')
        (self.runner.SURGE_DIR / 'Linked.list').symlink_to(external)
        with self.assertRaisesRegex(ValueError, 'Unsafe Surge rule path'):
            self.runner.normalize_local_surge_cidrs()
        self.assertEqual(external.read_text(), 'IP-CIDR,192.0.2.0/24\n')

    def test_main_normalizes_streaming_results_before_client_conversion(self):
        events = []
        target = self.runner.SURGE_DIR / 'Streaming.list'
        def streaming(**kwargs):
            events.append('streaming')
            target.write_text('# Keep heading\nIP-CIDR,192.0.2.0/24\n')
        def convert(rules):
            events.append('convert')
            self.assertEqual(target.read_text(), '# Keep heading\nIP-CIDR,192.0.2.0/24,no-resolve\n')
        with patch.object(self.runner, '_check_idle_streaming'), \
                patch.object(self.runner, 'parse_sync_rules', return_value=self.rules), \
                patch.object(self.runner, 'prefetch_urls', return_value={}), \
                patch.object(self.runner, 'prepare_qx_modules', return_value=object()), \
                patch.object(self.runner, 'fetch_external_rules'), patch.object(self.runner, 'fetch_external_modules'), \
                patch.object(self.runner, 'sync_streaming', side_effect=streaming), \
                patch.object(self.runner, 'convert_all', side_effect=convert), patch.object(self.runner, 'cleanup_stale'):
            self.quiet(self.runner.main)
        self.assertEqual(events, ['streaming', 'convert'])

    def test_qx_retains_no_resolve_after_other_cidr_options(self):
        source = ['IP-CIDR,192.0.2.0/24,pre-matching', 'IP-CIDR6,2001:db8::/32,pre-matching']
        updated = [self.runner.ensure_cidr_no_resolve(line) for line in source]
        result = self.runner.convert_qx(updated, 'Proxy')
        self.assertEqual(result, 'IP-CIDR,192.0.2.0/24,Proxy,no-resolve\nIP6-CIDR,2001:db8::/32,Proxy,no-resolve\n')


if __name__ == '__main__':
    unittest.main()
