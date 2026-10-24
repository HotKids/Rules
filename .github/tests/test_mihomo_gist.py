"""Private Gist publication uses mock HTTP only; no credentials or user data."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import yaml


SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location('publish_mihomo_gist', SCRIPTS / 'publish-mihomo-gist.py')
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)


class PrivateGistTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.config = Path(temporary.name) / 'mihomo.yaml'
        self.config.write_text(
            'proxies: []\n'
            'proxy-providers: {Server: {type: http, url: https://example.invalid/sub}}\n'
            '# ── 策略组 ──\n'
            'proxy-groups:\n'
            '  - {name: Pool, type: select, include-all-providers: true}\n'
            '# ── 规则集 ──\n'
            'rule-providers: {}\n'
            'rules:\n'
            '  - MATCH,Pool\n')
        self.manual = (
            'proxies: # keep manual formatting\n'
            '  # local node note\n'
            '  - name: Manual test node\n'
            '    type: socks5\n'
            '    server: example.invalid\n'
            '    port: 1080\n')
        self.providers = (
            'proxy-providers: # keep my source\n'
            '  Personal:\n'
            '    type: http\n'
            '    url: "https://example.invalid/private?token=test-only"\n'
            '    interval: 4321\n')
        environment = patch.dict(os.environ, {'MIHOMO_GIST_ID': 'a' * 32, 'GIST_TOKEN': 'dummy-test-token'})
        environment.start()
        self.addCleanup(environment.stop)

    def gist(self, **changes):
        return {'public': False, 'files': {
            'mihomo.yaml': {'content': self.manual + self.providers + 'rules: []\n', 'truncated': False},
            'other.yaml': {'content': 'keep this file'},
        }, **changes}

    def response(self, payload):
        return io.BytesIO(json.dumps(payload).encode())

    def test_update_only_the_requested_file_without_changing_visibility(self):
        with patch.object(publisher.urllib.request, 'urlopen', side_effect=[
            self.response(self.gist()), self.response(self.gist()),
        ]) as request:
            self.assertTrue(publisher.publish(self.config))
        self.assertEqual(request.call_count, 2)
        update = request.call_args_list[1].args[0]
        self.assertEqual(update.get_method(), 'PATCH')
        payload = json.loads(update.data)
        self.assertEqual(set(payload), {'files'})
        self.assertEqual(set(payload['files']), {'mihomo.yaml'})
        content = payload['files']['mihomo.yaml']['content']
        self.assertIn(self.manual, content)
        self.assertIn(self.providers, content)
        parsed = yaml.safe_load(content)
        self.assertEqual(parsed['proxies'][0]['name'], 'Manual test node')
        self.assertEqual(parsed['proxy-providers'], yaml.safe_load(self.providers)['proxy-providers'])
        self.assertIn('Manual test node', parsed['proxy-groups'][0]['proxies'])

    def test_identical_configuration_does_not_publish_again(self):
        gist = self.gist()
        gist['files']['mihomo.yaml']['content'] = publisher._apply_manual_proxies(
            self.config.read_text(), gist['files']['mihomo.yaml']['content'])
        with patch.object(publisher.urllib.request, 'urlopen', return_value=self.response(gist)) as request:
            self.assertFalse(publisher.publish(self.config))
        self.assertEqual(request.call_count, 1)

    def test_explicit_inline_migration_moves_nodes_and_remains_idempotent(self):
        gist = self.gist()
        with patch.object(publisher.urllib.request, 'urlopen', side_effect=[
            self.response(gist), self.response(self.gist()),
        ]) as request:
            self.assertTrue(publisher.publish(self.config, migrate_inline=True))
        content = json.loads(request.call_args_list[1].args[0].data)['files']['mihomo.yaml']['content']
        data = yaml.safe_load(content)
        self.assertEqual(data['proxies'], [])
        self.assertEqual(data['proxy-providers']['Manual']['payload'][0]['name'], 'Manual test node')
        self.assertEqual(data['proxy-providers']['Personal'], yaml.safe_load(self.providers)['proxy-providers']['Personal'])
        self.assertNotIn('Manual test node', data['proxy-groups'][0].get('proxies', []))
        gist['files']['mihomo.yaml']['content'] = content
        with patch.object(publisher.urllib.request, 'urlopen', return_value=self.response(gist)) as request:
            self.assertFalse(publisher.publish(self.config, migrate_inline=True))
        self.assertEqual(request.call_count, 1)

    def test_invalid_manual_proxies_abort_without_logging_node_data(self):
        gist = self.gist(files={'mihomo.yaml': {'content': 'proxies: [private-node-value\n', 'truncated': False}})
        output = io.StringIO()
        with patch.object(publisher.urllib.request, 'urlopen', return_value=self.response(gist)) as request, contextlib.redirect_stderr(output):
            self.assertEqual(publisher.main([str(self.config)]), 1)
        self.assertEqual(request.call_count, 1)
        self.assertNotIn('private-node-value', output.getvalue())
        self.assertIn('no changes published', output.getvalue())

    def test_invalid_manual_providers_abort_without_logging_source_details(self):
        for providers in ('proxy-providers: [private-provider-value\n',
                          'proxy-providers: [private-provider-value]\n',
                          'proxy-providers: {}\nproxy-providers: {}\n'):
            gist = self.gist(files={'mihomo.yaml': {'content': self.manual + providers, 'truncated': False}})
            output = io.StringIO()
            with self.subTest(providers=providers), patch.object(publisher.urllib.request, 'urlopen', return_value=self.response(gist)) as request, contextlib.redirect_stderr(output):
                self.assertEqual(publisher.main([str(self.config)]), 1)
            self.assertEqual(request.call_count, 1)
            self.assertNotIn('private-provider-value', output.getvalue())
            self.assertIn('no changes published', output.getvalue())

    def test_existing_errors_outside_manual_proxies_do_not_block_preservation(self):
        gist = self.gist(files={'mihomo.yaml': {
            'content': self.manual + 'rules:\n  - [invalid-old-rule\n', 'truncated': False}})
        with patch.object(publisher.urllib.request, 'urlopen', side_effect=[
            self.response(gist), self.response(self.gist()),
        ]) as request:
            self.assertTrue(publisher.publish(self.config))
        content = json.loads(request.call_args_list[1].args[0].data)['files']['mihomo.yaml']['content']
        self.assertIn(self.manual, content)
        self.assertEqual(yaml.safe_load(content)['rules'], ['MATCH,Pool'])

    def test_user_owned_empty_proxies_block_is_preserved(self):
        manual = 'proxies: [] # user owned\n'
        gist = self.gist(files={'mihomo.yaml': {'content': manual + 'rules: []\n', 'truncated': False}})
        with patch.object(publisher.urllib.request, 'urlopen', side_effect=[
            self.response(gist), self.response(self.gist()),
        ]) as request:
            self.assertTrue(publisher.publish(self.config))
        content = json.loads(request.call_args_list[1].args[0].data)['files']['mihomo.yaml']['content']
        self.assertIn(manual, content)
        self.assertEqual(yaml.safe_load(content)['proxies'], [])

    def test_blank_provider_value_is_preserved_without_filling_the_default(self):
        manual = self.manual + 'proxy-providers: # left blank by user\n'
        gist = self.gist(files={'mihomo.yaml': {'content': manual + 'rules: []\n', 'truncated': False}})
        with patch.object(publisher.urllib.request, 'urlopen', side_effect=[
            self.response(gist), self.response(self.gist()),
        ]) as request:
            self.assertTrue(publisher.publish(self.config))
        content = json.loads(request.call_args_list[1].args[0].data)['files']['mihomo.yaml']['content']
        self.assertIn(manual, content)
        self.assertIsNone(yaml.safe_load(content)['proxy-providers'])
        self.assertNotIn('https://example.invalid/sub', content)

    def test_public_or_unverifiable_target_never_receives_a_patch(self):
        for gist in (self.gist(public=True), self.gist(public=None), self.gist(files={}),
                     self.gist(files={'mihomo.yaml': {'content': 'partial', 'truncated': True}})):
            with self.subTest(gist=gist), patch.object(publisher.urllib.request, 'urlopen', return_value=self.response(gist)) as request:
                with self.assertRaises(publisher.PublishError):
                    publisher.publish(self.config)
                self.assertEqual(request.call_count, 1)

    def test_missing_secrets_or_empty_configuration_do_not_make_requests(self):
        with patch.object(publisher.urllib.request, 'urlopen') as request:
            with patch.dict(os.environ, {'GIST_TOKEN': ''}):
                with self.assertRaises(publisher.PublishError):
                    publisher.publish(self.config)
            self.config.write_text(' \n')
            with self.assertRaises(publisher.PublishError):
                publisher.publish(self.config)
            request.assert_not_called()

    def test_http_failure_logs_no_url_token_or_response_body(self):
        error = urllib.error.HTTPError('https://api.github.com/gists/' + 'a' * 32, 403,
                                       'dummy-test-token private response', {}, None)
        output = io.StringIO()
        with patch.object(publisher.urllib.request, 'urlopen', side_effect=error), contextlib.redirect_stderr(output):
            self.assertEqual(publisher.main([str(self.config)]), 1)
        self.assertIn('HTTP 403', output.getvalue())
        for sensitive in ('a' * 32, 'https://', 'dummy-test-token', 'private response'):
            self.assertNotIn(sensitive, output.getvalue())


if __name__ == '__main__':
    unittest.main()
