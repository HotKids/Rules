"""Offline coverage for bounded upstream retries and shared content writes."""
import contextlib
from email.utils import formatdate
import importlib.util
import io
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / '.github/scripts'))
import _common as common


class RetryTests(unittest.TestCase):
    def request(self, outcomes, **kwargs):
        responses = iter(outcomes)
        clock = [0.0]
        waits, timeouts = [], []

        def sleep(delay):
            waits.append(delay)
            clock[0] += delay

        def open_url(request, *, timeout):
            timeouts.append(timeout)
            outcome = next(responses)
            if isinstance(outcome, BaseException):
                raise outcome
            if callable(outcome):
                outcome = outcome(clock)
            return io.BytesIO(outcome)

        with patch.object(common.urllib.request, 'urlopen', side_effect=open_url), \
                patch.object(common.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(common.time, 'sleep', side_effect=sleep), \
                contextlib.redirect_stderr(io.StringIO()):
            result = common.fetch_url('https://example.invalid/list', 'test', **kwargs)
        return result, waits, timeouts

    def test_empty_and_transport_failure_recover_without_partial_content(self):
        text, waits, _ = self.request([b' \n', TimeoutError('fixture timeout'), b'complete\n'])
        self.assertEqual(text, 'complete\n')
        self.assertEqual(waits, [1, 2])

    def test_retry_after_seconds_date_cap_and_invalid_header(self):
        for retry_after, expected in [('7', 7), ('999999', 30), ('invalid', 1), ('0', 0)]:
            with self.subTest(header=retry_after):
                error = urllib.error.HTTPError('https://example.invalid/list', 429, 'busy',
                                                {'Retry-After': retry_after}, None)
                result, waits, _ = self.request([error, b'recovered'])
                self.assertEqual(result, 'recovered')
                self.assertEqual(waits, [expected])
        now = 1800000000
        error = urllib.error.HTTPError('https://example.invalid/list', 503, 'busy',
                                       {'Retry-After': formatdate(now + 12, usegmt=True)}, None)
        with patch.object(common.time, 'time', return_value=now):
            _, waits, _ = self.request([error, b'recovered'])
        self.assertEqual(waits, [12])

    def test_http_404_and_bad_utf8_never_retry(self):
        for error in [urllib.error.HTTPError('https://example.invalid/list', 404, 'missing', {}, None),
                      UnicodeDecodeError('utf-8', b'\xff', 0, 1, 'invalid')]:
            with self.subTest(error=type(error).__name__), \
                    patch.object(common.urllib.request, 'urlopen', side_effect=error) as request, \
                    patch.object(common.time, 'sleep') as sleep:
                with self.assertRaises(common.DownloadError) as caught:
                    common.fetch_url('https://example.invalid/list', 'test')
                self.assertEqual(request.call_count, 1)
                sleep.assert_not_called()
                self.assertEqual(caught.exception.status, 404 if isinstance(error, urllib.error.HTTPError) else None)

    def test_time_budget_reduces_request_timeout_and_cannot_wait_past_deadline(self):
        _, waits, timeouts = self.request([TimeoutError('retry'), b'ok'], timeout=10, total_timeout=3)
        self.assertEqual(waits, [1])
        self.assertEqual(timeouts, [3, 2])
        error = urllib.error.HTTPError('https://example.invalid/list', 429, 'busy', {'Retry-After': '10'}, None)
        with patch.object(common.urllib.request, 'urlopen', side_effect=error) as request, \
                patch.object(common.time, 'monotonic', return_value=0), \
                patch.object(common.time, 'sleep') as sleep:
            with self.assertRaises(common.DownloadError) as caught:
                common.fetch_url('https://example.invalid/list', 'test', total_timeout=3)
            self.assertEqual(caught.exception.status, 429)
            self.assertEqual(request.call_count, 1)
            sleep.assert_not_called()

    def test_successful_response_after_deadline_is_rejected(self):
        def late(clock):
            clock[0] += 4
            return b'late content'
        with self.assertRaisesRegex(common.DownloadError, 'time budget exhausted'):
            self.request([late], total_timeout=3)

    def test_errors_and_retry_logs_hide_url_credentials_and_query_values(self):
        url = 'https://username:password@example.invalid/list?token=private-value#secret-fragment'
        reason = 'failed ' + url
        stderr = io.StringIO()
        with patch.object(common.urllib.request, 'urlopen', side_effect=TimeoutError(reason)), \
                patch.object(common.time, 'sleep'), contextlib.redirect_stderr(stderr):
            with self.assertRaises(common.DownloadError) as caught:
                common.fetch_url(url, 'test')
        self.assertEqual(caught.exception.url, url)  # Callers can still identify/deduplicate the source.
        output = str(caught.exception) + stderr.getvalue()
        for secret in ('username', 'password', 'private-value', 'secret-fragment'):
            self.assertNotIn(secret, output)
        self.assertIn('https://example.invalid/list?[redacted]', output)


class SharedHelperTests(unittest.TestCase):
    def test_normalized_write_keeps_old_timestamp_but_publishes_changed_body(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'generated.txt'
            old = '# Date: yesterday\nrule-one\n'
            path.write_text(old)
            patterns = (re.compile(r'^# Date:.*$', re.M),)
            self.assertFalse(common.write_if_changed(path, '# Date: today\nrule-one\n', normalize_patterns=patterns))
            self.assertEqual(path.read_text(), old)
            self.assertTrue(common.write_if_changed(path, '# Date: today\nrule-two\n', normalize_patterns=patterns))
            self.assertEqual(path.read_text(), '# Date: today\nrule-two\n')
            self.assertTrue(common.write_if_changed(path, '# Date: tomorrow\nrule-two\n'))

    def test_yaml_loader_preserves_safe_semantics_and_falls_back_without_libyaml(self):
        spec = importlib.util.spec_from_file_location('validation_loader_test', ROOT / '.github/scripts/validate.py')
        validation = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(validation)
        fixture = 'defaults: &defaults {enabled: true, list: [one, two]}\nconfig: {<<: *defaults, name: 测试}\n'
        expected = yaml.safe_load(fixture)
        self.assertEqual(validation.load_yaml(fixture), expected)
        with self.assertRaises(yaml.YAMLError):
            validation.load_yaml('danger: !!python/object/apply:os.system ["not executed"]')
        with patch.dict(yaml.__dict__):
            yaml.__dict__.pop('CSafeLoader', None)
            fallback = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(fallback)
            self.assertIs(fallback.YAML_LOADER, yaml.SafeLoader)
            self.assertEqual(fallback.load_yaml(fixture), expected)

    def test_first_only_normalization_keeps_later_date_content_significant(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'generated.txt'
            old = '# Date: generated yesterday\n# Date: upstream-one\nrule\n'
            path.write_text(old)
            patterns = (re.compile(r'^# Date:.*$', re.M),)
            same_body = '# Date: generated today\n# Date: upstream-one\nrule\n'
            self.assertFalse(common.write_if_changed(path, same_body,
                             normalize_patterns=patterns, normalize_count=1))
            self.assertEqual(path.read_text(), old)
            changed_body = '# Date: generated today\n# Date: upstream-two\nrule\n'
            self.assertTrue(common.write_if_changed(path, changed_body,
                            normalize_patterns=patterns, normalize_count=1))
            self.assertEqual(path.read_text(), changed_body)


if __name__ == '__main__':
    unittest.main()
