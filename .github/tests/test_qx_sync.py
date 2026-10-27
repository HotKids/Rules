"""Offline integration for QX module scripts and fail-before-write guarantees."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import _common
import qx_scripts
from qx_compat import can_use_upstream


SOURCE_URL = "https://example.invalid/example.snippet"
JS_URL = "https://example.invalid/shared.js?version=public"
SOURCE_JS = "'use strict';\nvar module = {};\nconst untouched = $argument;\n$done({body: $response ? $response.body : untouched});\n"
QX_SOURCE = ("#!name=Generic fixture\n[rewrite_local]\n"
             "^https://example.invalid/request url script-request-body " + JS_URL + "\n"
             "^https://example.invalid/response url script-response-body " + JS_URL + "\n"
             "^https://example.invalid/mock url script-echo-response " + JS_URL + "\n"
             "[mitm]\nhostname = example.invalid\n")


def load_runner():
    spec = importlib.util.spec_from_file_location("qx_sync_runner", SCRIPTS / "sync-rules.py")
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    return runner


class QxSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.runner = load_runner()
        self.listing = self.root / "sync-rules.txt"
        self.listing.write_text("# >> Module\n" + SOURCE_URL + ",Generic.sgmodule\n")
        self.rules = {"surge": [], "surge_domainset": [], "clash": [],
                      "module": [{"url": SOURCE_URL, "name": "Generic.sgmodule", "overrides": {}}]}
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(self.runner, "REPO_ROOT", self.root))
        self.stack.enter_context(patch.object(self.runner, "SYNC_RULES_TXT", self.listing))
        self.stack.enter_context(patch.object(self.runner, "SURGE_DIR", self.root / "Surge/RULE-SET"))
        self.stack.enter_context(patch.object(qx_scripts, "can_use_upstream", return_value=False))
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))

    def snapshot(self):
        return {p.relative_to(self.root).as_posix(): p.read_bytes()
                for p in self.root.rglob("*") if p.is_file()}

    def prepare(self, texts=None, download=None):
        return qx_scripts.prepare_qx_modules(
            self.rules["module"], texts or {SOURCE_URL: QX_SOURCE}, self.root,
            download or (lambda urls: {url: SOURCE_JS for url in urls}))

    def run_bundle(self, content, context):
        harness = r"""
