"""Module generation tests: preserve behavior, ordering, metadata and failure atomicity."""
import importlib.util
import contextlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import yaml

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
from module_convert import module_targets, merge_modules, render_surge, render_stash, parse_module, apply_stash_ca
from config_sync import pipeline


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

    def test_profile_ca_sync_preserves_module_and_removes_old_credentials(self):
        original, _ = render_stash(merge_modules([('source', '''#!name=Base
[MITM]
hostname = %APPEND% ads.example.invalid
[URL Rewrite]
^https://ads.example.invalid/ - reject
[Rule]
DOMAIN,ads.example.invalid,REJECT
''', {})]), 'BlockAdsBase.stoverride')
        text = original
        for fields in ({'ca-p12': 'first+fixture==', 'ca-passphrase': "a' b: # = c"},
                       {'ca-p12': 'rotated+fixture==', 'ca-passphrase': '012345'},
                       {'ca-p12': 'rotated+fixture==', 'ca-passphrase': ''}, {}):
            lines = [f'{k} = {v}' for k, v in fields.items()]
            lines += ['# ca-p12 = ignored', '// ca-passphrase = ignored', 'hostname = unrelated.invalid']
            text = apply_stash_ca(text, lines)
            self.assertEqual(apply_stash_ca(text, lines), text)
            actual = yaml.safe_load(text)
            expected = yaml.safe_load(original)
            for source, target in [('ca-p12', 'ca'), ('ca-passphrase', 'ca-passphrase')]:
                if source in fields:
                    expected['http'][target] = fields[source]
            self.assertEqual(actual, expected)
            self.assertLess(list(actual).index('http'), list(actual).index('rules'))
        self.assertEqual(text, original)
        no_http = 'name: Base\nrules: ["DOMAIN,a.invalid,REJECT"]\n'
        added = yaml.safe_load(apply_stash_ca(no_http, ['ca-p12 = fixture']))
        self.assertLess(list(added).index('http'), list(added).index('rules'))
        self.assertEqual(yaml.safe_load(apply_stash_ca(yaml.safe_dump(added), [])), yaml.safe_load(no_http))

    def test_rules_and_config_sync_keep_profile_ca_only_in_stash_base(self):
        spec = importlib.util.spec_from_file_location('sync_rules_ca_test', SCRIPTS / 'sync-rules.py')
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        with tempfile.TemporaryDirectory() as directory, contextlib.ExitStack() as stack:
            root = Path(directory)
            (root / 'Surge').mkdir()
            profile = root / 'Surge/Profile.conf'
            profile.write_text('[MITM]\nca-p12 = first-fixture\nca-passphrase = 012345\n')
            listing = root / 'sync-rules.txt'
            listing.write_text('# >> Module\nsource,BlockAdsBase\nsource,Other\n')
            stack.enter_context(patch.object(runner, 'REPO_ROOT', root))
            stack.enter_context(patch.object(runner, 'SYNC_RULES_TXT', listing))
            stack.enter_context(patch.object(runner, 'prefetch_urls', return_value={
                'source': '[MITM]\nhostname = ads.example.invalid\n[Rule]\nDOMAIN,ads.example.invalid,REJECT\n'}))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            runner.fetch_external_modules()
            base = root / 'Surge/Module/Stash/BlockAdsBase.stoverride'
            self.assertEqual(yaml.safe_load(base.read_text())['http']['ca'], 'first-fixture')
            others = {p: p.read_bytes() for p in (root / 'Surge/Module').rglob('*') if p.is_file() and p != base}
            self.assertNotIn('ca', yaml.safe_load((root / 'Surge/Module/Stash/Other.stoverride').read_text())['http'])
            stack.enter_context(patch.object(pipeline, 'REPO_ROOT', root))
            stack.enter_context(patch.object(pipeline, 'parse_sync_txt', return_value={'Surge': {'source': 'Surge/Profile.conf'}}))
            stack.enter_context(patch.dict(pipeline._GENERAL_INJECT, clear=True))
            for name in ('_sync_clash', '_sync_stash', '_sync_stash_panel_metadata', '_sync_loon', '_sync_qx', '_sync_surfboard', '_sync_singbox'):
                stack.enter_context(patch.object(pipeline, name))
            for fields, expected in [('ca-p12 = rotated-fixture\nca-passphrase = false\n',
                                     {'ca': 'rotated-fixture', 'ca-passphrase': 'false'}), ('', {})]:
                profile.write_text('[MITM]\n' + fields)
                pipeline.main()
                self.assertEqual(yaml.safe_load(base.read_text())['http'], {'mitm': ['ads.example.invalid'], **expected})
                once = base.read_bytes()
                runner.fetch_external_modules()
                self.assertEqual(base.read_bytes(), once)
                for path, content in others.items():
                    self.assertEqual(path.read_bytes(), content)

    def test_merge_first_metadata_and_order_without_losing_scripts_or_hosts(self):
        first = '''#!name=First
#!desc=Upstream first
#!author=First author
#!category=HotKids
#!icon=https://example.invalid/first.png
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
#!category=Ignored
#!icon=https://example.invalid/second.png
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
        self.assertEqual(data['category'], 'HotKids')
        self.assertEqual(data['icon'], 'https://example.invalid/first.png')
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

    def test_defaults_apply_to_all_module_sections_without_surge_editor_comments(self):
        source = '''#!category=HotKids
