"""Personal YAML must preserve editable nodes and existing overlay behavior."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / '.github/scripts'))
spec = importlib.util.spec_from_file_location('render_mihomo_overlay', ROOT / '.github/scripts/render-mihomo-overlay.py')
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


class MihomoOverlayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = (ROOT / 'Clash/Mihomo.yaml').read_text()
        cls.overlay = json.loads((ROOT / '.github/scripts/sync-config/Enhanced/myscript.overlay.json').read_text())
        cls.rendered = renderer.render(cls.base, cls.overlay, 'myscript.overlay.json')

    def test_native_yaml_matches_existing_personal_script_with_inline_nodes(self):
        names = ['US GoMaMi', 'HK HKT', 'HK Pro', 'TW Main', 'TW Neburst Pro',
                 'SG Main', 'SG Pro', 'JP Main', 'JP Pro', 'US Main', 'DE Main', 'DE Pro', 'UK Main']
        nodes = [{'name': name, 'type': 'socks5', 'server': 'example.invalid', 'port': 1080} for name in names]
        manual = yaml.safe_dump({'proxies': nodes}, allow_unicode=True, sort_keys=False)
        actual = yaml.safe_load(renderer.apply_manual_proxies(self.rendered, manual))
        js = '''const fs = require('fs'), vm = require('vm');
const context = {input: JSON.parse(fs.readFileSync(0, 'utf8'))};
vm.createContext(context);
vm.runInContext(fs.readFileSync(process.argv[1], 'utf8') + '\\nresult = main(input);', context);
process.stdout.write(JSON.stringify(context.result));'''
        result = subprocess.run(['node', '-e', js, str(ROOT / 'Clash/Script/MyScript.js')],
                                input=json.dumps({'proxies': nodes}), capture_output=True, text=True, check=True)
        expected = json.loads(result.stdout)
        groups = [{k: v for k, v in g.items() if k not in ('include-all-providers', 'filter')}
                  for g in actual['proxy-groups']]
        self.assertEqual({g['name']: g for g in groups}, {g['name']: g for g in expected['proxy-groups']})
        self.assertEqual(actual['rules'], expected['rules'])
        self.assertEqual(actual['rule-providers'], expected['rule-providers'])
        self.assertEqual(actual['proxies'], nodes)
        self.assertEqual(actual['proxy-providers'], yaml.safe_load(self.base)['proxy-providers'])

    def test_region_and_relay_anchors_stay_in_header_after_manual_node_merge(self):
        merged = renderer.apply_manual_proxies(self.rendered,
            'proxies:\n- {name: HK Pro, type: socks5, server: example.invalid, port: 1080}\n')
        for text in (self.rendered, merged):
            tokens = list(yaml.scan(text))
            anchors = {t.value: t.start_mark.index for t in tokens if isinstance(t, yaml.AnchorToken)}
            references = [t for t in tokens if isinstance(t, yaml.AliasToken) and t.value.startswith('Filter')]
            self.assertEqual(len(references), 13)
            self.assertIn('FilterHKRelay', anchors)
            self.assertIn('FilterRelay', anchors)
            for reference in references:
                self.assertLess(anchors[reference.value], text.index('\nproxies:'))
            self.assertEqual(text.count('&FilterHKRelay '), 1)
            self.assertIn('filter: *FilterHKRelay', text)
            self.assertNotRegex(text, r'(?m)^  - \{.*filter: [^*]')
            data = yaml.safe_load(text)
            groups = {g['name']: g for g in data['proxy-groups']}
            for spec in self.overlay['extra_pool_groups']:
                self.assertEqual(groups[spec['name']]['filter'], spec['filter'])

    def test_relay_section_follows_nodes_and_precedes_area(self):
        for text in (self.rendered, renderer.apply_manual_proxies(self.rendered, 'proxies: []\n')):
            self.assertEqual(text.count('  # Relay\n'), 1)
            nodes = text.index('  # Nodes\n')
            relay = text.index('  # Relay\n')
            area = text.index('  # Area\n')
            self.assertLess(nodes, relay)
            self.assertLess(relay, area)
            names = [g['name'] for g in yaml.safe_load(text)['proxy-groups']]
            expected = ['🇸🇱 Relay', '🇭🇰 HK Relay', '🇨🇳 TW Relay', '🇯🇵 JP Relay', '🇺🇸 US Relay', '🇪🇺 EU Relay']
            server = names.index('🇺🇳 Server')
            self.assertEqual(names[server + 1:server + 7], expected)
            self.assertEqual(names[server + 7], '🇭🇰 Hong Kong')

    def test_manual_block_survives_sync_even_if_old_generated_rules_are_invalid(self):
        block = 'proxies:  # user-managed\n  - {name: HK HKT, type: socks5, server: example.invalid, port: 1080, password: "private-test"}\n'
        existing = block + 'rules:\n  - "invalid quote\n'
        merged = renderer.apply_manual_proxies(self.rendered, existing)
        self.assertIn(block, merged)
        self.assertEqual(renderer.apply_manual_proxies(self.rendered, merged), merged)
        self.assertEqual(renderer.render(self.base, self.overlay, 'myscript.overlay.json'), self.rendered)
        self.assertEqual((ROOT / 'Clash/Mihomo.yaml').read_text(), self.base)

    def test_empty_manual_list_and_later_removal_are_preserved(self):
        old = renderer.apply_manual_proxies(self.rendered,
            'proxies:\n- {name: HK removed, type: socks5, server: example.invalid, port: 1080}\n')
        start, end, _, _ = renderer._manual_proxies(old)
        block = 'proxies: [] # keep editable\n'
        existing = old[:start] + block + old[end:]
        merged = renderer.apply_manual_proxies(self.rendered, existing)
        data = yaml.safe_load(merged)
        self.assertIn(block, merged)
        self.assertEqual(data['proxies'], [])
        self.assertTrue(all('HK removed' not in g.get('proxies', []) for g in data['proxy-groups']))

    def test_invalid_manual_nodes_fail_without_credential_details(self):
        for existing in ('rules: []\n', 'proxies: {password: private-test}\n',
                         'proxies:\n  - {name: "private-test}\n'):
            with self.subTest(existing=existing), self.assertRaises(ValueError) as failure:
                renderer.apply_manual_proxies(self.rendered, existing)
            self.assertNotIn('private-test', str(failure.exception))


if __name__ == '__main__':
    unittest.main()
