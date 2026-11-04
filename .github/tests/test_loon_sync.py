"""Offline coverage for the Loon Module entry point and pre-publication checks."""
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
import loon_convert
from module_convert import merge_modules, parse_module


URL = "https://example.invalid/sample.plugin"
JS_URL = "https://example.invalid/filter.js"
ORIGINAL = ("#!name=Loon fixture\n#!desc=Description\n#!original=Reference\n#!tag=Ads\n"
            "#!loon_version=3.5.3\n[Rule]\nDOMAIN,ads.example.invalid,REJECT\n"
            "[Script]\nresponse if ${url} ~= /^https:\\/\\/api\\.example\\.invalid\\//i "
            "then script(\"" + JS_URL + "\") with requires_body=true, binary_body_mode=true, timeout=30\n"
            "[MitM]\nhostname = api.example.invalid\n")
CONVERTED = ("#!name=Loon fixture\n#!desc=Description\n#!original=Reference\n#!category=Ads\n"
             "#!loon_version=3.5.3\n[Rule]\nDOMAIN,ads.example.invalid,REJECT\n"
             "[Script]\nfilter = type=http-response, pattern=(?i)^https://api\\.example\\.invalid/, "
             "requires-body=true, binary-body-mode=true, timeout=30, script-path=" + JS_URL + "\n"
             "[MITM]\nhostname = %APPEND% api.example.invalid\n")
SOURCE = 'const decoder=new TextDecoder();$done({status:"HTTP/1.1 404 Not Found",body:$response.body});\n'
PARSER = "verified parser fixture"


def result(text=CONVERTED, **extra):
    return {"id": "0", "text": text, "diagnostics": [], "unsupported": False, **extra}


def load_runner():
    spec = importlib.util.spec_from_file_location("loon_sync_fixture", SCRIPTS / "sync-rules.py")
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    return runner


class LoonConversionTests(unittest.TestCase):
    def converted(self, rows=None, sources=None, download=None):
        payload = {"results": rows if rows is not None else [result()]}
        run = subprocess.CompletedProcess([], 0, json.dumps(payload), "")
        with patch.object(loon_convert, "PARSER_SHA256", hashlib.sha256(PARSER.encode()).hexdigest()), \
                patch.object(loon_convert.subprocess, "run", return_value=run):
            return loon_convert.convert_loon_sources(sources or {URL: ORIGINAL},
                download or (lambda urls: {url: PARSER for url in urls}))

    def test_detection_uses_executable_syntax_or_extension_not_inherited_metadata(self):
        self.assertTrue(loon_convert.is_loon_module(URL, ORIGINAL))
        self.assertTrue(loon_convert.is_loon_module("https://example.invalid/a.LPX?version=one", ORIGINAL))
        self.assertTrue(loon_convert.is_loon_module("https://example.invalid/no-extension", ORIGINAL))
        native = '#!loon_version=3.5.3\n[Script]\nNative = type=http-response,script-path=https://example.invalid/native.js\n'
        self.assertFalse(loon_convert.is_loon_module("https://example.invalid/native.sgmodule", native))
        self.assertFalse(loon_convert.is_loon_module("https://example.invalid/sample.snippet", "[rewrite_local]\n"))

    def test_metadata_keeps_reference_in_description_and_removes_loon_only_fields(self):
        text = self.converted()[URL]
        metadata, _ = parse_module(text)
        self.assertEqual(metadata["desc"], r"Description\nReference")
        self.assertEqual(metadata["category"], "Ads")
        self.assertFalse({"original", "tag", "loon_version"} & metadata.keys())
        self.assertEqual(loon_convert.normalize_loon_metadata(ORIGINAL, text), text)
        for original, expected_desc in [(ORIGINAL.replace("#!desc=Description\n", ""), "Reference"),
                                        (ORIGINAL.replace("Reference", r"Reference\nSecond"), r"Description\nReference\nSecond")]:
            converted = CONVERTED.replace("#!desc=Description\n", "") if expected_desc == "Reference" else CONVERTED
            normalized = loon_convert.normalize_loon_metadata(original, converted)
            self.assertEqual(parse_module(normalized)[0]["desc"], expected_desc)
            self.assertEqual(loon_convert.normalize_loon_metadata(original, normalized), normalized)

    def test_explicit_source_and_manifest_categories_take_precedence(self):
        source = ORIGINAL.replace("#!tag=Ads", "#!tag=Ads\n#!category=Source category")
        converted = self.converted(sources={URL: source})[URL]
        self.assertEqual(parse_module(converted)[0]["category"], "Source category")
        metadata, _, _ = merge_modules([(URL, converted, {"category": "User category"})])
        self.assertEqual(metadata["category"], "User category")

    def test_other_metadata_key_spelling_is_preserved(self):
        extra = "#!openUrl=https://example.invalid/app\n#!bundleId=example.App\n#!basedOn=iOS\n"
        converted = CONVERTED.replace("[Rule]", extra + "[Rule]")
        normalized = loon_convert.normalize_loon_metadata(ORIGINAL, converted)
        metadata, _ = parse_module(normalized)
        self.assertEqual(metadata["openUrl"], "https://example.invalid/app")
        self.assertEqual(metadata["bundleId"], "example.App")
        self.assertEqual(metadata["basedOn"], "iOS")
        self.assertNotIn("openurl", metadata)
        self.assertEqual(loon_convert.normalize_loon_metadata(ORIGINAL, normalized), normalized)

    def test_parser_and_remote_dependencies_are_downloaded_as_one_verified_batch(self):
        dependency = "https://example.invalid/transform.jq"
        source = ORIGINAL + f"\nresponse.json.jq_file(\"{dependency}\")\n"
        calls = []
        def download(urls):
            calls.append(urls)
            return {loon_convert.PARSER_URL: PARSER, dependency: ".fixture"}
        self.converted(sources={URL: source}, download=download)
        self.assertEqual(calls, [[loon_convert.PARSER_URL, dependency]])
        with patch.object(loon_convert.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "verification"):
                loon_convert.convert_loon_sources({URL: ORIGINAL}, lambda urls: {loon_convert.PARSER_URL: "wrong"})
            run.assert_not_called()

    def test_quoted_script_arguments_do_not_override_real_script_options(self):
        argument = 'argument="literal,type=not-a-script,script-path=https://example.invalid/not-real.js"'
        converted = CONVERTED.replace("script-path=" + JS_URL, "script-path=" + JS_URL + ", " + argument)
        output = self.converted([result(text=converted)])[URL]
        self.assertIn(argument, output)
        self.assertIn("type=http-response", output)

    def test_unknown_parser_results_fail_without_repeating_source_content(self):
        invalid = [[result(error="private token=hidden")], [result(unsupported=True)],
                   [result(diagnostics=[{"level": "warning", "message": "private source"}])],
                   [result(diagnostics=[{"level": "error", "message": "private source"}])],
                   [result(diagnostics=None)], [result(diagnostics=["private source"])],
                   [result(text="")], [result(id="missing")], [],
                   [result(text=ORIGINAL)]]
        for rows in invalid:
            with self.subTest(rows=rows):
                with self.assertRaises((ValueError, RuntimeError)) as caught:
                    self.converted(rows)
                self.assertNotIn("private", str(caught.exception))

    def test_native_sources_require_no_parser_download(self):
        with tempfile.TemporaryDirectory() as directory:
            native = "#!name=Native\n[Rule]\nDOMAIN,example.invalid,REJECT\n"
            entry = {"url": "https://example.invalid/native.sgmodule", "name": "Native.sgmodule", "overrides": {}}
            def unexpected(urls):
                self.fail("Native source requested Loon downloads")
            plan = loon_convert.prepare_loon_modules([entry], {entry["url"]: native}, Path(directory), unexpected)
            self.assertEqual(plan.sources[entry["url"]], native)
            self.assertEqual(plan.scripts, {})


class LoonSyncTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.runner = load_runner()
        self.runner.REPO_ROOT = self.root
        self.runner.SYNC_RULES_TXT = self.root / "sync-rules.txt"
        self.runner.SYNC_RULES_TXT.write_text("# >> Module\n" + URL + ",Generic.sgmodule\n")
        self.rules = {"surge": [], "surge_domainset": [], "clash": [], "module": [
            {"url": URL, "name": "Generic.sgmodule", "overrides": {"name": "User title", "category": "User category"}}]}

    def snapshot(self):
        return {path.relative_to(self.root).as_posix(): path.read_bytes()
                for path in self.root.rglob("*") if path.is_file()}

    def prepare(self):
        with patch.object(loon_convert, "convert_loon_sources", return_value={URL: loon_convert.normalize_loon_metadata(ORIGINAL, CONVERTED)}):
            return loon_convert.prepare_loon_modules(self.rules["module"], {URL: ORIGINAL}, self.root,
                                                      lambda urls: {url: SOURCE for url in urls})

    def test_prepared_native_sources_pass_through_qx_and_render_targeted_loon_adapter(self):
        plan = self.prepare()
        self.assertEqual(self.snapshot(), {"sync-rules.txt": self.runner.SYNC_RULES_TXT.read_bytes()})
        with patch.object(self.runner, "prefetch_urls") as fetch, contextlib.redirect_stdout(io.StringIO()):
            self.runner.fetch_external_modules(self.rules, {URL: ORIGINAL}, prepared_loon=plan)
        fetch.assert_not_called()
        text = (self.root / "Surge/Module/Generic.sgmodule").read_text()
        metadata, sections = parse_module(text)
        self.assertEqual(metadata["category"], "User category")
        self.assertEqual(metadata["desc"], r"Description\nReference")
        self.assertIn("User title_1", text)
        self.assertIn("/generic.js", text)
        self.assertIn("engine=webview", text)
        self.assertIn("binary-body-mode=true", text)
        self.assertIn("timeout=30", text)
        self.assertNotIn("response if", text)
        self.assertFalse((self.root / ".github/scripts/qx-scripts-owned.json").exists())
        self.assertTrue((self.root / ".github/scripts/loon-scripts-owned.json").exists())

    def test_conversion_failure_precedes_all_upstream_writes(self):
        with patch.object(self.runner, "_check_idle_streaming"), \
                patch.object(self.runner, "parse_sync_rules", return_value=self.rules), \
                patch.object(self.runner, "prefetch_urls", return_value={URL: ORIGINAL}), \
                patch.object(self.runner, "prepare_loon_modules", side_effect=ValueError("unsupported Loon source")), \
                patch.object(self.runner, "fetch_external_rules") as rules, \
                patch.object(self.runner, "fetch_external_modules") as modules, \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError, "unsupported"):
                self.runner.main()
        rules.assert_not_called()
        modules.assert_not_called()

    def test_cross_plan_basename_collision_is_rejected_before_writes(self):
        plan = self.prepare()
        fake = type("FakeQx", (), {"scripts": dict(plan.scripts)})()
        with self.assertRaisesRegex(ValueError, "same generated script path"):
            self.runner._check_script_plan_collisions(plan, fake)


if __name__ == "__main__":
    unittest.main()
