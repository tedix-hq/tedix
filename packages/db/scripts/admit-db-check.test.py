import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest


class AdmissionTest(unittest.TestCase):
    def test_two_checkouts_serialize_and_release_after_exit(self):
        wrapper = str(Path(__file__).with_name("admit-db-check.py").resolve())
        with tempfile.TemporaryDirectory() as root:
            env = dict(os.environ, HOME=root)
            env.pop("TEDIX_DB_CHECK_FD", None)
            checkouts = [Path(root) / name for name in ("checkout-a", "checkout-b")]
            for checkout in checkouts:
                checkout.mkdir()
            marker = Path(root) / "admitted"
            first = subprocess.Popen([
                "python3", wrapper, "python3", "-c",
                f"from pathlib import Path; import time; Path({str(marker)!r}).touch(); time.sleep(0.5)",
            ], cwd=checkouts[0], env=env, stdout=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(marker.exists())
            second = subprocess.Popen([
                "python3", wrapper, "python3", "-c", "print('second admitted')",
            ], cwd=checkouts[1], env=env, stdout=subprocess.PIPE, text=True)
            time.sleep(0.1)
            self.assertIsNone(second.poll())
            self.assertEqual(first.wait(timeout=5), 0)
            output, _ = second.communicate(timeout=5)
            self.assertEqual(second.returncode, 0)
            self.assertIn("second admitted", output)
            first.stdout.close()


if __name__ == "__main__":
    unittest.main()