const fs = require('node:fs');
const vm = require('node:vm');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const values = {};
let result, count = 0;
const context = {...input.context, calls: [],
  $persistentStore: {read: key => values[key] ?? null, write: (value, key) => { values[key] = value; return true; }},
  $done: value => { result = value; count++; },
};
vm.runInNewContext(input.content, context);
process.stdout.write(JSON.stringify({result, count, calls: context.calls}));
"""
        run = subprocess.run(["node", "-e", harness],
                             input=json.dumps({"content": content, "context": context}),
                             text=True, capture_output=True, check=True, timeout=10)
        return json.loads(run.stdout)

    def test_all_modes_share_url_namespace_and_preserve_exact_upstream_js(self):
        other = "https://example.invalid/other.snippet"
        self.rules["module"].append({"url": other, "name": "Other.sgmodule", "overrides": {}})
        texts = {SOURCE_URL: QX_SOURCE,
                 other: "[task_local]\n0 0 * * * " + JS_URL + ", tag=Daily\n"}
        calls = []
        plan = self.prepare(texts, lambda urls: calls.append(urls) or {JS_URL: SOURCE_JS})
        self.assertEqual(calls, [[JS_URL]])
        self.assertEqual(set(plan.scripts), {"Surge/Module/Scripts/generic.js", "Surge/Module/Scripts/other.js"})
        labels = []
        for converted in plan.converted.values():
            labels.extend(line.split(" = ", 1)[0] for line in converted.splitlines()
                          if " = type=" in line)
        self.assertEqual(len(labels), len(set(labels)))
        namespace = "qx-" + hashlib.sha256(JS_URL.encode()).hexdigest()
        for relative, content in plan.scripts.items():
            self.assertRegex(relative, r"^Surge/Module/Scripts/[a-z]+\.js$")
            self.assertIn(json.dumps(namespace), content)
            extracted = content.split("// BEGIN UPSTREAM SOURCE\n", 1)[1].split("\n// END UPSTREAM SOURCE", 1)[0]
            self.assertEqual(extracted, SOURCE_JS)
            self.assertEqual(content.count("// BEGIN UPSTREAM SOURCE\n"), 1)
            self.assertNotIn("$argument =", content)
            self.assertNotIn(JS_URL, content)
        self.assertEqual(self.snapshot(), {"sync-rules.txt": self.listing.read_bytes()})
        with patch.object(self.runner, "prefetch_urls") as download:
            self.runner.fetch_external_modules(self.rules, texts, prepared_qx=plan)
        download.assert_not_called()
        module = (self.root / "Surge/Module/Generic.sgmodule").read_text()
        self.assertIn(qx_scripts.RAW_SCRIPT_BASE, module)
        self.assertIn("requires-body=true", module)
        self.assertFalse((self.root / "Surge/Module/Stash/Generic.stoverride").exists())
        self.assertTrue((self.root / qx_scripts.OWNERS_FILE).is_file())
        before = self.snapshot()
        self.runner.fetch_external_modules(self.rules, texts, prepared_qx=plan)
        self.assertEqual(before, self.snapshot())

    def test_binary_modes_follow_the_original_source_url_and_render_for_both_clients(self):
        text_url = "https://example.invalid/plain.js"
        binary_source = ('$done({bodyBytes: typeof $response === "undefined" '
                         '? $request.bodyBytes : $response.bodyBytes});')
        plain_source = '$done({body:$response.body});'
        source = ("#!name=Mixed fixture\n"
                  f"^https://example.invalid/a url script-request-body {JS_URL}\n"
                  f"^https://example.invalid/a url script-response-body {JS_URL}\n"
                  f"^https://example.invalid/plain url script-response-body {text_url}\n"
                  "hostname = example.invalid\n")
        self.rules["module"][0]["name"] = "Generic"
        with patch.object(qx_scripts, "can_use_upstream", side_effect=can_use_upstream):
            plan = self.prepare({SOURCE_URL: source}, lambda _urls: {JS_URL: binary_source, text_url: plain_source})
        converted = plan.source_text(SOURCE_URL, "Generic.sgmodule", "")
        scripts = [line for line in converted.splitlines() if " = type=" in line]
        self.assertEqual(converted.count("binary-body-mode=true"), 2)
        self.assertTrue(all("binary-body-mode=true" in line for line in scripts[:2]))
        self.assertNotIn("binary-body-mode", scripts[2])
        self.assertIn("script-path=" + text_url, scripts[2])
        self.assertNotIn("max-size=", converted)
        bundle = next(iter(plan.scripts.values()))
        self.assertIn("// BEGIN UPSTREAM SOURCE\n" + binary_source + "\n// END UPSTREAM SOURCE", bundle)
        self.assertNotIn(plain_source, bundle)
        self.runner.fetch_external_modules(self.rules, {SOURCE_URL: source}, prepared_qx=plan)
        import yaml
        stash = yaml.safe_load((self.root / "Surge/Module/Stash/Generic.stoverride").read_text())
        jobs = stash["http"]["script"]
        self.assertEqual([job.get("binary-mode", False) for job in jobs], [True, True, False])
        self.assertTrue(all("max-size" not in job for job in jobs))
        before = self.snapshot()
        self.runner.fetch_external_modules(self.rules, {SOURCE_URL: source}, prepared_qx=plan)
        self.assertEqual(before, self.snapshot())

    def test_unrecognized_binary_inspection_fails_before_any_output_changes(self):
        module = self.root / "Surge/Module/Generic.sgmodule"
        module.parent.mkdir(parents=True)
        module.write_text("previous module")
        before = self.snapshot()
        for source in ('const value=`${$response.bodyBytes}`; $done({body:value});',
                       'const key="bodyBytes"; $done({body:$response[key]});'):
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, "binary body requirements"):
                self.prepare(download=lambda _urls: {JS_URL: source})
            self.assertEqual(before, self.snapshot())

    def test_standalone_call_downloads_configs_then_one_deduplicated_script_batch(self):
        calls = []
        def download(urls, ua, **options):
            calls.append(list(urls))
            self.assertTrue(options["encode"])
            return {SOURCE_URL: QX_SOURCE} if SOURCE_URL in urls else {JS_URL: SOURCE_JS}
        with patch.object(self.runner, "prefetch_urls", side_effect=download):
            self.runner.fetch_external_modules()
        self.assertEqual(calls, [[SOURCE_URL], [JS_URL]])
        self.assertEqual([path.name for path in (self.root / "Surge/Module/Scripts").glob("*.js")], ["generic.js"])

    def test_complete_wrapper_preserves_argument_strict_mode_and_local_declarations(self):
        source = ("'use strict';\nconst module = {};\n"
                  "$prefs.setValueForKey($argument, 'fixture');\n"
                  "$done({body: JSON.stringify({argument: $argument, body: $request.body, "
                  "strict: (function () { return this; })() === undefined})});\n")
        plan = self.prepare(download=lambda urls: {JS_URL: source})
        content = next(iter(plan.scripts.values()))
        harness = r"""
