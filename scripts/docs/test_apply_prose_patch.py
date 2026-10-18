import copy
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

from apply_prose_patch import blob
from measure_docs import measure


class PatchTests(unittest.TestCase):
    source = '---\ntitle: "Fictional guide"\nsidebar:\n  order: 1\n---\n\n# Fictional guide\n\nA Worker receives ingress.\n\nUse `guide.json` and [the reference](./fictional-reference.md).\n\n```json\n{"schema":"fictional"}\n```\n'

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="fictional-docs-")
        self.root = pathlib.Path(self.folder.name)
        self.path = self.root / "docs" / "fictional-guide.md"
        self.path.parent.mkdir()
        self.path.write_text(self.source)
        self.after = self.source.replace("A Worker receives ingress.", "The service receives requests.")
        self.payload = {"version": 1, "path": "docs/fictional-guide.md", "beforeBlobSha": blob(self.source.encode()), "afterBlobSha": blob(self.after.encode()), "before": {key: measure(self.source)[key] for key in ("jargon", "averageWords", "over25Percent")}, "patches": [{"old": "A Worker receives ingress.", "new": "The service receives requests."}]}

    def tearDown(self):
        self.folder.cleanup()

    def run_patch(self, payload):
        script = pathlib.Path(__file__).with_name("apply_prose_patch.py")
        return subprocess.run([sys.executable, str(script)], input=json.dumps(payload), text=True, capture_output=True, cwd=self.root)

    def test_applies_valid_literal_patch(self):
        result = self.run_patch(self.payload)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.path.read_text(), self.after)
        receipt = json.loads(result.stdout.split(":", 1)[1])
        self.assertLess(receipt["after"]["jargon"], receipt["before"]["jargon"])

    def test_drift_and_invalid_manifest_refuse_before_writes(self):
        cases = []
        for field in ("beforeBlobSha", "afterBlobSha"):
            case = copy.deepcopy(self.payload)
            case[field] = "0" * 40
            cases.append(case)
        case = copy.deepcopy(self.payload)
        case["before"]["jargon"] = 99
        cases.append(case)
        case = copy.deepcopy(self.payload)
        case["measureSource"] = "raise Exception('must never execute input data')"
        cases.append(case)
        cases.extend([[], {**self.payload, "path": "../fictional-guide.md"}])
        for case in cases:
            with self.subTest(case=case):
                result = self.run_patch(case)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.path.read_text(), self.source)

    def test_protected_content_and_no_improvement_refuse_before_writes(self):
        for old, new in [("A Worker receives ingress.", "A Worker still receives ingress."), ("`guide.json`", "`other.json`"), ('{"schema":"fictional"}', '{"schema":"other"}'), ("./fictional-reference.md", "https://example.invalid/other"), ("order: 1", "order: 2")]:
            with self.subTest(old=old):
                case = copy.deepcopy(self.payload)
                case["patches"] = [{"old": old, "new": new}]
                case["afterBlobSha"] = blob(self.source.replace(old, new).encode())
                result = self.run_patch(case)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.path.read_text(), self.source)

    def test_unicode_apostrophes_and_shell_text_are_data(self):
        case = copy.deepcopy(self.payload)
        replacement = "Reader's requests arrive — Grüße. $(printf BAD) is literal."
        case["patches"][0]["new"] = replacement
        expected = self.source.replace("A Worker receives ingress.", replacement)
        case["afterBlobSha"] = blob(expected.encode())
        result = self.run_patch(case)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.path.read_text(), expected)


if __name__ == "__main__":
    unittest.main()
