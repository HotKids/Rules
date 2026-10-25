"""Keep the generated enhancement module scoped to the shared Profile settings."""
import contextlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / '.github/scripts'))
from config_sync import profile_module


TEMPLATE = (ROOT / profile_module.TEMPLATE).read_text(encoding='utf-8')
PROFILE = '''#!MANAGED-CONFIG https://example.invalid/private-profile
[General]
# Existing settings
skip-proxy = localhost, *.lan
always-real-ip = *.example.invalid
force-http-engine-hosts = api.example.invalid
hijack-dns = *:53
dns-server = 1.1.1.1, 8.8.8.8
wifi-assist = false
future-option = source-value
[Host]
service.example.invalid = 192.0.2.1
[Ponte]
secret = must-not-be-copied
[Proxy]
Local = direct
Drop = reject-drop
Node = snell, server.example.invalid, 443, psk=must-not-be-copied
[Proxy Group]
All = select, Node
[Rule]
# SSH
AND,((DEST-PORT,22),(PROTOCOL,TCP)),Local
# Bypass and reroute
RULE-SET,https://example.invalid/Bypass.list,Local
RULE-SET,https://example.invalid/Reroute.list,🔰 Proxy
# Private
DOMAIN-SET,https://example.invalid/private.txt,Local
# HTTPDNS remains disabled
# RULE-SET,https://example.invalid/HTTPDNS.list,🚧 AdGuard
# Ads
DOMAIN-SET,https://example.invalid/reject.txt,🚧 AdGuard,extended-matching
RULE-SET,https://example.invalid/Block.list,🚧 AdGuard,extended-matching
# Phishing
DOMAIN-SET,https://example.invalid/Phishing.list,🚧 AdGuard,extended-matching
# Bogus
RULE-SET,https://example.invalid/Bogus.list,Drop,no-resolve,pre-matching
# These later rules must stay out
RULE-SET,https://example.invalid/Streaming.list,All
IP-CIDR,0.0.0.0/32,REJECT,no-resolve
FINAL,All
[Script]
secret-script = type=generic,script-path=must-not-be-copied
[MITM]
ca-p12 = must-not-be-copied
'''


