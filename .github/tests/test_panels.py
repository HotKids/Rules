"""Ensure Stash configuration wires the shared scripts to the right contexts."""
from pathlib import Path
import re
import unittest
from urllib.parse import parse_qs, urlsplit

import yaml

ROOT = Path(__file__).resolve().parents[2]
PANELS = ROOT / 'Surge/Module/Pannel'


class TileConfigurationTests(unittest.TestCase):
    def test_media_service_order_and_script_urls(self):
        config = yaml.safe_load((PANELS / 'media-check-panel.stoverride').read_text())
        expected = ['netflix', 'disney', 'hbomax', 'youtube', 'spotify', 'tiktok', 'chatgpt',
                    'claude', 'gemini', 'metaai', 'reddit']
        actual = [parse_qs(tile['argument'])['service'][0] for tile in config['tiles']]
        self.assertEqual(actual, expected)
        self.assertEqual(len({tile['name'] for tile in config['tiles']}), len(expected))
        self.assertTrue(all(tile['collapsed'] for tile in config['tiles']))
        version = re.search(r'@version\s+([\d.]+)', (ROOT / 'Surge/Module/Scripts/media-check.js').read_text()).group(1)
        for tile in config['tiles']:
            self.assertEqual(parse_qs(tile['argument'])['log'], ['shared'])
            provider = config['script-providers'][tile['name']]
            self.assertEqual(parse_qs(urlsplit(provider['url']).query), {'v': [version]})
            self.assertTrue(urlsplit(provider['url']).path.endswith('/Surge/Module/Scripts/media-check.js'))
        jobs = config['cron']['script']
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]['name'], 'hotkids-media-check')
        self.assertNotIn(jobs[0]['name'], [tile['name'] for tile in config['tiles']])
        self.assertEqual(jobs[0]['cron'], '* * * * *')
        self.assertEqual(jobs[0]['timeout'], 5)
        self.assertEqual(parse_qs(jobs[0]['argument']), {'service': ['logs']})
        provider = config['script-providers'][jobs[0]['name']]
        self.assertEqual(parse_qs(urlsplit(provider['url']).query), {'v': [version]})
        self.assertTrue(urlsplit(provider['url']).path.endswith('/Surge/Module/Scripts/media-check.js'))

    def test_ip_notification_context_is_separate_from_tiles(self):
        config = yaml.safe_load((PANELS / 'ip-security-panel.stoverride').read_text())
        self.assertEqual([parse_qs(t['argument'])['tile'][0] for t in config['tiles']],
                         ['summary', 'outbound', 'local', 'risk'])
        home, *collapsed = config['tiles']
        self.assertFalse(home['collapsed'])
        self.assertEqual(home['title'], 'IP 信息卡')
        self.assertEqual(home['icon'], 'https://ippure.com/logo.png')
        self.assertEqual(parse_qs(home['argument'])['mode'], ['home'])
        self.assertEqual(home['interval'], 600)
        self.assertTrue(all(tile['collapsed'] for tile in collapsed))
        self.assertTrue(all(parse_qs(tile['argument'])['mode'] == ['collapsed'] for tile in collapsed))
        for tile in config['tiles']:
            self.assertEqual(parse_qs(tile['argument'])['notify'], ['false'])
            self.assertEqual(parse_qs(tile['argument'])['log'], ['shared'])
        jobs = config['cron']['script']
        self.assertEqual(len(jobs), 2)
        monitor = next(job for job in jobs if parse_qs(job['argument'])['task'] == ['monitor'])
        collector = next(job for job in jobs if parse_qs(job['argument'])['task'] == ['logs'])
        self.assertNotIn(monitor['name'], [tile['name'] for tile in config['tiles']])
        self.assertEqual(parse_qs(monitor['argument']), {'task': ['monitor'], 'notify': ['true'], 'log': ['shared']})
        self.assertEqual(monitor['cron'], '*/10 * * * *')
        self.assertEqual(collector['name'], 'hotkids-ip-security')
        self.assertNotIn(collector['name'], [tile['name'] for tile in config['tiles']])
        self.assertEqual(collector['cron'], '* * * * *')
        self.assertEqual(collector['timeout'], 5)
        self.assertEqual(parse_qs(collector['argument']), {'task': ['logs']})
        version = re.search(r'@version ([\d.]+)', (ROOT / 'Surge/Module/Scripts/ip-security.js').read_text()).group(1)
        for context in [*config['tiles'], *jobs]:
            provider = config['script-providers'][context['name']]
            self.assertEqual(parse_qs(urlsplit(provider['url']).query), {'v': [version]})
            self.assertTrue(urlsplit(provider['url']).path.endswith('/Surge/Module/Scripts/ip-security.js'))


if __name__ == '__main__':
    unittest.main()
