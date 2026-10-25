"""Remote includes must never silently remove an imported configuration section."""
import contextlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / '.github/scripts'))
import _common as common
from config_sync import parser


class RemoteIncludeTests(unittest.TestCase):
    def setUp(self):
        self.cache = patch.dict(parser._url_cache, {}, clear=True)
        self.cache.start()
        self.addCleanup(self.cache.stop)
        self.url = 'https://example.invalid/source?token=private-value'

    def test_empty_missing_or_comment_only_sections_fail_without_poisoning_cache(self):
        for content in ('', ' \n', '[general]\nmode=filter\n', '[dns]\n[policy]\n',
                        '[dns]\n # comment\n; comment\n// comment\n[policy]\n'):
            with self.subTest(content=content), patch.object(parser, 'fetch_url', return_value=content):
                with self.assertRaisesRegex(RuntimeError, r'有效 \[dns\]') as caught:
                    parser._fetch_remote_section(self.url, 'dns')
                self.assertNotIn('private-value', str(caught.exception))
                self.assertNotIn(self.url, parser._url_cache)
        with patch.object(parser, 'fetch_url', return_value='[dns]\nno-system\nserver=1.1.1.1\n') as fetch:
            self.assertEqual(parser._fetch_remote_section(self.url, 'dns'), ['no-system', 'server=1.1.1.1'])
            parser._fetch_remote_section(self.url, 'dns')
            self.assertEqual(fetch.call_count, 1)

    def test_partial_cache_cannot_hide_a_missing_requested_section(self):
        with patch.object(parser, 'fetch_url', return_value='[dns]\nserver=1.1.1.1\n') as fetch:
            parser._fetch_remote_section(self.url, 'dns')
            with self.assertRaisesRegex(RuntimeError, r'有效 \[general\]'):
                parser._fetch_remote_section(self.url, 'general')
            self.assertNotIn(self.url, parser._url_cache)
            self.assertEqual(fetch.call_count, 1)
        with patch.object(parser, 'fetch_url', return_value='[general]\nmode=filter\n'):
            self.assertEqual(parser._fetch_remote_section(self.url, 'general'), ['mode=filter'])

    def test_public_download_retry_recovers_before_importing_a_complete_section(self):
        outcomes = iter([TimeoutError('fixture timeout'), b'', b'[dns]\nno-system\nserver=1.1.1.1\n[policy]\n'])
        def open_url(*_args, **_kwargs):
            outcome = next(outcomes)
            if isinstance(outcome, BaseException):
                raise outcome
            return io.BytesIO(outcome)
        with patch.object(common.urllib.request, 'urlopen', side_effect=open_url) as request, \
                patch.object(common.time, 'sleep'), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(parser._fetch_remote_section(self.url, 'dns'), ['no-system', 'server=1.1.1.1'])
        self.assertEqual(request.call_count, 3)
        self.assertIn(self.url, parser._url_cache)

    def test_invalid_include_stops_generation_before_existing_output_is_written(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'sync-config.txt'
            ini = root / 'qx.ini'
            output = root / 'Quantumult.conf'
            source.write_text('# Quantumult X\n>> Quantumult.conf\n# > Builtin\n<< qx.ini\n')
            ini.write_text('[general]\nmode=filter\n[dns]\n<< ' + self.url + '\n[policy]\n')
            output.write_text('last complete profile\n')
            with patch.object(parser, 'REPO_ROOT', root), patch.object(parser, 'SYNC_CONFIG_TXT', source), \
                    patch.object(parser, 'fetch_url', return_value='[general]\nmode=filter\n'):
                with self.assertRaisesRegex(RuntimeError, r'有效 \[dns\]'):
                    parser.parse_sync_txt()
            self.assertEqual(output.read_text(), 'last complete profile\n')


if __name__ == '__main__':
    unittest.main()
