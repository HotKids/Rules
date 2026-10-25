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
from urllib.parse import quote

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
#!date=2026-10-02 13:57:49
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
            refreshed = source.replace('2026-10-02 13:57:49', '2027-01-01 00:00:00')
            again = beta.generate(entries, {'one': refreshed, 'two': refreshed.replace('a.example', 'b.example')}, stable, target)
            self.assertEqual(target.read_bytes(), saved)
        old, _ = beta.parse_module(stable)
        actual, sections = beta.parse_module(content)
        for key in old.keys() - {'name', 'date'}:
            self.assertEqual(actual[key], old[key])
        self.assertEqual(actual['name'], '合集 Beta')
        self.assertIn('# > 甲 去广告', content)
        self.assertNotIn('# > 甲 去广告 Beta', content)
        self.assertNotRegex(content, r'(?m)^# > .* · \d{4}-\d{2}-\d{2}')
        self.assertIn('date', actual)
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

    def test_converter_failure_keeps_only_safe_bounded_stderr_tail(self):
        source_url = 'https://example.invalid/private_remove_ads.lpx?access=source-secret#fragment-secret'
        stderr = '\n'.join([
            *['old line ' + str(index) for index in range(20)],
            '\x1b[31mTypeError: parser.compile is not a function\x1b[0m',
            source_url,
            quote(source_url, safe=''),
            quote(quote(source_url, safe=''), safe=''),
            'api_key="key-secret" token=token-secret password=pass-secret',
            '{"secret":"json-secret", "psk":"psk-secret"} ?trace=query-secret&mode=another-secret',
            'Authorization: Bearer auth-secret',
            'at convertSource (convert-loon.cjs:12:3) ' + 'x' * 500,
        ])
        result = subprocess.CompletedProcess([], 1, 'stdout-source-secret', stderr)
        with patch.object(beta.subprocess, 'run', return_value=result):
            with self.assertRaises(RuntimeError) as failure:
                beta.convert_sources([{'id': 'one', 'name': 'A'}], {'one': 'source'}, 'parser', {})
        message = str(failure.exception)
        self.assertIn('exit 1', message)
        self.assertIn('TypeError: parser.compile is not a function', message)
        self.assertIn('convert-loon.cjs:12:3', message)
        self.assertNotIn('old line', message)
        self.assertNotIn('secret', message.replace('"secret"', ''))
        self.assertNotIn('example.invalid', message)
        self.assertNotIn('stdout-', message)
        self.assertNotIn('\x1b', message)
        self.assertLess(len(message), 2000)
        self.assertTrue(all(len(line) <= 240 for line in message.splitlines()[1:]))

    def test_converter_timeout_redacts_byte_stderr_without_using_stdout(self):
        timeout = subprocess.TimeoutExpired('node', 180, output=b'stdout-private',
                                            stderr=b'Error: timeout\ntoken=timeout-private')
        with patch.object(beta.subprocess, 'run', side_effect=timeout):
            with self.assertRaisesRegex(RuntimeError, '超时') as failure:
                beta.convert_sources([{'id': 'one', 'name': 'A'}], {'one': 'source'}, 'parser', {})
        message = str(failure.exception)
        self.assertIn('Error: timeout', message)
        self.assertNotIn('private', message)

    def test_diagnostic_tail_masks_standalone_paths_and_query_fragments(self):
        text = beta.diagnostic_tail('Lpx/Private_remove_ads.lpx?api_key=one\n'
                                    '?anything=two&another=three\n'
                                    'token%3Dfour localtext%253Dsix\n'
                                    'Cookie: session=five; other=value\n'
                                    'GIST_TOKEN=seven accessToken=eight ?label="nine ten"')
        self.assertNotRegex(text, r'Private|one|two|three|four|five|six|seven|eight|nine|ten|session')

    def test_aggregator_is_loaded_once_without_renaming_the_cli(self):
        self.assertIs(beta.load_aggregator(), beta.load_aggregator())


if __name__ == '__main__':
    unittest.main()
