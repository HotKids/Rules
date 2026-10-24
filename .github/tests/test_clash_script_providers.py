"""Execute private Enhance Scripts against provider-only and mixed configurations."""
import json
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ('MyScript.js', 'MyScriptColor.js', 'MyClashBox.js')


def run_script(name, config):
    code = '''const fs = require('fs'), vm = require('vm');
const context = {input: JSON.parse(fs.readFileSync(0, 'utf8'))};
vm.createContext(context);
try {
  vm.runInContext(fs.readFileSync(process.argv[1], 'utf8') + '\\nresult = main(input);', context);
  process.stdout.write(JSON.stringify({result: context.result}));
} catch (error) { process.stdout.write(JSON.stringify({error: error.message})); }
'''
    result = subprocess.run(['node', '-e', code, str(ROOT / 'Clash/Script' / name)],
                            input=json.dumps(config), capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


class PrivateScriptProviderTests(unittest.TestCase):
    def test_provider_only_inputs_keep_sources_and_route_pools_through_providers(self):
        filters = json.loads((ROOT / '.github/scripts/sync-config/Enhanced/myscript.overlay.json').read_text())
        hk_filter = filters['group_overrides']['🇭🇰 Hong Kong']['filter']
        kinds = ({'type': 'inline', 'payload': [
                    {'name': 'HK payload', 'type': 'socks5', 'server': 'example.invalid', 'port': 1080}]},
                 {'type': 'http', 'url': 'https://example.invalid/user-subscription'},
                 {'type': 'file', 'path': './user-provider.yaml'})
        for name in SCRIPTS:
            for provider in kinds:
                with self.subTest(script=name, provider=provider['type']):
                    sources = {'Manual': provider}
                    result = run_script(name, {'proxies': [], 'proxy-providers': sources})
                    self.assertNotIn('error', result)
                    output = result['result']
                    self.assertEqual(output['proxy-providers'], sources)
                    self.assertEqual(output['proxies'], [])
                    groups = {g['name']: g for g in output['proxy-groups']}
                    renamed = name == 'MyClashBox.js'
                    hk = groups['Hong Kong' if renamed else '🇭🇰 Hong Kong']
                    server = groups['Server' if renamed else '🇺🇳 Server']
                    relay = groups['🇭🇰 HK Relay']
                    for group in (hk, server, relay):
                        self.assertIs(group['include-all-providers'], True)
                        self.assertNotIn('proxies', group)
                    self.assertEqual(hk['filter'], hk_filter)
                    mail = groups['Mail' if renamed else '📧 Mail']
                    self.assertIs(mail['include-all-providers'], True)
                    self.assertEqual(mail['proxies'], ['Proxy', 'Direct'] if renamed else ['🔰 Proxy', '🔘 DIRECT'])

    def test_mixed_sources_preserve_inline_order_and_do_not_flatten_provider_payload(self):
        nodes = [{'name': name, 'type': 'socks5', 'server': 'example.invalid', 'port': 1080}
                 for name in ('HK Z', 'HK A')]
        providers = {'Manual': {'type': 'inline', 'payload': [
            {'name': 'HK payload', 'type': 'socks5', 'server': 'example.invalid', 'port': 1080}]}}
        for name in SCRIPTS:
            with self.subTest(script=name):
                output = run_script(name, {'proxies': nodes, 'proxy-providers': providers})['result']
                self.assertEqual(output['proxies'], nodes)
                self.assertEqual(output['proxy-providers'], providers)
                hk = next(g for g in output['proxy-groups'] if g['name'] in ('🇭🇰 Hong Kong', 'Hong Kong'))
                self.assertEqual(hk['proxies'], ['HK Z', 'HK A'])
                self.assertIs(hk['include-all-providers'], True)

    def test_truly_empty_inputs_still_fail(self):
        for name in SCRIPTS:
            for config in ({}, {'proxies': [], 'proxy-providers': {}},
                           {'proxies': [{'name': 'placeholder', 'type': 'direct'}]}):
                with self.subTest(script=name, config=config):
                    self.assertIn('未找到任何代理节点', run_script(name, config)['error'])


if __name__ == '__main__':
    unittest.main()
