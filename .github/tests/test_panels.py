"""Ensure Stash configuration wires the shared scripts to the right contexts."""
from pathlib import Path
import contextlib
import io
import re
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import yaml

ROOT = Path(__file__).resolve().parents[2]
PANELS = ROOT / 'Surge/Module/Pannel'
sys.path.insert(0, str(ROOT / '.github/scripts'))
from config_sync import stash


class TileConfigurationTests(unittest.TestCase):
    def test_panel_metadata_tracks_surge_edits_without_changing_tiles(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            panels = root / 'Surge/Module/Pannel'
            panels.mkdir(parents=True)
            originals = {}
            arguments = {}
            for stem in ('ip-security-panel', 'media-check-panel'):
                text = (PANELS / (stem + '.stoverride')).read_text()
                (panels / (stem + '.stoverride')).write_text(text)
                config = yaml.safe_load(text)
                for key in ('category', 'icon'):
                    config.pop(key, None)
                originals[stem] = (config, text[text.index('tiles:'):])
                arguments[stem] = next(line for line in (PANELS / (stem + '.sgmodule')).read_text().splitlines()
                                       if line.startswith('#!arguments='))
            (panels / 'surge-only.sgmodule').write_text('#!category=HotKids\n[Panel]\n')
            for metadata in ({'category': 'HotKids'},
                             {'category': "HotKids: user's #panels", 'icon': 'https://example.com/a.png?v=1'},
                             {'category': 'HotKids', 'icon': 'https://example.com/b.png'},
                             {'category': '', 'icon': ''}, {}):
                with self.subTest(metadata=metadata):
                    source = ''.join(f'#!{k}={v}\n' for k, v in metadata.items())
                    sources = {}
                    for stem in originals:
                        sources[stem] = source + arguments[stem] + '\n[Panel]\nPanel = icon=play.circle.fill\n'
                        (panels / (stem + '.sgmodule')).write_text(sources[stem])
                    with patch.object(stash, 'REPO_ROOT', root), contextlib.redirect_stdout(io.StringIO()):
                        stash._sync_stash_panel_metadata()
                        with patch.object(Path, 'write_text', side_effect=AssertionError('Unchanged output rewritten')):
                            stash._sync_stash_panel_metadata()
                    for stem, (original, tiles) in originals.items():
                        text = (panels / (stem + '.stoverride')).read_text()
                        actual = yaml.safe_load(text)
                        self.assertEqual(actual, {**original, **{k: v for k, v in metadata.items() if v}})
                        self.assertEqual(text[text.index('tiles:'):], tiles)
                        self.assertEqual((panels / (stem + '.sgmodule')).read_text(), sources[stem])
                    self.assertFalse((panels / 'surge-only.stoverride').exists())

    def test_panel_defaults_follow_source_without_changing_task_contexts(self):
        defaults = {
            'ip-security-panel': {'risk_api': 'proxycheck', 'local_geoapi': 'ipsb', 'remote_geoapi': 'ipinfo',
                                  'ipqs_key': 'null', 'maxmind_key': 'account:key+with&equals=', 'mask_ip': '2',
                                  'tw_flag': 'tw', 'notify': 'false', 'event_delay': '30', 'panel_interval': '20'},
            'media-check-panel': {'nfprice': 'false', 'geminiapikey': 'key+with&equals=', 'notify': 'true', 'viu': 'true'}
        }
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            panels = root / 'Surge/Module/Pannel'
            panels.mkdir(parents=True)
            for stem in defaults:
                (panels / (stem + '.stoverride')).write_text((PANELS / (stem + '.stoverride')).read_text())
            for values in (defaults, {stem: {} for stem in defaults}):
                for stem, params in values.items():
                    source = '#!arguments=' + ','.join(f'{k}:{v}' for k, v in params.items()) + '\n[Panel]\n'
                    (panels / (stem + '.sgmodule')).write_text(source)
                with patch.object(stash, 'REPO_ROOT', root), contextlib.redirect_stdout(io.StringIO()):
                    stash._sync_stash_panel_metadata()
                for stem, params in values.items():
                    config = yaml.safe_load((panels / (stem + '.stoverride')).read_text())
                    for entry in config['tiles'] + config['cron']['script']:
                        args = {k: v[0] for k, v in parse_qs(entry['argument'], keep_blank_values=True).items()}
                        for key in ('event_delay', 'panel_interval', 'viu'):
                            self.assertNotIn(key, args)
                        if args.get('task') == 'logs' or args.get('service') == 'logs':
                            self.assertEqual(args, {'task': 'logs'} if stem == 'ip-security-panel' else {'service': 'logs'})
                            continue
                        if stem == 'ip-security-panel':
                            for key in ('risk_api', 'local_geoapi', 'remote_geoapi', 'ipqs_key', 'maxmind_key', 'mask_ip', 'tw_flag'):
                                self.assertEqual(args.get(key), params.get(key))
                            self.assertEqual(args.get('notify'), params.get('notify') if args.get('task') == 'monitor' else 'false')
                        else:
                            self.assertEqual(args['notify'], 'false')
                            for key, service in (('nfprice', 'netflix'), ('geminiapikey', 'gemini')):
                                self.assertEqual(args.get(key), params.get(key) if args['service'] == service else None)

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
        declaration = next(line.removeprefix('#!arguments=')
                           for line in (PANELS / 'ip-security-panel.sgmodule').read_text().splitlines()
                           if line.startswith('#!arguments='))
        supported = {'notify', 'risk_api', 'local_geoapi', 'remote_geoapi', 'ipqs_key', 'maxmind_key', 'mask_ip', 'tw_flag'}
        defaults = {key: [value] for key, value in (item.split(':', 1) for item in declaration.split(','))
                    if key in supported}
        self.assertEqual(parse_qs(monitor['argument'], keep_blank_values=True), {
            'task': ['monitor'], 'log': ['shared'], **defaults})
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
