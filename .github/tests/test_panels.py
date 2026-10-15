"""Ensure Stash configuration wires the shared scripts to the right contexts."""
from pathlib import Path
import contextlib
import io
import json
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
                            self.assertNotIn('ipqs_key', args)
                            self.assertNotIn('maxmind_key', args)
                            for key in ('risk_api', 'local_geoapi', 'remote_geoapi', 'mask_ip', 'tw_flag'):
                                self.assertEqual(args.get(key), params.get(key))
                            self.assertEqual(args.get('notify'), params.get('notify') if args.get('task') == 'monitor' else 'false')
                        else:
                            self.assertNotIn('geminiapikey', args)
                            self.assertEqual(args.get('notify'), params.get('notify') if args['service'] == 'monitor' else 'false')
                            self.assertEqual(args.get('nfprice'), params.get('nfprice') if args['service'] == 'netflix' else None)
                    if stem == 'ip-security-panel':
                        self.assertNotIn('panel_interval', config.get('arguments', {}))
                        for tile in config['tiles']:
                            self.assertIs(type(tile['interval']), int)
                            self.assertEqual(tile['interval'], int(params.get('panel_interval', 600)))

    def test_ip_stash_sync_removes_credentials_and_replaces_keyed_source_preferences(self):
        for remote in ('maxmind', 'maxmind-zh'):
            original = {'risk_api': 'ipqs', 'remote_geoapi': remote,
                        'ipqs_key': 'secret-one', 'maxmind_key': 'account:secret-two'}
            result = stash._stash_panel_argument(
                'tile=outbound&ipqs_key=old-key&maxmind_key=old-account', original, 'ip-security-panel')
            self.assertEqual(parse_qs(result.partition('&stash_options=')[0]), {'tile': ['outbound'], 'risk_api': ['ippure'], 'remote_geoapi': ['ipapi-zh']})
            self.assertEqual(original['risk_api'], 'ipqs')
            self.assertEqual(original['remote_geoapi'], remote)

    def test_native_forms_resolve_defaults_and_preserve_notification_contexts(self):
        for stem in ('ip-security-panel', 'media-check-panel'):
            config = yaml.safe_load((PANELS / (stem + '.stoverride')).read_text())
            self.assertEqual(config['arguments-version'], 1)
            values = {key: field.get('default') for key, field in config['arguments'].items()}
            self.assertNotIn('ipqs_key', values)
            self.assertNotIn('maxmind_key', values)
            self.assertNotIn('geminiapikey', values)
            for entry in config['tiles'] + config['cron']['script']:
                prefix, sep, suffix = entry['argument'].partition('&stash_options=')
                if not sep: continue
                rendered = re.sub(r'\$\{args\.(\w+)\|json\}',
                                  lambda match: json.dumps(values[match[1]]), suffix)
                options = json.loads(rendered)
                args = {k: v[0] for k, v in parse_qs(prefix).items()}
                if args.get('mode') == 'collapsed': self.assertNotIn('stash_api_secret', options)
                if args.get('task') != 'monitor' and args.get('service') != 'monitor':
                    self.assertNotIn('notify', options)
                if stem == 'ip-security-panel' and args.get('mode') != 'collapsed':
                    self.assertIs(options['stash_api'], False)
                    self.assertEqual(options['stash_api_secret'], '')
                for key, value in options.items():
                    if key.startswith('stash_api'): continue
                    self.assertEqual(str(value).lower(), args[key].lower())

    def test_panels_keep_numeric_fields_valid_without_form_expansion(self):
        # 旧客户端不会展开 ${args...}，但仍会把 interval/timeout 交给内核解析。
        for stem in ('ip-security-panel', 'media-check-panel'):
            config = yaml.safe_load((PANELS / (stem + '.stoverride')).read_text())
            for entry in [*config['tiles'], *config['script-providers'].values(), *config['cron']['script']]:
                for field in ('interval', 'timeout'):
                    if field in entry:
                        with self.subTest(stem=stem, name=entry.get('name'), field=field):
                            self.assertIs(type(entry[field]), int)
                            self.assertGreater(entry[field], 0)

    def test_mtproto_form_follows_surge_policies_and_keeps_typed_parameters(self):
        config = yaml.safe_load((ROOT / 'Surge/Module/Stash/MTProto.stoverride').read_text())
        fields = config['arguments']
        self.assertTrue(fields['dc_europe']['required'])
        self.assertEqual(fields['dc_europe']['default'], '🇩🇪 Germany')
        self.assertEqual(fields['port']['value-type'], 'integer')
        self.assertEqual(fields['port']['default'], 5753)
        self.assertFalse(fields['ipv6']['default'])
        self.assertRegex(fields['secret']['default'], r'^[0-9a-f]{32}$')
        self.assertEqual(config['mtproto']['port'], '${args.port}')
        self.assertEqual(config['mtproto']['ipv6'], '${args.ipv6}')
        self.assertTrue(all('${args.dc_' in rule for rule in config['rules']))
        self.assertNotIn('interface', config['mtproto'])

    def test_mtproto_defaults_sync_preserves_stash_semantics_and_source(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            module = root / 'Surge/Module'
            (module / 'Stash').mkdir(parents=True)
            target = module / 'Stash/MTProto.stoverride'
            original = (ROOT / 'Surge/Module/Stash/MTProto.stoverride').read_text()
            target.write_text(original)
            source = ('#!arguments=dc5-policy:Asia,dc1-policy:America,dc4-policy:Europe,'
                      'port:6789,secret:0123456789abcdef0123456789abcdef,interface:0.0.0.0,'
                      'ipv6:true,dc-config-url:https://example.com/dc.json\n[General]\n')
            (module / 'MTProto.sgmodule').write_text(source)
            with patch.object(stash, 'REPO_ROOT', root), contextlib.redirect_stdout(io.StringIO()):
                stash._sync_stash_mtproto()
                with patch.object(Path, 'write_text', side_effect=AssertionError('Unchanged output rewritten')):
                    stash._sync_stash_mtproto()
            config = yaml.safe_load(target.read_text())
            fields = config['arguments']
            expected = {'dc_asia': 'Asia', 'dc_america': 'America', 'dc_europe': 'Europe', 'port': 6789,
                        'secret': '0123456789abcdef0123456789abcdef', 'ipv6': False,
                        'dc_config_url': 'https://example.com/dc.json'}
            self.assertEqual({key: field['default'] for key, field in fields.items()}, expected)
            self.assertEqual(list(fields), list(expected))
            self.assertEqual(config['icon'], yaml.safe_load(original)['icon'])
            self.assertNotIn('interface', fields)
            self.assertEqual((module / 'MTProto.sgmodule').read_text(), source)
            self.assertEqual(config['rules'], yaml.safe_load(original)['rules'])
            self.assertIn('port=6789&secret=0123456789abcdef0123456789abcdef', target.read_text())

    def test_media_service_order_and_script_urls(self):
        config = yaml.safe_load((PANELS / 'media-check-panel.stoverride').read_text())
        expected = ['netflix', 'disney', 'hbomax', 'youtube', 'spotify', 'tiktok', 'chatgpt',
                    'claude', 'gemini', 'metaai', 'reddit']
        actual = [parse_qs(tile['argument'])['service'][0] for tile in config['tiles']]
        self.assertEqual(actual, expected)
        self.assertEqual(len({tile['name'] for tile in config['tiles']}), len(expected))
        self.assertTrue(all(tile['collapsed'] for tile in config['tiles']))
        for tile in config['tiles']:
            self.assertEqual(parse_qs(tile['argument'])['log'], ['shared'])
            provider = config['script-providers'][tile['name']]
            self.assertEqual(urlsplit(provider['url']).query, '')
            self.assertTrue(urlsplit(provider['url']).path.endswith('/Surge/Module/Scripts/media-check.js'))
        jobs = config['cron']['script']
        self.assertEqual(len(jobs), 2)
        monitor = next(job for job in jobs if parse_qs(job['argument'])['service'] == ['monitor'])
        collector = next(job for job in jobs if parse_qs(job['argument'])['service'] == ['logs'])
        self.assertEqual(monitor['cron'], '*/10 * * * *')
        self.assertEqual(parse_qs(monitor['argument'].partition('&stash_options=')[0]),
                         {'service': ['monitor'], 'notify': ['false'], 'log': ['shared']})
        self.assertEqual(collector['name'], 'hotkids-media-check')
        self.assertEqual(collector['cron'], '* * * * *')
        self.assertEqual(collector['timeout'], 5)
        self.assertEqual(parse_qs(collector['argument']), {'service': ['logs']})
        for job in jobs:
            self.assertNotIn(job['name'], [tile['name'] for tile in config['tiles']])
            provider = config['script-providers'][job['name']]
            self.assertEqual(urlsplit(provider['url']).query, '')
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
        self.assertNotIn('panel_interval', config['arguments'])
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
        supported = {'notify', 'risk_api', 'local_geoapi', 'remote_geoapi', 'mask_ip', 'tw_flag'}
        defaults = {key: [value] for key, value in (item.split(':', 1) for item in declaration.split(','))
                    if key in supported}
        self.assertEqual(parse_qs(monitor['argument'].partition('&stash_options=')[0], keep_blank_values=True), {
            'task': ['monitor'], 'log': ['shared'], **defaults})
        self.assertEqual(monitor['cron'], '*/10 * * * *')
        self.assertEqual(collector['name'], 'hotkids-ip-security')
        self.assertNotIn(collector['name'], [tile['name'] for tile in config['tiles']])
        self.assertEqual(collector['cron'], '* * * * *')
        self.assertEqual(collector['timeout'], 5)
        self.assertEqual(parse_qs(collector['argument']), {'task': ['logs']})
        for context in [*config['tiles'], *jobs]:
            provider = config['script-providers'][context['name']]
            self.assertEqual(urlsplit(provider['url']).query, '')
            self.assertTrue(urlsplit(provider['url']).path.endswith('/Surge/Module/Scripts/ip-security.js'))


if __name__ == '__main__':
    unittest.main()
