"""Only remove generated rule files whose recorded content still belongs to sync."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))


class RulesOwnershipTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.rules = {'surge': [], 'surge_domainset': [], 'clash': [], 'module': []}
        self.load_generator()

    def load_generator(self):
        spec = importlib.util.spec_from_file_location('rules_ownership_fixture', SCRIPTS / 'sync-rules.py')
        self.generator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.generator)
        self.generator.REPO_ROOT = self.root
        for attribute, relative in (
            ('SURGE_DIR', 'Surge/RULE-SET'),
            ('QX_DIR', 'Quantumult/X/Filter'),
            ('CLASH_DIR', 'Clash/RuleSet'),
            ('SINGBOX_DIR', 'sing-box/source'),
        ):
            directory = self.root / relative
            directory.mkdir(parents=True, exist_ok=True)
            setattr(self.generator, attribute, directory)
        self.generator.MERGE_SECTION_TO_FILE = {}

    def quiet(self, function, *args, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()):
            return function(*args, **kwargs)

    def ownership(self):
        path = self.root / self.generator.RULE_OWNERS_FILE
        return json.loads(path.read_text(encoding='utf-8'))

    def record_ownership(self, files):
        path = self.root / self.generator.RULE_OWNERS_FILE
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({'version': 1, 'files': files}))
        return path

    def outside_directory(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        return Path(temporary.name)

    def external_rules(self):
        url = 'https://upstream.example.invalid/managed.list'
        entry = {'url': url, 'name': 'Managed', 'overrides': {}}
        rules = {**self.rules, 'surge': [entry]}
        response = '# > Managed\nDOMAIN-SUFFIX,ads.example.invalid\n'
        self.quiet(self.generator.fetch_external_rules, rules, {url: response})
        self.quiet(self.generator.convert_all, rules)
        self.quiet(self.generator.cleanup_stale, rules)
        return rules

    def lan_with_cidr_companion(self):
        source = self.generator.SURGE_DIR / 'LAN.list'
        source.write_text('# > LAN\nIP-CIDR,10.0.0.0/8,no-resolve\n')
        self.quiet(self.generator.convert_all, self.rules)
        self.quiet(self.generator.cleanup_stale, self.rules)
        companion = self.generator.CLASH_DIR / 'lancidr.txt'
        self.assertTrue(companion.exists())
        self.assertIn('Clash/RuleSet/lancidr.txt', self.ownership()['files'])
        return source, companion

    def test_handwritten_fork_comments_do_not_establish_generator_ownership(self):
        handwritten = {
            'Surge/RULE-SET/Handwritten.list':
                '### fork from https://example.invalid/reference\n# > Handwritten\nDOMAIN,local.example.invalid\n',
            'Quantumult/X/Filter/Untracked.list': 'host,local.example.invalid\n',
            'Clash/RuleSet/Untracked.yaml': 'payload:\n  - local.example.invalid\n',
            'sing-box/source/Untracked.json': '{"version":2,"rules":[{"domain":["local.example.invalid"]}]}\n',
            'Clash/RuleSet/notes.txt': 'Maintained outside the generator.\n',
        }
        for name, content in handwritten.items():
            (self.root / name).write_text(content, encoding='utf-8')
        self.quiet(self.generator.cleanup_stale, self.rules)
        for name, content in handwritten.items():
            self.assertEqual((self.root / name).read_text(encoding='utf-8'), content, name)

    def test_removed_manifest_entry_cleans_recorded_outputs_across_runs(self):
        self.external_rules()
        state = self.ownership()
        expected = {
            'Surge/RULE-SET/Managed.list',
            'Quantumult/X/Filter/Managed.list',
            'Clash/RuleSet/Managed.yaml',
            'sing-box/source/Managed.json',
        }
        self.assertEqual(state['version'], 1)
        self.assertTrue(expected <= set(state['files']))
        for name in expected:
            self.assertEqual(state['files'][name], hashlib.sha256((self.root / name).read_bytes()).hexdigest())
        # A separate process must rely on the persisted ownership record.
        self.load_generator()
        self.quiet(self.generator.cleanup_stale, self.rules)
        for name in expected:
            self.assertFalse((self.root / name).exists(), name)

    def test_removed_lan_source_cleans_its_cidr_companion_without_touching_other_text(self):
        source = self.generator.SURGE_DIR / 'LAN.list'
        source.write_text('# > LAN\nIP-CIDR,10.0.0.0/8,no-resolve\nIP-CIDR6,fc00::/7,no-resolve\n')
        unrelated = self.generator.CLASH_DIR / 'manual.txt'
        unrelated.write_text('Do not remove.\n')
        self.quiet(self.generator.convert_all, self.rules)
        self.quiet(self.generator.cleanup_stale, self.rules)
        companion = self.generator.CLASH_DIR / 'lancidr.txt'
        self.assertTrue(companion.exists())
        self.assertIn('Clash/RuleSet/lancidr.txt', self.ownership()['files'])
        self.assertNotIn('Surge/RULE-SET/LAN.list', self.ownership()['files'])
        source.unlink()
        self.load_generator()
        self.quiet(self.generator.cleanup_stale, self.rules)
        self.assertFalse(companion.exists())
        self.assertEqual(unrelated.read_text(), 'Do not remove.\n')

    def test_lan_without_cidrs_removes_its_obsolete_cidr_companion(self):
        source, companion = self.lan_with_cidr_companion()
        source.write_text('# > LAN\nDOMAIN-SUFFIX,local.example.invalid\n')
        self.load_generator()
        self.quiet(self.generator.convert_all, self.rules)
        self.quiet(self.generator.cleanup_stale, self.rules)
        self.assertTrue(source.exists())
        self.assertIn('local.example.invalid', (self.generator.CLASH_DIR / 'LAN.yaml').read_text())
        self.assertFalse(companion.exists())
        self.assertNotIn('Clash/RuleSet/lancidr.txt', self.ownership()['files'])

    def test_lan_changed_to_domainset_removes_its_obsolete_cidr_companion(self):
        source, companion = self.lan_with_cidr_companion()
        source.write_text('# > LAN\n.local.example.invalid\n')
        rules = {**self.rules, 'surge_domainset': [{
            'url': 'https://upstream.example.invalid/lan-domains',
            'name': 'LAN',
            'overrides': {},
        }]}
        self.load_generator()
        self.quiet(self.generator.convert_all, rules)
        self.quiet(self.generator.cleanup_stale, rules)
        self.assertTrue(source.exists())
        self.assertIn('local.example.invalid', (self.generator.CLASH_DIR / 'LAN.yaml').read_text())
        self.assertFalse(companion.exists())
        self.assertNotIn('Clash/RuleSet/lancidr.txt', self.ownership()['files'])

    def test_user_edited_cidr_companion_survives_lan_losing_cidrs(self):
        source, companion = self.lan_with_cidr_companion()
        changed = companion.read_text() + '# User maintained local CIDRs.\n'
        companion.write_text(changed)
        source.write_text('# > LAN\nDOMAIN-SUFFIX,local.example.invalid\n')
        self.load_generator()
        self.quiet(self.generator.convert_all, self.rules)
        self.quiet(self.generator.cleanup_stale, self.rules)
        self.assertEqual(companion.read_text(), changed)
        self.assertNotIn('Clash/RuleSet/lancidr.txt', self.ownership()['files'])
        self.load_generator()
        self.quiet(self.generator.cleanup_stale, self.rules)
        self.assertEqual(companion.read_text(), changed)

    def test_user_changes_to_obsolete_generated_output_are_preserved(self):
        self.external_rules()
        target = self.generator.CLASH_DIR / 'Managed.yaml'
        changed = target.read_text() + '# User maintained after its source was removed.\n'
        target.write_text(changed)
        self.load_generator()
        self.quiet(self.generator.cleanup_stale, self.rules)
        self.assertEqual(target.read_text(), changed)
        self.assertFalse((self.generator.SURGE_DIR / 'Managed.list').exists())
        self.quiet(self.generator.cleanup_stale, self.rules)
        self.assertEqual(target.read_text(), changed)

    def test_unchanged_legacy_managed_output_is_adopted_after_verified_generation(self):
        url = 'https://upstream.example.invalid/managed.list'
        path = self.generator.SURGE_DIR / 'Managed.list'
        legacy = '### fork from ' + url + '\n# > Managed\nDOMAIN-SUFFIX,ads.example.invalid\n'
        path.write_text(legacy)
        before = path.stat().st_mtime_ns
        self.external_rules()
        self.assertEqual(path.read_text(), legacy)
        self.assertEqual(path.stat().st_mtime_ns, before)
        self.assertIn('Surge/RULE-SET/Managed.list', self.ownership()['files'])
        self.load_generator()
        self.quiet(self.generator.cleanup_stale, self.rules)
        self.assertFalse(path.exists())

    def test_invalid_registry_paths_fail_without_touching_any_target(self):
        outside = self.outside_directory() / 'sentinel.txt'
        outside.write_text('Outside the repository.\n')
        wrong_suffix = self.generator.CLASH_DIR / 'manual.exe'
        wrong_suffix.write_text('An unsupported output format.\n')
        wrong_prefix = self.root / 'manual.list'
        wrong_prefix.write_text('Outside generated directories.\n')
        targets = (outside, wrong_suffix, wrong_prefix)
        before = {path: path.read_bytes() for path in targets}
        bad_names = (
            '../' + outside.parent.name + '/' + outside.name,
            outside.as_posix(),
            'Clash/RuleSet/manual.exe',
            'manual.list',
        )
        for relative in bad_names:
            with self.subTest(path=relative):
                self.load_generator()
                record = self.record_ownership({relative: hashlib.sha256(outside.read_bytes()).hexdigest()})
                original_record = record.read_bytes()
                with self.assertRaises(ValueError):
                    self.quiet(self.generator.cleanup_stale, self.rules)
                self.assertEqual(record.read_bytes(), original_record)
                self.assertEqual({path: path.read_bytes() for path in targets}, before)

    def test_owned_symlink_cannot_remove_its_external_target(self):
        outside = self.outside_directory() / 'sentinel.list'
        outside.write_text('External target must survive.\n')
        generated = self.generator.SURGE_DIR / 'Removed.list'
        try:
            generated.symlink_to(outside)
        except (NotImplementedError, OSError) as error:
            self.skipTest(f'Symlinks are unavailable: {error}')
        self.record_ownership({
            generated.relative_to(self.root).as_posix(): hashlib.sha256(outside.read_bytes()).hexdigest(),
        })
        with self.assertRaises(ValueError):
            self.quiet(self.generator.cleanup_stale, self.rules)
        self.assertTrue(generated.is_symlink())
        self.assertEqual(outside.read_text(), 'External target must survive.\n')

    def test_symlinked_output_parent_cannot_remove_an_external_file(self):
        outside = self.outside_directory()
        target = outside / 'Removed.list'
        target.write_text('External parent target must survive.\n')
        redirected = self.generator.SURGE_DIR / 'redirected'
        try:
            redirected.symlink_to(outside, target_is_directory=True)
        except (NotImplementedError, OSError) as error:
            self.skipTest(f'Symlinks are unavailable: {error}')
        relative = (redirected / target.name).relative_to(self.root).as_posix()
        self.record_ownership({relative: hashlib.sha256(target.read_bytes()).hexdigest()})
        with self.assertRaises(ValueError):
            self.quiet(self.generator.cleanup_stale, self.rules)
        self.assertTrue(redirected.is_symlink())
        self.assertEqual(target.read_text(), 'External parent target must survive.\n')


if __name__ == '__main__':
    unittest.main()
