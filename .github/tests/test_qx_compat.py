"""Direct URLs require a conservative shared-API proof, never an app exception."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from qx_compat import can_use_upstream, requires_binary_body


SHARED = r'''
const url = (typeof $request !== "undefined" && $request && $request.url) || "";
const body = typeof $response !== "undefined" && $response ? $response.body : "";
if (!body) { $done({}); }
else {
  const obj = JSON.parse(body);
  if (/\/feed\/[a-z]+(?:\?|$)/.test(url)) obj.data = [];
  $done({body: JSON.stringify(obj)});
}
'''


class QxCompatibilityTests(unittest.TestCase):
    def test_native_byte_access_selects_binary_mode_without_app_names(self):
        for source in (
            '$done({bodyBytes:$request.bodyBytes});',
            'const bytes=$response?.bodyBytes; $done({});',
            'const bytes=($response)["bodyBytes"]; $done({});',
            'const bytes=$request?.["body"+"Bytes"]; $done({});',
            'const original=$request; const alias=original; $done({bodyBytes:alias.bodyBytes});',
            'const {bodyBytes:bytes}=$response',
            'const {headers, "bodyBytes":bytes}=$request; $done({});',
        ):
            with self.subTest(source=source):
                self.assertTrue(requires_binary_body(source))
                self.assertFalse(can_use_upstream(source, "response-body"))

    def test_non_native_bytes_mentions_do_not_select_binary_mode(self):
        for source in (
            '// $response.bodyBytes\n$done({body:$response.body});',
            'const note="$request.bodyBytes"; $done({});',
            'const pattern=/\\$response.bodyBytes/; $done({});',
            'const response={bodyBytes:1}; $done({body:response.bodyBytes});',
            'const url=$request.url; const part=url.split("/")[index]; $done({body:part});',
            'const {body:bodyBytes}=$response; $done({body:bodyBytes});',
            'const {headers:{bodyBytes}}=$response; $done({});',
            '$task.fetch({url:"https://example.invalid"}).then(r=>$done({bodyBytes:r.bodyBytes}));',
            'const note=`ordinary ${value}`; $done({body:$response.body});',
            '$response.bodyBytes=new ArrayBuffer(0); $done({});',
        ):
            with self.subTest(source=source):
                self.assertFalse(requires_binary_body(source))

    def test_dynamic_computed_native_reads_fail_instead_of_assuming_text_mode(self):
        for source in (
            'const key="bodyBytes"; $done({body:$response[key]});',
            'const req=$request; $done({body:req[property]});',
            '$done({body:$response?.[getProperty()]});',
        ):
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, "binary body requirements"):
                requires_binary_body(source)
        self.assertFalse(requires_binary_body('$response[property]=value; $done({});'))

    def test_unknown_lexical_forms_with_possible_host_bytes_fail_before_publication(self):
        with self.assertRaisesRegex(ValueError, "binary body requirements"):
            requires_binary_body('const text=`${$response.bodyBytes}`; $done({body:text});')

    def test_shared_body_script_and_input_guards_can_keep_the_upstream_url(self):
        self.assertTrue(can_use_upstream(SHARED, "response-body"))
        self.assertTrue(can_use_upstream('$done({body:$request.body});', "request-body"))
        self.assertTrue(can_use_upstream('$done({"body":JSON.stringify({ok:true})});', "response-body"))
        self.assertTrue(can_use_upstream('$done({body:"value",});', "response-body"))

    def test_echo_cron_and_header_modes_stay_on_the_runtime_path(self):
        for mode in ("echo", "cron", "request", "response", "unknown"):
            with self.subTest(mode=mode):
                self.assertFalse(can_use_upstream(SHARED, mode))

    def test_qx_specific_and_future_globals_require_the_runtime(self):
        for name in ("$prefs", "$notify", "$task", "$configuration", "$futureApi", "$request$", "$$host"):
            with self.subTest(name=name):
                self.assertFalse(can_use_upstream(SHARED + "\n" + name + ";", "response-body"))
        for field in ("statusCode", "sessionIndex", "bodyBytes"):
            self.assertFalse(can_use_upstream(SHARED + '\nconst key="' + field + '";', "response-body"))

    def test_mentions_in_comments_and_strings_can_conservatively_require_wrapping(self):
        self.assertFalse(can_use_upstream(SHARED + "\n// $prefs is not called", "response-body"))
        self.assertFalse(can_use_upstream(SHARED + '\nconst note="$futureApi";', "response-body"))

    def test_aliases_and_computed_native_access_are_not_assumed_compatible(self):
        for text in ('const r=$response; $done({body:r.body});',
                     'const {body}=$response; $done({body});',
                     '$done({body:$response["body"]});',
                     '$done({body:$response["status"+"Code"]});',
                     'const finish=$done; finish({});',
                     'obj.$done({body:"value"});'):
            with self.subTest(text=text):
                self.assertFalse(can_use_upstream(text, "response-body"))

    def test_unknown_completion_shapes_and_status_values_require_wrapping(self):
        for call in ('$done(result)', '$done()', '$done({status:200})',
                     '$done({status:"HTTP/1.1 200 OK",body:""})',
                     '$done({body:"value",headers:{}})', '$done({...result})',
                     '$done({body:JSON.stringify({...result})})',
                     '$done({body:"value"}, another)'):
            with self.subTest(call=call):
                self.assertFalse(can_use_upstream(call, "response-body"))

    def test_dynamic_globals_templates_and_escaped_identifiers_require_wrapping(self):
        for text in ('globalThis["$"+"prefs"]', 'window.$request', 'this["native"]',
                     'eval("source")', 'Function("source")', 'obj.constructor',
                     '`template ${value}`', r'const \u0024prefs=1;'):
            with self.subTest(text=text):
                self.assertFalse(can_use_upstream(SHARED + "\n" + text, "response-body"))

    def test_missing_body_fields_and_mutating_native_objects_are_not_proved(self):
        self.assertFalse(can_use_upstream('$done({body:$request.body});', "response-body"))
        self.assertFalse(can_use_upstream('$response.body="value";$done({});', "response-body"))
        self.assertFalse(can_use_upstream('++$response.body;$done({});', "response-body"))
        self.assertFalse(can_use_upstream('++($response.body);$done({});', "response-body"))
        self.assertFalse(can_use_upstream('($response.body)="value";$done({});', "response-body"))
        self.assertFalse(can_use_upstream('delete $response.body;$done({});', "response-body"))
        self.assertFalse(can_use_upstream('$done({body:$response.headers});', "response-body"))

    def test_comments_strings_and_regex_literals_do_not_confuse_completion_parsing(self):
        script = r'''// $done(not-a-call)
const text="a } ) , body: delimiter";
const pattern=/[{}()]\/body/;
/* a quote ' and $done(in-comment) */
$done({body:text.replace(pattern,"x")});'''
        self.assertTrue(can_use_upstream(script, "response-body"))

    def test_unterminated_or_unrecognized_lexical_forms_and_missing_done_are_unknown(self):
        for text in ('', 'const value=1;', '/* unfinished', '$done({body:"unfinished});',
                     '$done({body:`template`});', '$done({body:1});\nconst 名称=1;'):
            with self.subTest(text=text):
                self.assertFalse(can_use_upstream(text, "response-body"))


if __name__ == "__main__":
    unittest.main()
