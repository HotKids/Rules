"""QX configuration conversion is generic, strict, ordered and offline."""
import sys
from pathlib import Path
import unittest

import yaml

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from qx_convert import convert_qx_module, is_qx_module
from module_convert import parse_module, render_stash, merge_modules


class QXModuleTests(unittest.TestCase):
    def test_recognition_does_not_reclassify_native_surge(self):
        for source in (
            "#!name=Fixture\nhost,ads.example.invalid,reject\n",
            "[rewrite_local]\n# disabled\n",
            "^https://example.invalid url script-response-body https://example.invalid/task.js\n",
        ):
            self.assertTrue(is_qx_module(source))
        for source in (
            "#!name=Surge\n[Rule]\nDOMAIN,ads.example.invalid,REJECT\n",
            "[MITM]\nhostname = ads.example.invalid\n",
            "# host,disabled.example.invalid,reject\n",
        ):
            self.assertFalse(is_qx_module(source))

    def test_filter_types_order_policies_and_flags_are_preserved(self):
        source = """#!name = Fixture
#!author = Upstream
host,exact.example.invalid,reject
host-wildcard,mquic-*.example.invalid,reject
host-suffix,example.invalid,direct
host-keyword,advert,Named Policy
ip-cidr,192.0.2.1/32,reject
ip6-cidr,2001:db8::1/128,reject,no-resolve
"""
        actual = convert_qx_module(source)
        metadata, sections = parse_module(actual)
        self.assertEqual(metadata, {"name": "Fixture", "author": "Upstream"})
        self.assertEqual(sections["Rule"], [
            "DOMAIN,exact.example.invalid,REJECT,extended-matching",
            "DOMAIN-WILDCARD,mquic-*.example.invalid,REJECT,extended-matching",
            "DOMAIN-SUFFIX,example.invalid,DIRECT",
            "DOMAIN-KEYWORD,advert,Named Policy",
            "IP-CIDR,192.0.2.1/32,REJECT,no-resolve",
            "IP-CIDR6,2001:db8::1/128,REJECT,no-resolve",
        ])
        self.assertEqual(actual.count("extended-matching"), 2)
        self.assertNotIn("pre-matching", actual)
        self.assertEqual(actual.count("no-resolve"), 2)

    def test_cidr_rejects_add_no_resolve_once_for_both_address_families(self):
        for kind, network in (("ip-cidr", "192.0.2.1/32"),
                              ("ip6-cidr", "2001:db8::1/128"),
                              ("ip-cidr6", "2001:db8::1/128")):
            for policy in ("reject", "ReJeCt", "reject-drop", "reject-tinygif", "REJECT-NO-DROP"):
                for existing in ("", ",NO-RESOLVE"):
                    with self.subTest(kind=kind, policy=policy, existing=existing):
                        _, sections = parse_module(convert_qx_module(f"{kind},{network},{policy}{existing}\n"))
                        fields = sections["Rule"][0].split(",")
                        self.assertEqual(fields[0], "IP-CIDR" if kind == "ip-cidr" else "IP-CIDR6")
                        self.assertEqual(fields[1], network)
                        self.assertEqual(fields[2], policy.upper())
                        self.assertEqual(fields[3:], ["no-resolve"])

    def test_other_policies_and_rule_types_keep_their_resolution_behavior(self):
        source = """ip-cidr,192.0.2.0/24,direct
ip6-cidr,2001:db8::/32,Proxy
ip-cidr6,2001:db8:1::/48,Custom Group
ip-cidr,198.51.100.0/24,REJECT-CUSTOM
geoip,CN,reject
ip-asn,64512,reject
host,ads.example.invalid,reject
"""
        _, sections = parse_module(convert_qx_module(source))
        self.assertEqual(sections["Rule"], [
            "IP-CIDR,192.0.2.0/24,DIRECT",
            "IP-CIDR6,2001:db8::/32,Proxy",
            "IP-CIDR6,2001:db8:1::/48,Custom Group",
            "IP-CIDR,198.51.100.0/24,REJECT-CUSTOM",
            "GEOIP,CN,REJECT",
            "IP-ASN,64512,REJECT",
            "DOMAIN,ads.example.invalid,REJECT,extended-matching",
        ])

    def test_domain_rejects_add_extended_matching_once_for_all_domain_types(self):
        kinds = {"host": "DOMAIN", "host-suffix": "DOMAIN-SUFFIX",
                 "host-keyword": "DOMAIN-KEYWORD", "host-wildcard": "DOMAIN-WILDCARD"}
        for kind, target in kinds.items():
            for policy in ("reject", "ReJeCt", "reject-drop", "reject-tinygif", "REJECT-NO-DROP"):
                for existing in ("", ",EXTENDED-MATCHING"):
                    with self.subTest(kind=kind, policy=policy, existing=existing):
                        _, sections = parse_module(convert_qx_module(f"{kind},ads.example.invalid,{policy}{existing}\n"))
                        self.assertEqual(sections["Rule"],
                            [f"{target},ads.example.invalid,{policy.upper()},extended-matching"])

    def test_domain_routing_and_custom_policies_do_not_gain_extended_matching(self):
        source = """host,direct.example.invalid,direct
host-suffix,proxy.example.invalid,Proxy
host-keyword,custom,Custom Group
host-wildcard,*.custom.example.invalid,REJECT-CUSTOM
"""
        _, sections = parse_module(convert_qx_module(source))
        self.assertEqual(sections["Rule"], [
            "DOMAIN,direct.example.invalid,DIRECT",
            "DOMAIN-SUFFIX,proxy.example.invalid,Proxy",
            "DOMAIN-KEYWORD,custom,Custom Group",
            "DOMAIN-WILDCARD,*.custom.example.invalid,REJECT-CUSTOM",
        ])

    def test_explicit_extended_matching_is_preserved_and_rejected_on_ip_rules(self):
        _, sections = parse_module(convert_qx_module(
            "host,direct.example.invalid,direct,EXTENDED-MATCHING\n"))
        self.assertEqual(sections["Rule"], ["DOMAIN,direct.example.invalid,DIRECT,extended-matching"])
        for kind, value in (("ip-cidr", "192.0.2.0/24"), ("ip6-cidr", "2001:db8::/32"),
                            ("geoip", "CN"), ("ip-asn", "64512")):
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, "does not apply"):
                convert_qx_module(f"{kind},{value},reject,extended-matching\n")

    def test_stash_output_omits_the_surge_extended_matching_parameter(self):
        converted = convert_qx_module("host,ads.example.invalid,reject\n")
        module = merge_modules([("https://example.invalid/source.snippet", converted, {})])
        rendered, _warnings = render_stash(module, "Example.stoverride")
        self.assertEqual(yaml.safe_load(rendered)["rules"], ["DOMAIN,ads.example.invalid,REJECT"])
        self.assertNotIn("extended-matching", rendered)

    def test_explicit_no_resolve_on_non_reject_cidr_is_preserved(self):
        _, sections = parse_module(convert_qx_module("ip-cidr,192.0.2.0/24,direct,NO-RESOLVE\n"))
        self.assertEqual(sections["Rule"], ["IP-CIDR,192.0.2.0/24,DIRECT,no-resolve"])

    def test_native_sections_take_precedence_over_shared_rules_and_url_text(self):
        for source in (
            "[Rule]\nIP-CIDR,192.0.2.1/32,REJECT\nIP-CIDR6,2001:db8::/32,REJECT\n",
            "[rule]\nip-cidr,192.0.2.1/32,REJECT\n",
            "[Rule]\nURL-REGEX,^https://example.invalid/ url script-response-body https://example.invalid/a.js,REJECT\n",
            "[Script]\n^https://example.invalid/ url script-response-body https://example.invalid/a.js\n",
            "[URL Rewrite]\n^https://example.invalid/ - reject\n",
            "[General]\n# Shared section appears later\n[MITM]\nhostname = example.invalid\n",
            "[Ruleset Private]\nIP-CIDR,192.0.2.1/32\n",
            "[rewrite_local]\n^https://example.invalid/ url reject\n[Rule]\nIP-CIDR,192.0.2.1/32,REJECT\n",
        ):
            with self.subTest(source=source):
                self.assertFalse(is_qx_module(source))
        self.assertTrue(is_qx_module("ip-cidr,192.0.2.1/32,reject\n[MITM]\nhostname = example.invalid\n"))

    def test_caller_title_prefix_prevents_cross_module_script_name_collisions(self):
        source = """#!update=2026-01-01
^https://example.invalid/ url script-response-body https://example.invalid/script.js
"""
        labels = []
        for prefix in ("哈啰出行去广告", "🎬 Video App [签到]"):
            actual = convert_qx_module(source, script_prefix=prefix)
            _, sections = parse_module(actual)
            names = [line.split("=", 1)[0].strip() for line in sections["Script"] if line.strip()]
            self.assertEqual(names, [prefix + "_1"])
            _, updated = parse_module(convert_qx_module(
                source.replace("2026-01-01", "2026-01-02"), script_prefix=prefix))
            self.assertEqual(updated["Script"], sections["Script"])
            labels.append(set(names))
        self.assertFalse(labels[0] & labels[1])
        for prefix in ("", "a\nb", "a=type", "a,pattern", "a" * 257, "# disabled", " ; disabled", "// disabled", "a\tlabel", "a\u2028label", "Title\n", "\tTitle", "Title\r"):
            with self.subTest(prefix=prefix), self.assertRaises(ValueError):
                convert_qx_module(source, script_prefix=prefix)

    def test_default_labels_use_metadata_title_then_qx_fallback_without_zero_padding(self):
        rewrite = "^https://example.invalid/ url script-response-body https://example.invalid/a.js\n"
        for metadata, expected in (
            ("#!name = 哈啰出行去广告\n", "哈啰出行去广告_1"),
            ("#!name = 🎬 Video App [签到]\n", "🎬 Video App [签到]_1"),
            ("#!author=Upstream\n", "QX_1"),
            ("#!name=\n", "QX_1"),
        ):
            with self.subTest(metadata=metadata):
                _, sections = parse_module(convert_qx_module(metadata + rewrite))
                self.assertEqual(sections["Script"][0].split("=", 1)[0].strip(), expected)
        # Metadata placement cannot change the chosen title.
        self.assertIn("Late title_1 =", convert_qx_module(rewrite + "#!name=Late title\n"))
        self.assertIn("Override title_1 =", convert_qx_module("#!name=Source title\n" + rewrite,
                                                             script_prefix="Override title"))

    def test_merged_sources_can_continue_one_based_numbers_across_http_and_cron(self):
        source = """#!name=Source title
^https://example.invalid/ url script-response-body https://example.invalid/a.js
[task_local]
1 0 * * * https://example.invalid/task.js, enabled=true
2 0 * * * https://example.invalid/disabled.js, enabled=false
"""
        converted = convert_qx_module(source, script_prefix="Merged title", script_start=9)
        _, sections = parse_module(converted)
        labels = [line.split("=", 1)[0].strip() for line in sections["Script"] if line.strip() and not line.startswith("#")]
        self.assertEqual(labels, ["Merged title_10", "Merged title_11"])
        self.assertNotIn("Merged title_12", converted)
        for start in (-1, 1.5, True, "0", None):
            with self.subTest(start=start), self.assertRaises(ValueError):
                convert_qx_module(source, script_start=start)

    def test_unsafe_source_title_cannot_become_an_executable_or_disabled_label(self):
        rewrite = "^https://example.invalid/ url script-response-body https://example.invalid/a.js\n"
        for title in ("# disabled", "; disabled", "// disabled", "injected=type", "bad,title", "bad\ttitle"):
            with self.subTest(title=title), self.assertRaises(ValueError):
                convert_qx_module("#!name=" + title + "\n" + rewrite)

    def test_script_callback_keeps_stage_and_upstream_url(self):
        calls = []
        def script_url(url, kind):
            calls.append((url, kind))
            return "https://converted.example.invalid/" + kind + ".js"
        source = "\n".join(
            f"^https://example.invalid/{kind} url script-{kind} https://upstream.example.invalid/rewrite.js"
            for kind in ("request-header", "request-body", "response-header", "response-body", "echo-response"))
        actual = convert_qx_module(source, script_url=script_url)
        _, sections = parse_module(actual)
        self.assertEqual([kind for _, kind in calls], ["request", "request-body", "response", "response-body", "echo"])
        self.assertTrue(all(url == "https://upstream.example.invalid/rewrite.js" for url, _ in calls))
        self.assertEqual(len(sections["Script"]), 5)
        self.assertNotIn("requires-body", sections["Script"][0])
        self.assertIn("type=http-request", sections["Script"][-1])
        self.assertIn("requires-body=true", sections["Script"][-1])
        self.assertNotIn("max-size=", actual)
        self.assertNotIn("argument=", actual)
        self.assertNotIn("sessionIndex", actual)

    def test_200_mock_is_not_an_ordinary_reject_and_renders_as_stash_mock(self):
        source = """#!name=Fixture
^https://ads.example.invalid/empty url reject-200
^https://ads.example.invalid/object url reject-dict
^https://ads.example.invalid/array url reject-array
^https://ads.example.invalid/image url reject-img
hostname = ads.example.invalid
"""
        converted = convert_qx_module(source)
        self.assertNotIn("[Rule]", converted)
        self.assertNotIn(" - reject", converted)

        self.assertIn("hostname = %APPEND% ads.example.invalid", converted)
        stash, warnings = render_stash(merge_modules([("fixture", converted, {})]), "Fixture.stoverride")
        self.assertEqual(warnings, [])
        mocks = yaml.safe_load(stash)["http"]["mock"]
        self.assertEqual([mock["status-code"] for mock in mocks], [200] * 4)
        self.assertEqual([mock.get("text") for mock in mocks[:3]], ["", "{}", "[]"])
        self.assertIn("base64", mocks[-1])

    def test_binary_mode_is_per_original_url_and_body_limits_are_opt_in(self):
        binary = "https://example.invalid/bytes.js"
        text = "https://example.invalid/text.js"
        source = (f"^https://example.invalid/a url script-response-body {binary}\n"
                  f"^https://example.invalid/b url script-response-body {text}\n"
                  f"^https://example.invalid/c url script-response-header {binary}\n")
        actual = convert_qx_module(source, binary_body_urls={binary},
                                   script_url=lambda *_: "https://example.invalid/bundle.js")
        _, sections = parse_module(actual)
        self.assertEqual(actual.count("binary-body-mode=true"), 1)
        self.assertIn("binary-body-mode=true", sections["Script"][0])
        self.assertNotIn("binary-body-mode", sections["Script"][1])
        self.assertNotIn("binary-body-mode", sections["Script"][2])
        self.assertNotIn("max-size=", actual)
        explicit = convert_qx_module(source, body_limit=16384, binary_body_urls={binary})
        self.assertEqual(explicit.count("max-size=16384"), 2)

    def test_patterns_and_script_urls_remain_exact(self):
        pattern = r"^https?:\/\/(?:api|marketingapi)\.example\.invalid(?::\d+)?\/api(?:\?|$)"
        url = "https://example.invalid/remote.js?value=a%2Cb&v=1#fragment"
        result = convert_qx_module(f"{pattern} url script-response-body {url}\n")
        self.assertIn("pattern=" + pattern + ",", result)
        self.assertIn("script-path=" + url, result)
        self.assertEqual(convert_qx_module(f"{pattern} url script-response-body {url}\n"), result)

    def test_comma_bearing_script_fields_are_quoted_without_changing_regex(self):
        pattern = r"^https://api\.example\.invalid/items/\d{1,3}(?:,tail)?$"
        url = "https://example.invalid/first,second.js"
        converted = convert_qx_module(f"{pattern} url script-response-body {url}\n")
        self.assertIn(f'pattern="{pattern}",', converted)
        self.assertIn(f'script-path="{url}"', converted)
        stash, warnings = render_stash(merge_modules([("fixture", converted, {})]), "Fixture.stoverride")
        self.assertEqual(warnings, [])
        data = yaml.safe_load(stash)
        self.assertEqual(data["http"]["script"][0]["match"], pattern)
        self.assertEqual(next(iter(data["script-providers"].values()))["url"], url)

    def test_ambiguous_script_field_quotes_fail_without_escaping_upstream_regex(self):
        for source in (
            '^https://example.invalid/[^"x]{1,3} url script-response-body https://example.invalid/a.js',
            '^https://example.invalid/ url script-response-body https://example.invalid/a"b.js',
        ):
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, "losslessly"):
                convert_qx_module(source)

    def test_option_looking_commas_fail_instead_of_truncating_script_fields(self):
        for source in (
            "^https://example.invalid/a,name=b url script-response-body https://example.invalid/a.js",
            "^https://example.invalid/a,script-path=b url script-response-body https://example.invalid/a.js",
            "^https://example.invalid/ url script-response-body https://example.invalid/a.js?first=1,name=b",
        ):
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, "losslessly"):
                convert_qx_module(source)

    def test_sectioned_filters_rewrites_and_tasks(self):
        source = """#!name=Fixture
[filter_local]
host,ads.example.invalid,reject
[rewrite_local]
^http://example.invalid/ url 302 https://example.invalid/
[task_local]
1 0 * * * https://example.invalid/task.js, tag=Nightly, enabled=true
2 0 * * * https://example.invalid/disabled.js, enabled=false
[mitm]
hostname = example.invalid, api.example.invalid
"""
        called = []
        def mapper(url, kind):
            called.append((url, kind))
            return url
        actual = convert_qx_module(source, script_url=mapper)
        _, sections = parse_module(actual)
        self.assertEqual([line for line in sections["URL Rewrite"] if line],
                         ["^http://example.invalid/ https://example.invalid/ 302"])
        self.assertEqual(called, [("https://example.invalid/task.js", "cron")])
        self.assertIn('cronexp="1 0 * * *"', actual)
        self.assertNotIn("disabled.js", actual)

    def test_unknown_or_invalid_executable_content_fails_without_source_leakage(self):
        invalid = (
            "^https://example.invalid/private?token=credential url script-response-body file:///private.js",
            "^https://example.invalid/private?token=credential url body-replace private",
            "host,ads.example.invalid,reject,force-cellular",
            "[rewrite_local]\nhost,ads.example.invalid,reject",
            "[filter_local]\n^https://example.invalid/ url reject",
            "[general]\nprivate=credential",
            "hostname = example.invalid,,",
            "unrecognized,private,credential",
            "^https://example.invalid/ url reject-200 unexpected",
            "[task_local]\n1 0 * * * https://example.invalid/task.js, tag=private, unknown=credential",
        )
        for source in invalid:
            with self.subTest(source=source), self.assertRaises(ValueError) as error:
                convert_qx_module(source)
            self.assertNotIn("private", str(error.exception))
            self.assertNotIn("credential", str(error.exception))
            self.assertNotIn("https://", str(error.exception))
        for value in ("", "# only a comment", "#!name=metadata only"):
            with self.assertRaises(ValueError):
                convert_qx_module(value)

    def test_invalid_mapped_url_and_limit_fail_before_output(self):
        source = "^https://example.invalid/ url script-response-body https://example.invalid/script.js"
        with self.assertRaises(ValueError):
            convert_qx_module(source, script_url=lambda *_args: "file:///not-published.js")
        for limit in (0, -1, True, "4194304"):
            with self.subTest(limit=limit), self.assertRaises(ValueError):
                convert_qx_module(source, body_limit=limit)


if __name__ == "__main__":
    unittest.main()
