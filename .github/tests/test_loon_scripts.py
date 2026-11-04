"""Native Loon script outputs are adapted without a QX text-body facade."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import loon_scripts as loon
from module_convert import parse_module, _options


def converted(url='https://example.invalid/source.js', script_type='http-response', engine=''):
    return ('#!name=Demo\n#!desc=Source help\n[Rule]\nDOMAIN,ads.example.invalid,REJECT\n'
            '[Script]\nOriginal = type=' + script_type + ',pattern=(?i)^https://example.invalid/native,'
            'requires-body=true,binary-body-mode=true,timeout=30,argument="x=1&y=2",script-path=' + url + engine + '\n'
            '[MITM]\nhostname = %APPEND% example.invalid\n')


class LoonScriptsTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.url = 'https://example.invalid/demo.plugin'
        self.entries = [{'url': self.url, 'name': 'Demo.sgmodule', 'overrides': {'name': '净化'}}]
        self.original = {self.url: '#!name=Loon\n[Script]\nresponse if ${url} ~= /native/ then script("source.js")\n'}
        self.native = {self.url: converted()}
        self.body = 'const original=$response.body; $done({status:"HTTP/1.1 404 Not Found",body:original});\n'

    def prepare(self, body=None, entries=None, original=None, native=None):
        return loon.prepare_loon_scripts(entries if entries is not None else self.entries,
                                         original if original is not None else self.original,
                                         native if native is not None else self.native,
                                         self.root, lambda urls: {url: self.body if body is None else body for url in urls})

    def owner_path(self, name=loon.OWNERS_FILE):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def test_status_adapters_keep_source_verbatim_and_native_binary_options(self):
        plan = self.prepare()
        text = plan.source_text(self.url, 'Demo.sgmodule', '')
        options = _options(parse_module(text)[1]['Script'][0].split('=', 1)[1], ',')
        self.assertIn('净化_1 = ', text)
        self.assertEqual(options['script-path'], loon.RAW_SCRIPT_BASE + 'demo.js')
        self.assertEqual(options['binary-body-mode'], 'true')
        self.assertEqual(options['requires-body'], 'true')
        self.assertEqual(options['timeout'], '30')
        self.assertEqual(options['argument'], 'x=1&y=2')
        bundle = plan.scripts['Surge/Module/Scripts/demo.js']
        self.assertEqual(bundle.split('// BEGIN UPSTREAM SOURCE\n')[1].split('\n// END UPSTREAM SOURCE')[0], self.body)
        self.assertNotIn('createQxRuntime', bundle)
        self.assertNotIn('utf8Text', bundle)
        self.assertFalse((self.root / loon.OWNERS_FILE).exists())
        self.assertEqual(plan.sources[self.url], text)
        self.assertEqual(self.native[self.url], converted())

    def test_proven_shared_body_scripts_keep_upstream_url_and_webapis_select_webview(self):
        source = '$done({body:new TextDecoder().decode($response.body)});'
        plan = self.prepare(source)
        self.assertEqual(plan.scripts, {})
        text = plan.source_text(self.url, 'Demo.sgmodule', '')
        self.assertIn('script-path=https://example.invalid/source.js', text)
        self.assertIn('engine=webview', text)
        self.assertIn('binary-body-mode=true', text)
        with self.assertRaisesRegex(ValueError, 'explicit script engine'):
            self.prepare(source, native={self.url: converted(engine=',engine=jsc')})
        auto = self.prepare(source, native={self.url: converted(engine=',engine=auto')})
        self.assertEqual(auto.source_text(self.url, 'Demo.sgmodule', '').count('engine='), 1)

    def test_multiple_execution_stages_use_one_bundle_and_unique_labels(self):
        native = converted().replace('[MITM]',
            'Other = type=http-request,pattern=^https://example.invalid/native,'
            'script-path=https://example.invalid/source.js\n[MITM]')
        plan = self.prepare(native={self.url: native})
        self.assertEqual(len(plan.scripts), 1)
        text = plan.source_text(self.url, 'Demo.sgmodule', '')
        self.assertIn('净化_1 = type=http-response', text)
        self.assertIn('净化_2 = type=http-request', text)
        self.assertEqual(plan.scripts['Surge/Module/Scripts/demo.js'].count('// BEGIN UPSTREAM SOURCE\n'), 1)

    def test_quoted_arguments_and_grouped_patterns_do_not_create_fake_options(self):
        native = converted().replace('argument="x=1&y=2"',
            'argument="x=1,script-path=literal,engine=jsc,pattern=literal"')
        native = native.replace('pattern=(?i)^https://example.invalid/native',
            'pattern=(?i)^https://example.invalid/(?:native,script-path=literal){1,3}')
        plan = self.prepare('const data=new TextDecoder().decode($response.body);$done({status:404,body:data});',
                            native={self.url: native})
        text = plan.sources[self.url]
        self.assertIn('argument="x=1,script-path=literal,engine=jsc,pattern=literal"', text)
        options = loon.parse_script_options(parse_module(text)[1]['Script'][0].split('=', 1)[1])
        self.assertEqual(options['argument'], 'x=1,script-path=literal,engine=jsc,pattern=literal')
        self.assertEqual(options['engine'], 'webview')
        self.assertEqual(options['script-path'], loon.RAW_SCRIPT_BASE + 'demo.js')
        self.assertEqual(options['pattern'], '(?i)^https://example.invalid/(?:native,script-path=literal){1,3}')

    def test_original_native_sources_are_not_fetched_or_rewritten(self):
        url = 'https://example.invalid/native.sgmodule'
        entries = [{'url': url, 'name': 'Native.sgmodule', 'overrides': {}}]
        with patch.object(loon, '_validate_script') as validate:
            plan = loon.prepare_loon_scripts(entries, {url: converted()}, {url: converted()}, self.root,
                                             lambda urls: self.fail('native source fetched JavaScript'))
        self.assertEqual(plan.source_text(url, 'Native.sgmodule', converted()), converted())
        self.assertEqual(plan.scripts, {})
        validate.assert_not_called()
        # The no-Loon stage is a no-op even for a native-only batch whose
        # caller has not needed to resolve target names at this stage yet.
        native_only = loon.prepare_loon_scripts([{'url': url}], {url: converted()}, {url: converted()},
                                                self.root, lambda urls: self.fail('unexpected download'))
        self.assertEqual(native_only.scripts, {})

    def test_unknown_apis_dynamic_globals_and_invalid_sources_fail_before_writes(self):
        for source in ['$loon.sendMessage("x");$done({});', '$task.fetch({});$done({});',
                       'globalThis.$done({status:404});', 'eval("$done({})");',
                       '$done({body:`unproved template`});', '<html>upstream error</html>', 'const = ;']:
            with self.subTest(source=source), self.assertRaises((ValueError, RuntimeError)):
                self.prepare(source)
            self.assertFalse((self.root / loon.OWNERS_FILE).exists())
            self.assertFalse((self.root / 'Surge/Module/Scripts/demo.js').exists())
        harmless = '$done({body:$response.body}); // $loon TextDecoder\n'
        # Shared-body proof is deliberately conservative about comments, but
        # comments must not be interpreted as unsupported APIs or WebAPI use.
        self.prepare(harmless)
        self.assertNotIn('engine=webview', self.prepare(harmless).sources[self.url])

    def test_inputs_and_lowercase_path_collisions_are_checked_before_writing(self):
        plan = self.prepare()
        plan.validate_inputs(self.root, self.entries, self.original)
        with self.assertRaisesRegex(ValueError, 'does not match'):
            plan.validate_inputs(self.root, self.entries, {self.url: 'changed'})
        with self.assertRaisesRegex(ValueError, 'converted sources'):
            plan.validate_inputs(self.root, self.entries, self.original, {self.url: 'changed'})
        entries = self.entries + [{**self.entries[0], 'name': 'nested/demo.sgmodule'}]
        with self.assertRaisesRegex(ValueError, 'basenames collide'):
            self.prepare(entries=entries)
        manual = self.root / 'Surge/Module/Scripts/demo.js'
        manual.parent.mkdir(parents=True)
        manual.write_text('// handwritten\n')
        with self.assertRaisesRegex(ValueError, 'local edits'):
            self.prepare()
        self.assertEqual(manual.read_text(), '// handwritten\n')

    def test_qx_and_native_label_collisions_fail_in_preparation(self):
        self.owner_path('.github/scripts/qx-scripts-owned.json').write_text(json.dumps({
            'version': 1, 'files': {'Surge/Module/Scripts/demo.js': '0' * 64},
        }))
        with self.assertRaisesRegex(ValueError, 'QX generated-script basenames collide'):
            self.prepare()
        self.owner_path('.github/scripts/qx-scripts-owned.json').unlink()
        url = 'https://example.invalid/native.sgmodule'
        entries = self.entries + [{'url': url, 'name': 'Demo.sgmodule', 'overrides': {}}]
        native = {**self.native, url: converted().replace('Original =', '净化_1 =')}
        with self.assertRaisesRegex(ValueError, 'labels collide'):
            self.prepare(entries=entries, original={**self.original, url: native[url]}, native=native)

    def test_ownership_cleanup_never_removes_edited_or_unowned_scripts(self):
        plan = self.prepare()
        plan.write_scripts()
        plan.finish()
        target = self.root / 'Surge/Module/Scripts/demo.js'
        registry = json.loads(self.owner_path().read_text())
        self.assertEqual(registry['files'][target.relative_to(self.root).as_posix()], hashlib.sha256(target.read_bytes()).hexdigest())
        empty = self.prepare(entries=[], original={}, native={})
        empty.finish()
        self.assertFalse(target.exists())
        plan = self.prepare()
        plan.write_scripts(); plan.finish()
        target.write_text(target.read_text() + '// local edit\n')
        unowned = target.with_name('manual.js'); unowned.write_text('// keep\n')
        self.prepare(entries=[], original={}, native={}).finish()
        self.assertTrue(target.exists())
        self.assertTrue(unowned.exists())
        self.assertEqual(json.loads(self.owner_path().read_text())['files'], {})

    def test_symlinks_and_invalid_ownership_are_rejected(self):
        registry = self.owner_path()
        outside = self.root / 'external.json'; outside.write_text('{"version":1,"files":{}}')
        registry.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'Unsafe Loon'):
            self.prepare()
        registry.unlink()
        registry.write_text(json.dumps({'version': 1, 'files': {'../outside.js': '0' * 64}}))
        with self.assertRaisesRegex(ValueError, 'ownership path'):
            self.prepare()

    def test_repeat_generation_is_deterministic_and_respects_modified_owned_files(self):
        plan = self.prepare(); plan.write_scripts(); plan.finish()
        again = self.prepare()
        self.assertEqual(plan.scripts, again.scripts)
        self.assertEqual(plan.converted_by_target, again.converted_by_target)
        path = self.root / 'Surge/Module/Scripts/demo.js'
        changed = path.read_text() + '// modified\n'; path.write_text(changed)
        with self.assertRaisesRegex(ValueError, 'local edits'):
            self.prepare('const body=$response.body;$done({status:404,body});')
        self.assertEqual(path.read_text(), changed)


if __name__ == '__main__':
    unittest.main()