#!icon=https://example.invalid/icon.png
#!arguments=policy:DIRECT,host:api.example.invalid,enabled:false,key:null,mask:0,token:account:license,off:#
#!arguments-desc=Surge parameter editor instructions
[Rule]
DOMAIN,{{{host}}},{{{policy}}}
{{{off}}}DOMAIN,disabled.example.invalid,REJECT
[MITM]
hostname = %APPEND% {{{host}}}
[URL Rewrite]
^https://{{{host}}}/ https://example.invalid/ 302
[Script]
Probe = type=http-response,pattern=^https://{{{host}}}/,script-path=https://example.invalid/probe.js,argument=enabled={{{enabled}}}&key={{{key}}}&mask={{{mask}}}&token={{{token}}}
Clock = type=cron,cronexp="0 * * * *",script-path=https://example.invalid/clock.js,argument=enabled={{{enabled}}}
{{{off}}} = type=http-response,pattern=off,script-path=https://example.invalid/off.js
'''
        module = merge_modules([('source', source, {})])
        rendered, warnings = render_stash(module, 'Defaults.stoverride')
        data = yaml.safe_load(rendered)
        self.assertFalse(warnings)
        self.assertEqual(data['rules'], ['DOMAIN,api.example.invalid,DIRECT'])
        self.assertEqual(data['http']['mitm'], ['api.example.invalid'])
        self.assertEqual(data['http']['url-rewrite'], ['^https://api.example.invalid/ https://example.invalid/ 302'])
        self.assertEqual(data['http']['script'][0]['argument'], 'enabled=false&key=null&mask=0&token=account:license')
        self.assertEqual(data['cron']['script'][0]['argument'], 'enabled=false')
        self.assertEqual(len(data['script-providers']), 2)
        self.assertNotIn('{{{', rendered)
        self.assertNotIn('arguments-desc', rendered)
        self.assertNotIn('# arguments:', rendered)
        self.assertIn('#!arguments-desc=', render_surge(module))

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
            metadata = parse_module(text)[0]
            for key in ('category', 'icon'):
                self.assertEqual(data.get(key), metadata.get(key), (name, key))
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
            self.assertEqual(sorted(str(p.relative_to(folder)) for p in folder.rglob('*') if p.is_file()),
                             ['Combined.sgmodule', 'Only.sgmodule', 'Stash/Combined.stoverride', 'Stash/OnlyStash.stoverride'])
            output = yaml.safe_load((folder / 'Stash/Combined.stoverride').read_text())
            self.assertEqual(output['desc'], 'first')
            self.assertEqual(len(output['rules']), 2)
            before = {p: p.read_bytes() for p in folder.rglob('*') if p.is_file()}
            texts['two'] = '<html>download failed</html>'
            with self.assertRaises(ValueError): runner.fetch_external_modules()
            self.assertEqual({p: p.read_bytes() for p in folder.rglob('*') if p.is_file()}, before)

    def test_sync_removes_renamed_and_removed_outputs_but_preserves_manual_modules(self):
        spec = importlib.util.spec_from_file_location('sync_rules_cleanup', SCRIPTS / 'sync-rules.py')
        runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
        with tempfile.TemporaryDirectory() as tmp, patch.object(runner, 'REPO_ROOT', Path(tmp)):
            listing = Path(tmp) / 'sync-rules.txt'
            folder = Path(tmp) / 'Surge/Module'
            folder.mkdir(parents=True)
            manual = {
                'GeoLoc.sgmodule': '### fork from https://example.invalid/source\n[Rule]\nDOMAIN,manual.invalid,DIRECT\n',
                'Stash/Manual.stoverride': 'name: Manual\nrules: ["DOMAIN,manual.invalid,DIRECT"]\n',
                'Pannel/media.sgmodule': '#!name=Panel\n[Panel]\n',
                'Pannel/media.stoverride': 'name: Panel\n',
            }
            for name, content in manual.items():
                path = folder / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
            texts = {'one': '[Rule]\nDOMAIN,one.invalid,REJECT\n',
                     'two': '[Rule]\nDOMAIN,two.invalid,REJECT\n'}
            with patch.object(runner, 'SYNC_RULES_TXT', listing), \
                 patch.object(runner, 'prefetch_urls', return_value=texts):
                listing.write_text('# >> Module\none,DouyinHK\ntwo,Keep\n')
                runner.fetch_external_modules()
                # Test both native formats, subdirectories and removing one format.
                listing.write_text('# >> Module\none,renamed/Douyin\ntwo,Keep.stoverride\n')
                before = {p: p.read_bytes() for p in folder.rglob('*') if p.is_file()}
                valid = texts['one']
                texts['one'] = '<html>download failed</html>'
                with self.assertRaises(ValueError): runner.fetch_external_modules()
                self.assertEqual({p: p.read_bytes() for p in folder.rglob('*') if p.is_file()}, before)
                texts['one'] = valid
                runner.fetch_external_modules()
                expected = set(manual) | {'renamed/Douyin.sgmodule', 'Stash/renamed/Douyin.stoverride', 'Stash/Keep.stoverride'}
                self.assertEqual({str(p.relative_to(folder)) for p in folder.rglob('*') if p.is_file()}, expected)
                for name, content in manual.items():
                    self.assertEqual((folder / name).read_text(), content)
                # Missing config is an error; an explicit empty list removes all managed outputs.
                before = {p: p.read_bytes() for p in folder.rglob('*') if p.is_file()}
                listing.unlink()
                with self.assertRaises(FileNotFoundError): runner.fetch_external_modules()
                self.assertEqual({p: p.read_bytes() for p in folder.rglob('*') if p.is_file()}, before)
                listing.write_text('# >> Module\n')
                runner.fetch_external_modules()
                self.assertEqual({str(p.relative_to(folder)) for p in folder.rglob('*') if p.is_file()}, set(manual))


if __name__ == '__main__': unittest.main()