const fs = require('node:fs');
const vm = require('node:vm');
const values = {};
let result;
vm.runInNewContext(fs.readFileSync(0, 'utf8'), {
  $argument: 'existing-user-argument',
  $request: {id: 'opaque-id', url: 'https://example.invalid/request', method: 'POST', body: 'original-body'},
  $persistentStore: {read: key => values[key] ?? null, write: (value, key) => { values[key] = value; return true; }},
  $done: value => { result = value; },
});
process.stdout.write(JSON.stringify({result, preference: values.fixture}));
"""
        run = subprocess.run(["node", "-e", harness], input=content, text=True,
                             capture_output=True, check=True, timeout=10)
        actual = json.loads(run.stdout)
        self.assertEqual(json.loads(actual["result"]["body"]),
                         {"argument": "existing-user-argument", "body": "original-body", "strict": True})
        self.assertEqual(actual["preference"], "existing-user-argument")

    def test_main_prepares_js_before_rules_and_reuses_the_same_plan(self):
        rule_url = "https://example.invalid/rule.list"
        self.rules["surge"] = [{"url": rule_url, "name": "Fixture", "overrides": {}}]
        events = []
        def download(urls, *_args, **_kwargs):
            if JS_URL in urls:
                events.append("scripts")
                return {JS_URL: SOURCE_JS}
            events.append("configs")
            return {SOURCE_URL: QX_SOURCE, rule_url: "DOMAIN,example.invalid,DIRECT\n"}
        with patch.object(self.runner, "_check_idle_streaming"), \
                patch.object(self.runner, "parse_sync_rules", return_value=self.rules) as parse, \
                patch.object(self.runner, "prefetch_urls", side_effect=download) as fetch, \
                patch.object(self.runner, "fetch_external_rules", side_effect=lambda *_: events.append("rules")), \
                patch.object(self.runner, "sync_streaming"), patch.object(self.runner, "convert_all"), \
                patch.object(self.runner, "cleanup_stale"):
            self.runner.main()
        parse.assert_called_once_with()
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(events, ["configs", "scripts", "rules"])
        self.assertTrue((self.root / "Surge/Module/Generic.sgmodule").exists())

    def test_secondary_download_or_syntax_failure_precedes_every_output_write(self):
        existing = self.root / "Surge/Module/Generic.sgmodule"
        existing.parent.mkdir(parents=True)
        existing.write_text("previous module")
        before = self.snapshot()
        for failure in ("download", "syntax", "html", "missing"):
            with self.subTest(failure=failure):
                def download(urls, *_args, **_kwargs):
                    if SOURCE_URL in urls:
                        return {SOURCE_URL: QX_SOURCE}
                    if failure == "download":
                        raise _common.DownloadBatchError([_common.DownloadError(JS_URL, "timeout")])
                    if failure == "missing":
                        return {}
                    return {JS_URL: "const broken = ;" if failure == "syntax" else "<html>not javascript</html>"}
                with patch.object(self.runner, "_check_idle_streaming"), \
                        patch.object(self.runner, "parse_sync_rules", return_value=self.rules), \
                        patch.object(self.runner, "prefetch_urls", side_effect=download), \
                        patch.object(self.runner, "fetch_external_rules") as rule_stage, \
                        patch.object(self.runner, "fetch_external_modules") as module_stage:
                    with self.assertRaises((ValueError, _common.DownloadBatchError)):
                        self.runner.main()
                rule_stage.assert_not_called()
                module_stage.assert_not_called()
                self.assertEqual(before, self.snapshot())

    def test_native_modules_keep_original_script_urls_and_do_not_fetch_scripts(self):
        native = "[Rule]\nIP-CIDR,10.0.0.0/8,DIRECT\n[Script]\nNative = type=http-response,pattern=^https:,script-path=" + JS_URL + "\n"
        texts = {"https://example.invalid/native.sgmodule": native}
        entries = [{"url": next(iter(texts)), "name": "Native.sgmodule", "overrides": {}}]
        with patch("qx_scripts.subprocess.run") as parser:
            plan = qx_scripts.prepare_qx_modules(entries, texts, self.root, lambda _: self.fail("native JS fetched"))
        parser.assert_not_called()
        self.assertEqual(plan.converted, {})
        self.assertEqual(plan.scripts, {})

    def test_snippet_extension_forces_validation_instead_of_accepting_unknown_sections(self):
        with self.assertRaisesRegex(ValueError, "unsupported section"):
            self.prepare({SOURCE_URL: "[UnknownQxSection]\nvalue=true\n"})

    def test_cleanup_requires_ownership_and_matching_bytes_and_preserves_manual_scripts(self):
        plan = self.prepare()
        self.runner.fetch_external_modules(self.rules, {SOURCE_URL: QX_SOURCE}, prepared_qx=plan)
        scripts = sorted(self.root.glob("Surge/Module/Scripts/*.js"))
        edited = scripts[0]
        edited.write_text(edited.read_text() + "// local edit\n")
        legacy = self.root / (qx_scripts.SCRIPT_DIRECTORY + "/qx-" + "e" * 64 + ".js")
        legacy.write_text(qx_scripts.GENERATED_HEADER + "\n// previous wrapper\n")
        registry = self.root / qx_scripts.OWNERS_FILE
        state = json.loads(registry.read_text())
        state["files"][legacy.relative_to(self.root).as_posix()] = hashlib.sha256(legacy.read_bytes()).hexdigest()
        registry.write_text(json.dumps(state))
        manual = self.root / "Surge/Module/Scripts/ip-security.js"
        manual.write_text("manual script")
        unknown = self.root / (qx_scripts.SCRIPT_DIRECTORY + "/qx-" + "f" * 64 + ".js")
        unknown.write_text(qx_scripts.GENERATED_HEADER + "\n// not registered\n")
        expected = {edited: edited.read_bytes(), manual: manual.read_bytes(), unknown: unknown.read_bytes()}
        self.rules["module"] = []
        self.runner.fetch_external_modules(self.rules, {})
        for path, content in expected.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertFalse(legacy.exists())
        self.assertTrue(all(not path.exists() for path in scripts[1:]))
        self.assertEqual(json.loads((self.root / qx_scripts.OWNERS_FILE).read_text())["files"], {})

    def test_local_edits_and_invalid_registry_refuse_the_whole_batch(self):
        plan = self.prepare()
        self.runner.fetch_external_modules(self.rules, {SOURCE_URL: QX_SOURCE}, prepared_qx=plan)
        script = next(self.root.glob("Surge/Module/Scripts/*.js"))
        script.write_text(script.read_text() + "// locally changed\n")
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "local edits"):
            self.prepare()
        self.assertEqual(before, self.snapshot())
        registry = self.root / qx_scripts.OWNERS_FILE
        registry.write_text(json.dumps({"version": 1, "files": {"Surge/Module/Scripts/Ip-security.js": "f" * 64}}))
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "ownership path"):
            self.prepare()
        self.assertEqual(before, self.snapshot())

    def test_prepared_batch_rejects_changed_source_before_any_write(self):
        plan = self.prepare()
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "does not match"):
            self.runner.fetch_external_modules(self.rules, {SOURCE_URL: QX_SOURCE + "# changed\n"}, prepared_qx=plan)
        self.assertEqual(before, self.snapshot())

    def test_owned_symlink_is_rejected_before_module_writes_or_cleanup(self):
        plan = self.prepare()
        self.runner.fetch_external_modules(self.rules, {SOURCE_URL: QX_SOURCE}, prepared_qx=plan)
        script = next(self.root.glob("Surge/Module/Scripts/*.js"))
        script.unlink()
        manual = self.root / "manual.js"
        manual.write_text("manual content")
        script.symlink_to(manual)
        self.rules["module"] = []
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "Unsafe QX"):
            self.runner.fetch_external_modules(self.rules, {})
        self.assertEqual(before, self.snapshot())
        self.assertTrue(script.is_symlink())

    def test_compatible_js_keeps_upstream_url_and_removes_old_owned_wrappers(self):
        old = self.root / (qx_scripts.SCRIPT_DIRECTORY + "/qx-" + "a" * 64 + ".js")
        old.parent.mkdir(parents=True)
        old.write_text(qx_scripts.GENERATED_HEADER + "\n// obsolete generated wrapper\n")
        manual = old.parent / "manual.js"
        manual.write_text("// user script")
        registry = self.root / qx_scripts.OWNERS_FILE
        registry.parent.mkdir(parents=True)
        registry.write_text(json.dumps({"version": 1, "files": {
            old.relative_to(self.root).as_posix(): hashlib.sha256(old.read_bytes()).hexdigest(),
            manual.relative_to(self.root).as_posix(): hashlib.sha256(manual.read_bytes()).hexdigest(),
        }}))
        text = "\ufeff#!name = 中文标题\n^https://example.invalid/ url script-response-body " + JS_URL + "\n"
        with patch.object(qx_scripts, "can_use_upstream", return_value=True):
            plan = self.prepare({SOURCE_URL: text})
        self.assertEqual(plan.scripts, {})
        converted = plan.source_text(SOURCE_URL, "Generic.sgmodule", "")
        self.assertIn("中文标题_1 = type=http-response", converted)
        self.assertIn("script-path=" + JS_URL, converted)
        self.assertNotIn(qx_scripts.RAW_SCRIPT_BASE, converted)
        self.runner.fetch_external_modules(self.rules, {SOURCE_URL: text}, prepared_qx=plan)
        self.assertFalse(old.exists())
        self.assertEqual(manual.read_text(), "// user script")
        self.assertEqual(json.loads(registry.read_text())["files"], {})

    def test_one_incompatible_mode_adapts_every_reference_to_the_same_js(self):
        calls = []
        def compatible(source, mode):
            calls.append(mode)
            return mode != "echo"
        with patch.object(qx_scripts, "can_use_upstream", side_effect=compatible):
            plan = self.prepare()
        text = plan.source_text(SOURCE_URL, "Generic.sgmodule", "")
        self.assertEqual(text.count("script-path=" + qx_scripts.RAW_SCRIPT_BASE + "generic.js"), 3)
        self.assertNotIn(JS_URL, text)
        self.assertIn("echo", calls)

    def test_sources_merge_into_one_bundle_with_effective_title_and_cumulative_labels(self):
        other = "https://example.invalid/another.snippet"
        other_js = "https://example.invalid/another.js"
        self.rules["module"][0]["overrides"] = {"name": "有效模块"}
        self.rules["module"].append({"url": other, "name": "Generic.sgmodule", "overrides": {"name": "ignored"}})
        texts = {SOURCE_URL: QX_SOURCE,
                 other: "[task_local]\n0 0 * * * " + other_js + ", tag=Daily\n"}
        plan = self.prepare(texts)
        self.assertEqual(list(plan.scripts), ["Surge/Module/Scripts/generic.js"])
        self.assertIn("有效模块_1 = ", plan.source_text(SOURCE_URL, "Generic.sgmodule", ""))
        self.assertIn("有效模块_4 = ", plan.source_text(other, "Generic.sgmodule", ""))
        self.assertNotIn("ignored_", plan.source_text(other, "Generic.sgmodule", ""))
        self.assertEqual(next(iter(plan.scripts.values())).count("// BEGIN UPSTREAM SOURCE\n"), 2)

    def test_bundle_collisions_refuse_the_complete_batch(self):
        for names in (("Alpha.sgmodule", "alpha.sgmodule"),
                      ("one/Alpha.sgmodule", "two/Alpha.sgmodule")):
            with self.subTest(names=names):
                self.rules["module"] = [{"url": SOURCE_URL, "name": name, "overrides": {}} for name in names]
                before = self.snapshot()
                with self.assertRaisesRegex(ValueError, "basenames collide"):
                    self.prepare()
                self.assertEqual(before, self.snapshot())

    def test_same_stem_formats_share_only_an_identical_bundle(self):
        self.rules["module"][0]["name"] = "Generic"
        plan = self.prepare()
        self.assertEqual(list(plan.scripts), ["Surge/Module/Scripts/generic.js"])
        self.assertEqual(plan.source_text(SOURCE_URL, "Generic.sgmodule", ""),
                         plan.source_text(SOURCE_URL, "Generic.stoverride", ""))
        self.rules["module"] = [{"url": SOURCE_URL, "name": "Generic.sgmodule", "overrides": {"name": "First"}},
                                {"url": SOURCE_URL, "name": "Generic.stoverride", "overrides": {"name": "Second"}}]
        with self.assertRaisesRegex(ValueError, "conflicting bundles"):
            self.prepare()

    def test_dispatch_selects_only_one_source_by_label_or_unique_http_route(self):
        other = "https://example.invalid/other.snippet"
        other_js = "https://example.invalid/other.js"
        self.rules["module"][0]["overrides"] = {"name": "路由模块"}
        self.rules["module"].append({"url": other, "name": "Generic.sgmodule", "overrides": {}})
        first = ("[rewrite_local]\n^https://example.invalid/(a|ambiguous)$ url script-request-body " + JS_URL
                 + "\n^https://example.invalid/(a|ambiguous)$ url script-response-body " + JS_URL + "\n")
        second = ("[rewrite_local]\n^https://example.invalid/(b|ambiguous)$ url script-request-body " + other_js
                  + "\n[task_local]\n0 0 * * * " + other_js + ", tag=Daily\n")
        bodies = {JS_URL: "globalThis.calls.push('one'); $done({body: 'one:' + $argument});",
                  other_js: "globalThis.calls.push('two'); $done({body: 'two:' + $argument});"}
        plan = self.prepare({SOURCE_URL: first, other: second}, lambda _urls: bodies)
        content = next(iter(plan.scripts.values()))
        cases = [
            ({"$script": {"name": "路由模块_3"}, "$request": {"url": "https://example.invalid/a"}}, "two"),
            ({"$request": {"url": "https://example.invalid/a"}}, "one"),
            ({"$request": {"url": "https://example.invalid/a"}, "$response": {"body": "body"}}, "one"),
            ({"$script": {"name": "renamed"}, "$request": {"url": "https://example.invalid/b"}}, "two"),
            ({"$script": {"name": "路由模块_4", "type": "cron"}}, "two"),
        ]
        for context, selected in cases:
            with self.subTest(context=context):
                context["$argument"] = "user-value"
                actual = self.run_bundle(content, context)
                self.assertEqual(actual, {"result": {"body": selected + ":user-value"}, "count": 1, "calls": [selected]})
        for context in ({"$request": {"url": "https://example.invalid/ambiguous"}},
                        {"$script": {"type": "cron"}},
                        {"$request": {"url": "https://example.invalid/unknown"}}):
            self.assertEqual(self.run_bundle(content, context), {"result": {}, "count": 1, "calls": []})

    def test_prepared_batch_rejects_changed_output_name_or_title(self):
        plan = self.prepare()
        for changes in ({"name": "Changed.sgmodule"}, {"overrides": {"name": "Changed"}}):
            changed = [{**self.rules["module"][0], **changes}]
            with self.assertRaisesRegex(ValueError, "does not match"):
                plan.validate_inputs(self.root, changed, {SOURCE_URL: QX_SOURCE})


if __name__ == "__main__":
    unittest.main()
