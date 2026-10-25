"""Offline checks for reusing the Surge aggregator with converted sources."""
import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))


class AggregateInputTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("sync_modules_aggregate", SCRIPTS / "sync-modules.py")
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.module.OUTPUT_FILE = self.root / "BlockAds.sgmodule"
        self.output = self.root / "BlockAdsBeta.sgmodule"
        self.sources = {
            "zulu": (
                "#!name=Zulu去广告\n#!arguments=enabled:true\n"
                "#!arguments-desc=enabled:Upstream choice\n#!date=2026-01-02\n"
                "[MITM]\nhostname = %APPEND% api.zulu.example\n"
                "[Script]\nZulu = type=http-response,pattern=^https://api\\.zulu\\.example/,"
                "script-path=https://example.invalid/zulu_remove.js,argument={{{enabled}}}\n"
            ),
            "alpha": (
                "#!name=Alpha去广告\n[Rule]\nDOMAIN,api.alpha.example,REJECT\n"
                "[Script]\nAlpha = type=http-response,pattern=^https://api\\.alpha\\.example/,"
                "script-path=https://example.invalid/alpha_remove.js\n"
                "[MITM]\nhostname = api.alpha.example\n"
            ),
        }
        self.entries = [("zulu", "zulu"), ("alpha", "alpha")]
        self.metadata = {
            "name": "去广告合集 Beta", "desc": "Stable description", "category": "去广告",
            "remark": "Stable remark", "arguments": "Zulu:zulu,Zulu-enabled:false,Alpha:alpha",
            "arguments-desc": "Zulu:Keep exactly\\nZulu-enabled:Do not regenerate",
        }

    def aggregate(self, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()):
            return self.module.aggregate(**kwargs)

    def test_converted_sources_preserve_headers_and_existing_rendering(self):
        original_metadata = dict(self.metadata)
        with patch.object(self.module, "load_urls") as load, patch.object(self.module, "prefetch_urls") as fetch:
            content = self.aggregate(url_alias_list=self.entries, source_texts=self.sources,
                                     output_file=self.output, metadata=self.metadata,
                                     preserve_arguments=True)
        load.assert_not_called()
        fetch.assert_not_called()
        self.assertFalse(self.module.OUTPUT_FILE.exists())
        self.assertEqual(content, self.output.read_text(encoding="utf-8"))
        self.assertEqual(self.metadata, original_metadata)
        header = self.module.parse_sgmodule(content)["meta"]
        for key, value in self.metadata.items():
            self.assertEqual(header[key], value)
        self.assertRegex(header["date"], r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")
        self.assertIn("hostname = %APPEND% api.{{{Alpha}}}.example, api.{{{Zulu}}}.example", content)
        self.assertIn("argument={{{Zulu-enabled}}}", content)
        self.assertIn("pattern=^https://api\\.{{{Zulu}}}\\.example/", content)
        self.assertIn("script-path=https://example.invalid/zulu_remove.js", content)
        self.assertLess(content.index("# > Alpha去广告", content.index("[Script]")),
                        content.index("# > Zulu去广告", content.index("[Script]")))

    def test_injected_defaults_match_regular_aggregate(self):
        self.module.OUTPUT_FILE.write_text("#!name=Fixture\n#!desc=Description\n", encoding="utf-8")
        with patch.object(self.module, "load_urls", return_value=self.entries), \
             patch.object(self.module, "prefetch_urls", return_value=self.sources) as fetch, \
             patch.object(self.module, "datetime") as clock:
            clock.now.return_value.strftime.return_value = "2026-01-01 12:00:00"
            regular = self.aggregate()
            fetch.assert_called_once_with(["zulu", "alpha"], self.module._UA, encode=True)
            injected = self.aggregate(url_alias_list=self.entries, source_texts=self.sources,
                                      output_file=self.output,
                                      metadata={"name": "Fixture", "desc": "Description"})
        self.assertEqual(regular, injected)

    def test_missing_converted_source_preserves_previous_output(self):
        self.output.write_text("previous complete output", encoding="utf-8")
        with patch.object(self.module, "prefetch_urls") as fetch:
            with self.assertRaisesRegex(ValueError, "alpha"):
                self.aggregate(url_alias_list=self.entries, source_texts={"zulu": self.sources["zulu"]},
                               output_file=self.output, metadata=self.metadata, preserve_arguments=True)
        fetch.assert_not_called()
        self.assertEqual(self.output.read_text(encoding="utf-8"), "previous complete output")

    def test_date_only_refresh_preserves_bytes_but_rule_change_writes_new_stamp(self):
        old = '#!name=Fixture\n#!date=2026-01-01 12:00:00\n[Rule]\nDOMAIN,old.example,REJECT\n'
        self.output.write_text(old, encoding="utf-8")
        refreshed = old.replace('2026-01-01', '2026-01-02')
        self.assertFalse(self.module._write_stamped_if_changed(self.output, refreshed))
        self.assertEqual(self.output.read_bytes(), old.encode())
        changed = refreshed.replace('old.example', 'new.example')
        self.assertTrue(self.module._write_stamped_if_changed(self.output, changed))
        self.assertEqual(self.output.read_bytes(), changed.encode())


if __name__ == "__main__":
    unittest.main()
