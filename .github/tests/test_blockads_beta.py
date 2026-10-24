"""Beta uses the same application controls and never publishes partial conversion."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location('blockads_beta', SCRIPTS / 'sync-modules-beta.py')
beta = importlib.util.module_from_spec(spec)
spec.loader.exec_module(beta)


class BetaTests(unittest.TestCase):
    def test_name_belongs_to_next_row_and_disabled_names_do_not_leak(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'sources.txt'
            path.write_text(';Disabled\n# https://example.invalid/off.sgmodule,off\n'
                            'https://example.invalid/passthrough.sgmodule,passthrough\n'
                            ';BiliComic\nhttps://example.invalid/comic.sgmodule,comic\n')
            sources = beta.read_sources(path)
        self.assertEqual([s['name'] for s in sources], [None, 'BiliComic'])
        self.assertEqual([s['alias'] for s in sources], ['passthrough', 'comic'])
        self.assertEqual(beta.runtime_url(sources[0]), sources[0]['surge'])
        self.assertTrue(beta.runtime_url(sources[1]).endswith('/BiliComic_remove_ads.lpx'))

    def test_frozen_header_exact_app_headings_controls_and_upstream_script_names(self):
        stable = '''#!name=合集
#!desc=原说明
#!category=去广告
#!remark=原依赖
#!arguments=甲:a,甲-switch:false,乙:b
#!arguments-desc=原参数说明\\n第二行
#!date=old
[Rule]
# > 甲 去广告 · 2026-01-01
# > 乙去广告 · 2026-01-01
'''
        source = '''#!name=新上游名称
#!arguments=switch:false
[Rule]
DOMAIN,ads.a.example,REJECT
[Script]
Same = type=http-response,pattern=^https://a.example/,script-path=https://example.invalid/ad.js,requires-body=true,argument=x={{{switch}}}
Same = type=http-response,pattern=^https://a.example/other,script-path=https://example.invalid/ad.js,requires-body=true
[MITM]
hostname = a.example
'''
        entries = [{'id': 'one', 'name': 'A', 'alias': 'a'}, {'id': 'two', 'name': None, 'alias': 'b'}]
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            target = Path(directory) / 'Beta.sgmodule'
            content = beta.generate(entries, {'one': source, 'two': source.replace('a.example', 'b.example')}, stable, target)
            self.assertEqual(target.read_text(), content)
            saved = target.read_bytes()
            again = beta.generate(entries, {'one': source, 'two': source.replace('a.example', 'b.example')}, stable, target)
            self.assertEqual(target.read_bytes(), saved)
        old, _ = beta.parse_module(stable)
        actual, sections = beta.parse_module(content)
        for key in old.keys() - {'name', 'date'}:
            self.assertEqual(actual[key], old[key])
        self.assertEqual(actual['name'], '合集 Beta')
        self.assertIn('# > 甲 去广告', content)
        self.assertNotIn('# > 甲 去广告 Beta', content)
        self.assertIn('x={{{甲-switch}}}', content)
        self.assertIn('ads.{{{甲}}}.example', content)
        self.assertIn('x=false', content)
        labels = [line.partition('=')[0].strip() for line in sections['Script'] if line and not line.startswith('#')]
        self.assertEqual(len(labels), 4)
        self.assertEqual(labels, ['Same', 'Same', 'Same', 'Same'])
        self.assertNotIn('甲-Same', content)
        self.assertNotIn('Same__2', content)
        self.assertEqual(beta.parse_module(again)[1], sections)

    def test_unknown_control_or_source_binding_preserves_previous_beta(self):
        stable = '#!name=Stable\n#!desc=Help\n#!category=去广告\n#!arguments=A:a\n#!arguments-desc=Help\n[Rule]\nDOMAIN,a.example,REJECT\n'
        entries = [{'id': 'one', 'name': 'A', 'alias': 'a'}]
        bad = '#!name=A\n[Rule]\nDOMAIN,a.example,{{{unknown}}}\n'
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            path = Path(directory) / 'Beta.sgmodule'
            path.write_text('last complete version')
            with self.assertRaisesRegex(ValueError, '未定义参数'):
                beta.generate(entries, {'one': bad}, stable, path)
            self.assertEqual(path.read_text(), 'last complete version')
            with self.assertRaisesRegex(ValueError, '正式版参数'):
                beta.generate(entries, {'one': bad}, stable.replace('A:a', 'A:different'), path)
            self.assertEqual(path.read_text(), 'last complete version')

    def test_converter_only_allows_non_destructive_protocol_acceleration_advisory(self):
        entries = [{'id': 'one', 'name': 'A'}]
        def result(warning, text):
            return subprocess.CompletedProcess([], 0, json.dumps({'results': [{
                'id': 'one', 'text': text, 'unsupported': True,
                'diagnostics': [{'level': 'warning', 'message': warning}],
            }]}), '')
        with patch.object(beta.subprocess, 'run', return_value=result('无法等价转换', '[Rule]\nDOMAIN,a,REJECT')):
            with self.assertRaisesRegex(ValueError, '无法等价转换'):
                beta.convert_sources(entries, {'one': 'source'}, 'parser', {})
        warning = result('不是surge内置策略且未指定策略的规则', '[Rule]\nDOMAIN,a,REJECT')
        body = json.loads(warning.stdout)
        body['results'][0]['unsupported'] = False
        warning.stdout = json.dumps(body)
        with patch.object(beta.subprocess, 'run', return_value=warning):
            with self.assertRaisesRegex(ValueError, '无法等价转换'):
                beta.convert_sources(entries, {'one': 'source'}, 'parser', {})
        rule = '[Rule]\nAND,((DOMAIN,a),(PROTOCOL,QUIC)),REJECT'
        with patch.object(beta.subprocess, 'run', return_value=result(beta.PM_ADVISORY, rule)), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(beta.convert_sources(entries, {'one': 'source'}, 'parser', {})['one'], rule)
        with patch.object(beta.subprocess, 'run', return_value=result(beta.PM_ADVISORY, '[Rule]\nDOMAIN,a,REJECT')):
            with self.assertRaisesRegex(ValueError, 'QUIC'):
                beta.convert_sources(entries, {'one': 'source'}, 'parser', {})


if __name__ == '__main__':
    unittest.main()
