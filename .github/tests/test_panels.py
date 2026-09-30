"""Ensure Stash configuration wires the shared scripts to the right contexts."""
from pathlib import Path
import re
import unittest
from urllib.parse import parse_qs, urlsplit

import yaml

ROOT = Path(__file__).resolve().parents[2]
PANELS = ROOT / 'Surge/Module/Pannel'


class TileConfigurationTests(unittest.TestCase):
    def test_media_service_order_and_script_versions(self):
        config = yaml.safe_load((PANELS / 'media-check-panel.stoverride').read_text())
        expected = ['netflix', 'disney', 'hbomax', 'youtube', 'spotify', 'chatgpt',
                    'claude', 'gemini', 'metaai', 'tiktok', 'reddit']
        actual = [parse_qs(tile['argument'])['service'][0] for tile in config['tiles']]
        self.assertEqual(actual, expected)
        self.assertTrue(all(tile['collapsed'] for tile in config['tiles']))
        source = (ROOT / 'Surge/Module/Scripts/media-check.js').read_text()
        version = re.search(r'@version\s+([\d.]+)', source).group(1)
        for tile in config['tiles']:
            provider = config['script-providers'][tile['name']]
            self.assertEqual(parse_qs(urlsplit(provider['url']).query)['v'], [version])

    def test_ip_notification_context_is_separate_from_tiles(self):
        config = yaml.safe_load((PANELS / 'ip-security-panel.stoverride').read_text())
        self.assertEqual([parse_qs(t['argument'])['tile'][0] for t in config['tiles']],
                         ['outbound', 'local', 'risk'])
        for tile in config['tiles']:
            self.assertEqual(parse_qs(tile['argument'])['notify'], ['false'])
        jobs = config['cron']['script']
        self.assertEqual(len(jobs), 1)
        self.assertNotIn(jobs[0]['name'], [tile['name'] for tile in config['tiles']])
        self.assertEqual(parse_qs(jobs[0]['argument']), {'task': ['monitor'], 'notify': ['true']})
        self.assertEqual(jobs[0]['cron'], '*/10 * * * *')
        source = (ROOT / 'Surge/Module/Scripts/ip-security.js').read_text()
        version = re.search(r'@version\s+([\d.]+)', source).group(1)
        for context in [*config['tiles'], *jobs]:
            provider = config['script-providers'][context['name']]
            self.assertEqual(parse_qs(urlsplit(provider['url']).query)['v'], [version])


if __name__ == '__main__':
    unittest.main()
