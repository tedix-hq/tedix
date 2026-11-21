"""Run with python3 scripts/db/test_verify_history_pack.py (standard library only)."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("verifier", Path(__file__).with_name("verify-history-pack.py"))
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class PackIntegrity(unittest.TestCase):
    def test_integrity_scope_counts_and_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            row = {"id": "event", "organization_id": "org_example", "timestamp": 1767225600}
            data = (json.dumps(row) + "\n").encode()
            path = root / "events.ndjson"
            path.write_bytes(data)
            manifest = {
                "format": "tedix-history-pack/v1", "organization": "org_example",
                "from": "2026-01-01T00:00:00Z", "to": "2026-02-01T00:00:00Z",
                "tables": [{"table": "audit_events", "time": "timestamp", "epoch": True, "owner": "organization_id"}],
                "files": [{"path": path.name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
                           "table": "audit_events", "source": "DB", "rows": 1,
                           "from": "2026-01-01T00:00:00Z", "to": "2026-01-01T00:00:00Z"}],
                "scans": [{"table": "audit_events", "source": "DB", "rows": 1}],
            }

            def save(value):
                raw = json.dumps(value).encode()
                (root / "manifest.json").write_bytes(raw)
                return hashlib.sha256(raw).hexdigest()

            digest = save(manifest)
            self.assertEqual(verifier.verify(root, digest)["verifiedFiles"], 1)
            path.write_bytes(data.replace(b'"event"', b'"other"'))
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                verifier.verify(root, digest)
            path.write_bytes(data)
            (root / "manifest.json").write_text("{}")
            with self.assertRaisesRegex(ValueError, "Manifest SHA-256"):
                verifier.verify(root, digest)
            digest = save(manifest)
            path.unlink()
            with self.assertRaises(FileNotFoundError):
                verifier.verify(root, digest)
            path.write_bytes(data)
            for field, value in [("rows", 2), ("from", "2026-01-02T00:00:00Z"), ("path", "../events.ndjson")]:
                with self.subTest(field=field):
                    changed = copy.deepcopy(manifest)
                    changed["files"][0][field] = value
                    with self.assertRaises(ValueError):
                        verifier.verify(root, save(changed))
            changed = copy.deepcopy(manifest)
            changed["organization"] = "org_other"
            with self.assertRaisesRegex(ValueError, "Tenant"):
                verifier.verify(root, save(changed))
            changed = copy.deepcopy(manifest)
            changed["from"] = "2026-01-02T00:00:00Z"
            with self.assertRaisesRegex(ValueError, "outside"):
                verifier.verify(root, save(changed))
            changed = copy.deepcopy(manifest)
            changed["scans"][0]["rows"] = 0
            with self.assertRaisesRegex(ValueError, "Scan count"):
                verifier.verify(root, save(changed))


if __name__ == "__main__":
    unittest.main()
