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
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))

    def snapshot(self):
        return {p.relative_to(self.root).as_posix(): p.read_bytes()
                for p in self.root.rglob("*") if p.is_file()}

    def prepare(self, texts=None, download=None):
        return qx_scripts.prepare_qx_modules(
            self.rules["module"], texts or {SOURCE_URL: QX_SOURCE}, self.root,
            download or (lambda urls: {url: SOURCE_JS for url in urls}))

    def test_all_modes_share_url_namespace_and_preserve_exact_upstream_js(self):
        other = "https://example.invalid/other.snippet"
        self.rules["module"].append({"url": other, "name": "Other.sgmodule", "overrides": {}})
        texts = {SOURCE_URL: QX_SOURCE,
                 other: "[task_local]\n0 0 * * * " + JS_URL + ", tag=Daily\n"}
        calls = []
        plan = self.prepare(texts, lambda urls: calls.append(urls) or {JS_URL: SOURCE_JS})
        self.assertEqual(calls, [[JS_URL]])
        self.assertEqual(len(plan.scripts), 4)
        labels = []
        for converted in plan.converted.values():
            labels.extend(line.split(" = ", 1)[0] for line in converted.splitlines()
                          if " = type=" in line)
        self.assertEqual(len(labels), len(set(labels)))
        namespace = "qx-" + hashlib.sha256(JS_URL.encode()).hexdigest()
        for relative, content in plan.scripts.items():
            self.assertRegex(relative, r"^Surge/Module/Scripts/qx-[0-9a-f]{64}\.js$")
            self.assertIn(json.dumps(namespace), content)
            extracted = content.split("// BEGIN UPSTREAM SOURCE\n", 1)[1].split("\n// END UPSTREAM SOURCE", 1)[0]
            self.assertEqual(extracted, SOURCE_JS)
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

    def test_standalone_call_downloads_configs_then_one_deduplicated_script_batch(self):
        calls = []
        def download(urls, ua, **options):
            calls.append(list(urls))
            self.assertTrue(options["encode"])
            return {SOURCE_URL: QX_SOURCE} if SOURCE_URL in urls else {JS_URL: SOURCE_JS}
        with patch.object(self.runner, "prefetch_urls", side_effect=download):
            self.runner.fetch_external_modules()
        self.assertEqual(calls, [[SOURCE_URL], [JS_URL]])
        self.assertEqual(len(list((self.root / "Surge/Module/Scripts").glob("qx-*.js"))), 3)

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
        scripts = sorted(self.root.glob("Surge/Module/Scripts/qx-*.js"))
        edited = scripts[0]
        edited.write_text(edited.read_text() + "// local edit\n")
        manual = self.root / "Surge/Module/Scripts/ip-security.js"
        manual.write_text("manual script")
        unknown = self.root / (qx_scripts.SCRIPT_DIRECTORY + "/qx-" + "f" * 64 + ".js")
        unknown.write_text(qx_scripts.GENERATED_HEADER + "\n// not registered\n")
        expected = {edited: edited.read_bytes(), manual: manual.read_bytes(), unknown: unknown.read_bytes()}
        self.rules["module"] = []
        self.runner.fetch_external_modules(self.rules, {})
        for path, content in expected.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertTrue(all(not path.exists() for path in scripts[1:]))
        self.assertEqual(json.loads((self.root / qx_scripts.OWNERS_FILE).read_text())["files"], {})

    def test_local_edits_and_invalid_registry_refuse_the_whole_batch(self):
        plan = self.prepare()
        self.runner.fetch_external_modules(self.rules, {SOURCE_URL: QX_SOURCE}, prepared_qx=plan)
        script = next(self.root.glob("Surge/Module/Scripts/qx-*.js"))
        script.write_text(script.read_text() + "// locally changed\n")
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "local edits"):
            self.prepare()
        self.assertEqual(before, self.snapshot())
        registry = self.root / qx_scripts.OWNERS_FILE
        registry.write_text(json.dumps({"version": 1, "files": {"Surge/Module/Scripts/ip-security.js": "f" * 64}}))
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
        script = next(self.root.glob("Surge/Module/Scripts/qx-*.js"))
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


if __name__ == "__main__":
    unittest.main()
