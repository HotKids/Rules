"""Module generation tests: preserve behavior, ordering, metadata and failure atomicity."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import yaml

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
from module_convert import module_targets, merge_modules, render_surge, render_stash, parse_module


class ModuleTests(unittest.TestCase):
    def convert(self, text):
        output, warnings = render_stash(merge_modules([('https://example.invalid/a', text, {})]), 'Example.stoverride')
        return yaml.safe_load(output), warnings

    def test_extensions_and_invalid_paths(self):
        self.assertEqual(module_targets('BlockAdsBase'), ['BlockAdsBase.sgmodule', 'BlockAdsBase.stoverride'])
        for suffix in ('.sgmodule', '.stoverride'):
            self.assertEqual(module_targets('sub/Name' + suffix), ['sub/Name' + suffix])
        for name in ('../name', '/name', 'a/../b', '', 'a\\b', 'name.yaml'):
            with self.assertRaises(ValueError): module_targets(name)

    def test_merge_first_metadata_and_order_without_losing_scripts_or_hosts(self):
        first = '''#!name=First
#!desc=Upstream first
#!author=First author
#!arguments=Shared:DIRECT
[Rule]
DOMAIN,one.invalid,{{{Shared}}}
[Script]
Same = type=http-response,pattern=one,script-path=https://example.invalid/1.js
[MITM]
hostname = %APPEND% one.invalid, *.example.invalid, -excluded.example.invalid
'''
        second = '''#!name=Second
#!desc=Second description
#!author=Second author
#!arguments=Shared:REJECT,Extra:REJECT
[Rule]
DOMAIN,one.invalid,{{{Shared}}}
DOMAIN,two.invalid,{{{Extra}}}
[Script]
Same = type=http-response,pattern=two,script-path=https://example.invalid/2.js
[MITM]
hostname = %APPEND% two.invalid, one.invalid
'''
        merged = merge_modules([('one', first, {'desc': 'Chosen first'}), ('two', second, {'desc': 'Ignore second'})])
        surge = render_surge(merged)
        self.assertEqual(surge.count('[Rule]'), 1)
        self.assertEqual(surge.count('DOMAIN,one.invalid'), 1)
        self.assertEqual(surge.count('hostname ='), 1)
        self.assertIn('Same__2 =', surge)
        output, warnings = render_stash(merged, 'Same.stoverride')
        data = yaml.safe_load(output)
        self.assertFalse(warnings)
        self.assertEqual((data['name'], data['desc'], data['author']), ('First', 'Chosen first', 'First author'))
        self.assertEqual(data['rules'], ['DOMAIN,one.invalid,DIRECT', 'DOMAIN,two.invalid,REJECT'])
        self.assertEqual(data['http']['mitm'], ['one.invalid', '*.example.invalid', '-excluded.example.invalid', 'two.invalid'])
        self.assertEqual([s['match'] for s in data['http']['script']], ['one', 'two'])
        self.assertEqual(len(data['script-providers']), 2)
        self.assertLess(list(data).index('http'), list(data).index('rules'))
        self.assertEqual(list(data['http'])[0], 'mitm')

    def test_script_arguments_binary_webkit_and_cron_are_preserved(self):
        data, warnings = self.convert(r'''#!arguments=log:4
[Script]
One = type=http-response,pattern=^https://a/\d{1,3},argument="{"log":{{{log}}},"list":[1,2]}",requires-body=true,binary-body-mode=1,max-size=-1,engine=webview,timeout=10,script-path=https://example.invalid/a.js
Clock = type=cron,cronexp="*/5 * * * *",script-path=https://example.invalid/a.js,argument="hello, world",timeout=15
''')
        self.assertFalse(warnings)
        entry = data['http']['script'][0]
        self.assertEqual(entry['match'], r'^https://a/\d{1,3}')
        self.assertEqual(entry['argument'], '{"log":4,"list":[1,2]}')
        self.assertEqual(entry['engine'], 'webkit')
        self.assertIs(entry['binary-mode'], True)
        self.assertIs(entry['require-body'], True)
        self.assertEqual(entry['max-size'], 0)
        self.assertIsInstance(entry['timeout'], int)
        self.assertEqual(data['cron']['script'][0]['cron'], '*/5 * * * *')
        self.assertEqual(data['cron']['script'][0]['argument'], 'hello, world')

    def test_native_mock_jq_header_and_url_rewrites(self):
        data, warnings = self.convert(r'''[Map Local]
^https://a/json header="content-type: application/json|X-Test: yes" data-type=text data="{"a":[1,2],"quote":"ok"}" status-code=201
^https://a/binary data-type=base64 data="AAAAAAA="
^https://a/gif data-type=tiny-gif
[Body Rewrite]
http-response-jq ^https://a/json 'del(.ad) | .name = "Stash"'
[Header Rewrite]
http-request ^https://a/ header-add X-Test yes
[URL Rewrite]
^https://a/ https://b/ header
[Rule]
URL-REGEX,"^https://a/(foo|bar)",REJECT-DROP
AND,((DOMAIN,a.invalid),(DEST-PORT,443)),REJECT,pre-matching
''')
        self.assertEqual(len(warnings), 1)
        http = data['http']
        self.assertEqual(http['mock'][0]['text'], '{"a":[1,2],"quote":"ok"}')
        self.assertEqual(http['mock'][0]['headers'], {'content-type': 'application/json', 'X-Test': 'yes'})
        self.assertEqual(http['mock'][0]['status-code'], 201)
        self.assertEqual(http['mock'][1]['base64'], 'AAAAAAA=')
        self.assertEqual(http['mock'][2]['headers']['Content-Type'], 'image/gif')
        self.assertEqual(http['body-rewrite'], ['^https://a/json response-jq del(.ad) | .name = "Stash"'])
        self.assertEqual(http['header-rewrite'], ['^https://a/ request-add X-Test yes'])
        self.assertEqual(http['url-rewrite'], ['^https://a/ https://b/ transparent', '^https://a/(foo|bar) - reject-200'])
        self.assertEqual(data['rules'], ['AND,((DOMAIN,a.invalid),(DST-PORT,443)),REJECT'])

    def test_disabled_defaults_do_not_run_and_unknown_features_are_reported(self):
        data, warnings = self.convert('''#!arguments=off:#
[Script]
{{{off}}} = type=http-response,pattern=one,script-path=https://example.invalid/1.js
Event = type=event,event-name=network-changed,script-path=https://example.invalid/event.js
[MITM]
hostname = %APPEND% *.example.invalid
h2 = true
''')
        self.assertNotIn('script-providers', data)
        self.assertEqual(len(warnings), 2)
        with self.assertRaises(ValueError): self.convert('[Rule]\nDOMAIN,a.invalid,{{{missing}}}')

    def test_existing_modules_keep_all_supported_active_entries(self):
        root = SCRIPTS.parents[1]
        for name in ('BlockAdsBase', 'Bilibili', 'CloudMusic', 'RedNote', 'Weibo'):
            text = (root / 'Surge/Module' / (name + '.sgmodule')).read_text()
            data, warnings = self.convert(text)
            self.assertTrue(data['http']['mitm'], name)
            self.assertTrue(all('Surge-only options omitted' in w for w in warnings), (name, warnings))
            for script in data['http'].get('script', []):
                self.assertIn(script['name'], data['script-providers'])
                self.assertNotIn('{{{', script.get('argument', ''))
            source = parse_module(text)[1]
            active_maps = [l for l in source.get('Map Local', []) if l.strip() and not l.lstrip().startswith('#')]
            self.assertEqual(len(data['http'].get('mock', [])), len(active_maps), name)

    def test_batch_merges_same_outputs_and_does_not_write_when_a_source_fails(self):
        spec = importlib.util.spec_from_file_location('sync_rules_modules', SCRIPTS / 'sync-rules.py')
        runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
        entries = [{'url': 'one', 'name': 'Combined', 'overrides': {'desc': 'first'}},
                   {'url': 'two', 'name': 'Combined', 'overrides': {'desc': 'second'}},
                   {'url': 'one', 'name': 'Only.sgmodule', 'overrides': {}},
                   {'url': 'two', 'name': 'OnlyStash.stoverride', 'overrides': {}}]
        texts = {'one': '[Rule]\nDOMAIN,one.invalid,REJECT\n', 'two': '[Rule]\nDOMAIN,two.invalid,REJECT\n'}
        with tempfile.TemporaryDirectory() as tmp, patch.object(runner, 'REPO_ROOT', Path(tmp)), \
             patch.object(runner, 'parse_sync_rules', return_value={'module': entries}), \
             patch.object(runner, 'prefetch_urls', return_value=texts):
            runner.fetch_external_modules()
            folder = Path(tmp) / 'Surge/Module'
            self.assertEqual(sorted(p.name for p in folder.iterdir()), ['Combined.sgmodule', 'Combined.stoverride', 'Only.sgmodule', 'OnlyStash.stoverride'])
            output = yaml.safe_load((folder / 'Combined.stoverride').read_text())
            self.assertEqual(output['desc'], 'first')
            self.assertEqual(len(output['rules']), 2)
            before = {p: p.read_bytes() for p in folder.iterdir()}
            texts['two'] = '<html>download failed</html>'
            with self.assertRaises(ValueError): runner.fetch_external_modules()
            self.assertEqual({p: p.read_bytes() for p in folder.iterdir()}, before)


if __name__ == '__main__': unittest.main()