class ProfileModuleTests(unittest.TestCase):
    def test_general_tracks_source_but_keeps_the_template_merge_operations(self):
        template = TEMPLATE.replace('skip-proxy = %APPEND%', 'skip-proxy = %INSERT%')
        result = profile_module.render_profile_module(PROFILE, template)
        self.assertIn('#!arguments=PROXY:🔰 Proxy,DIRECT:🔘 DIRECT,REJECT:⛔️ REJECT', result)
        self.assertIn('skip-proxy = %INSERT% localhost, *.lan', result)
        self.assertIn('always-real-ip = %APPEND% *.example.invalid', result)
        self.assertIn('hijack-dns = %APPEND% *:53', result)
        self.assertIn('dns-server = 1.1.1.1, 8.8.8.8', result)
        self.assertNotIn('dns-server = %APPEND%', result)
        self.assertIn('future-option = source-value', result)
        changed = PROFILE.replace('*.lan', '*.home.arpa').replace('wifi-assist = false', 'wifi-assist = true')
        updated = profile_module.render_profile_module(changed, template)
        self.assertIn('skip-proxy = %INSERT% localhost, *.home.arpa', updated)
        self.assertIn('wifi-assist = true', updated)

    def test_only_host_general_and_rules_through_bogus_are_copied_except_ssh(self):
        result = profile_module.render_profile_module(PROFILE, TEMPLATE)
        sections = profile_module._sections(result)
        self.assertEqual(list(sections), ['General', 'Host', 'Rule'])
        self.assertIn('service.example.invalid = 192.0.2.1', result)
        self.assertNotIn('must-not-be-copied', result)
        self.assertNotIn('#!MANAGED-CONFIG', result)
        self.assertNotIn('# SSH', result)
        self.assertNotIn('DEST-PORT,22', result)
        self.assertNotIn('Streaming.list', result)
        self.assertNotIn('0.0.0.0/32', result)
        self.assertNotIn('FINAL,', result)
        rules = [line for line in sections['Rule'] if line and not line.startswith('#')]
        self.assertEqual(rules, [
            'RULE-SET,https://example.invalid/Bypass.list,{{{DIRECT}}}',
            'RULE-SET,https://example.invalid/Reroute.list,{{{PROXY}}}',
            'DOMAIN-SET,https://example.invalid/private.txt,{{{DIRECT}}}',
            'DOMAIN-SET,https://example.invalid/reject.txt,{{{REJECT}}},extended-matching',
            'RULE-SET,https://example.invalid/Block.list,{{{REJECT}}},extended-matching',
            'DOMAIN-SET,https://example.invalid/Phishing.list,{{{REJECT}}},extended-matching',
            'RULE-SET,https://example.invalid/Bogus.list,REJECT-DROP,no-resolve,pre-matching',
        ])
        self.assertIn('# RULE-SET,https://example.invalid/HTTPDNS.list,{{{REJECT}}}', result)
        disabled = PROFILE.replace('RULE-SET,https://example.invalid/Bogus.list', '# RULE-SET,https://example.invalid/Bogus.list')
        self.assertIn('# RULE-SET,https://example.invalid/Bogus.list,REJECT-DROP',
                      profile_module.render_profile_module(disabled, TEMPLATE))

    def test_logical_rules_before_the_boundary_keep_subrules_and_flags(self):
        extra = 'AND,((DOMAIN,a.example.invalid),(DEST-PORT,443)),🚧 AdGuard,pre-matching\n'
        source = PROFILE.replace('# Ads\n', '# Ads\n' + extra)
        result = profile_module.render_profile_module(source, TEMPLATE)
        self.assertIn(extra.replace('🚧 AdGuard', '{{{REJECT}}}'), result)

    def test_missing_boundary_or_unknown_module_difference_stops_publication(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'Surge/Profile.conf'
            template = root / profile_module.TEMPLATE
            target = root / profile_module.OUTPUT
            source.parent.mkdir(parents=True)
            template.parent.mkdir(parents=True)
            target.parent.mkdir(parents=True)
            source.write_text(PROFILE.replace('/Bogus.list', '/Other.list'))
            template.write_text(TEMPLATE)
            target.write_text('last complete module\n')
            with patch.object(profile_module, 'REPO_ROOT', root):
                with self.assertRaisesRegex(ValueError, 'boundary not found'):
                    profile_module._sync_profile_module({'Surge': {'source': 'Surge/Profile.conf'}})
            self.assertEqual(target.read_text(), 'last complete module\n')
        for invalid in (TEMPLATE.replace('%APPEND%', '%UNKNOWN%'),
                        TEMPLATE.replace('{{{REJECT}}}', '{{{MISSING}}}')):
            with self.subTest(template=invalid), self.assertRaises(ValueError):
                profile_module.render_profile_module(PROFILE, invalid)

    def test_sync_is_idempotent_and_never_changes_the_profile_or_template(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, template = root / 'Surge/Profile.conf', root / profile_module.TEMPLATE
            source.parent.mkdir(parents=True)
            template.parent.mkdir(parents=True)
            source.write_text(PROFILE)
            template.write_text(TEMPLATE)
            with patch.object(profile_module, 'REPO_ROOT', root), contextlib.redirect_stdout(io.StringIO()):
                profile_module._sync_profile_module({'Surge': {'source': 'Surge/Profile.conf'}})
                once = (root / profile_module.OUTPUT).read_bytes()
                with patch.object(profile_module, 'write_if_changed', return_value=False) as writer:
                    profile_module._sync_profile_module({'Surge': {'source': 'Surge/Profile.conf'}})
                self.assertEqual(writer.call_args.args[1].encode(), once)
            self.assertEqual(source.read_text(), PROFILE)
            self.assertEqual(template.read_text(), TEMPLATE)


if __name__ == '__main__':
    unittest.main()
