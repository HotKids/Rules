"""Standalone Stash generation reuses private node data without public output."""
import importlib.util
from pathlib import Path
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('render_stash_gist', ROOT / '.github/scripts/render-stash-gist.py')
renderer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(renderer)


class StashGistTests(unittest.TestCase):
    def setUp(self):
        self.base = (ROOT / 'Clash/Script/MyStash.stoverride').read_text()
        self.nodes = [
            {'name': 'HK test', 'type': 'snell', 'server': 'example.invalid', 'port': 443,
             'psk': 'test-only # :', 'version': 5, 'udp': True, 'tfo': True},
            {'name': 'JP test', 'type': 'snell', 'server': 'example.invalid', 'port': 8443,
             'psk': 'test-only', 'version': 5, 'dialer-proxy': 'HK test'},
        ]

    def test_inline_payload_becomes_single_line_nodes_with_template_settings_unchanged(self):
        source = {'proxies': [], 'proxy-providers': {'Manual': {'type': 'inline', 'payload': self.nodes,
                   'health-check': {'enable': True, 'interval': 600}}}}
        text = renderer.render(self.base, yaml.safe_dump(source, allow_unicode=True))
        actual = yaml.safe_load(text)
        self.assertEqual(actual['proxies'], self.nodes)
        self.assertNotIn('proxy-providers', actual)
        for key in ('name', 'desc', 'author', 'category', 'icon'):
            self.assertNotIn(key, actual)
        self.assertNotIn('#!replace', text)
        self.assertNotIn('https://sub.hotkids.me', text)
        actual.pop('proxies')
        expected = yaml.safe_load(self.base)
        for key in ('name', 'desc', 'author', 'category', 'icon'):
            expected.pop(key, None)
        self.assertEqual(actual, expected)
        tree = yaml.compose(text)
        sequence = next(value for key, value in tree.value if key.value == 'proxies')
        self.assertEqual(len(sequence.value), 2)
        self.assertTrue(all(node.flow_style and node.start_mark.line == node.end_mark.line
                            for node in sequence.value))
        self.assertEqual(renderer.render(self.base, yaml.safe_dump(source, allow_unicode=True)), text)

    def test_top_nodes_and_multiple_inline_sources_preserve_order_and_identical_duplicates(self):
        source = {'proxies': self.nodes[:1], 'proxy-providers': {
            'A': {'type': 'inline', 'payload': self.nodes},
            'B': {'type': 'inline', 'payload': []}}}
        actual = yaml.safe_load(renderer.render(self.base, yaml.safe_dump(source)))
        self.assertEqual(actual['proxies'], self.nodes)
        source['proxy-providers']['A']['payload'][0] = {**self.nodes[0], 'psk': 'different-test'}
        with self.assertRaisesRegex(ValueError, 'Conflicting duplicate'):
            renderer.render(self.base, yaml.safe_dump(source))

    def test_http_provider_uses_stash_headers_and_leaves_group_health_checks_to_template(self):
        source = {'proxies': self.nodes, 'proxy-providers': {'Remote': {
            'type': 'http', 'url': 'https://example.invalid/private?token=test-only', 'interval': 1234,
            'header': {'Authorization': ['Bearer test-only']},
            'health-check': {'enable': True, 'url': 'https://example.invalid/check'}}}}
        actual = yaml.safe_load(renderer.render(self.base, yaml.safe_dump(source)))
        self.assertEqual(actual['proxies'], self.nodes)
        self.assertEqual(actual['proxy-providers']['Remote'], {
            'url': 'https://example.invalid/private?token=test-only', 'interval': 1234,
            'headers': {'Authorization': ['Bearer test-only']}})

    def test_unsupported_sources_fail_without_silently_losing_nodes(self):
        for provider in ({'type': 'file', 'path': './unavailable.yaml'},
                         {'type': 'inline', 'payload': {}},
                         {'type': 'inline', 'payload': False},
                         {'type': 'inline', 'payload': self.nodes, 'override': {'udp': False}},
                         {'type': 'inline', 'payload': self.nodes, 'filter': 'HK'}):
            with self.subTest(provider=provider), self.assertRaises(ValueError):
                renderer.render(self.base, yaml.safe_dump({'proxy-providers': {'Manual': provider}}))


if __name__ == '__main__':
    unittest.main()
