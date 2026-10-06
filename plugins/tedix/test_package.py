import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("tedix_package", Path(__file__).with_name("package.py"))
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PackageTest(unittest.TestCase):
    def test_cloud_has_one_identity_and_no_local_or_operational_files(self):
        files = package.package_files()
        self.assertIn("skills/tedix-session-guide/SKILL.md", files)
        self.assertIn("mcp.json", files)
        self.assertFalse(any(name.startswith(("hooks/", "review/", ".")) for name in files))
        self.assertNotIn("package.py", files)
        self.assertEqual(json.loads(files["plugin.json"])["name"], "tedix")
        self.assertEqual(json.loads(files["plugin.json"])["extensions"]["com.openai"]["review"]["test_cases"],
                         json.loads((package.ROOT / "review/cases.json").read_text()))

    def test_local_adds_only_existing_hooks_and_compatibility(self):
        cloud = package.package_files()
        local = package.package_files(local=True)
        self.assertEqual(set(local) - set(cloud), {
            ".mcp.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json",
            "hooks/hooks.json", "hooks/session_start.py", "hooks/user_prompt_submit.py", "hooks/decision_capture.py",
            "hooks/agent_status.py"})
        hooks = json.loads(local["hooks/hooks.json"])["hooks"]
        self.assertEqual(set(hooks), {"SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "PermissionRequest",
                                      "Notification", "PostToolUse", "SessionEnd"})
        # The status reporter observes every turn boundary but always runs in the background.
        status = [handler for definitions in hooks.values() for definition in definitions
                  for handler in definition["hooks"] if "agent_status.py" in handler["command"]]
        self.assertEqual(len(status), 7)
        self.assertTrue(all(handler["async"] for handler in status))
        # Recording handlers run in the background and cannot block or steer the session.
        capture = [handler for definitions in hooks.values() for definition in definitions
                   for handler in definition["hooks"] if "decision_capture.py" in handler["command"]]
        self.assertEqual(len(capture), 2)
        self.assertTrue(all(handler["async"] for handler in capture))
        self.assertEqual(json.loads(local[".codex-plugin/plugin.json"])["name"], "tedix")

    def test_reproducible_and_does_not_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            first, second = Path(directory) / "first.zip", Path(directory) / "second.zip"
            package.build(first)
            package.build(second)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with zipfile.ZipFile(first) as archive:
                self.assertEqual(set(archive.namelist()), set(package.package_files()))
            with self.assertRaises(FileExistsError):
                package.build(first)

    def test_claude_uses_native_format_and_no_cloud_executables(self):
        files = package.package_files(host="claude")
        self.assertEqual(json.loads(files[".claude-plugin/plugin.json"])["name"], "tedix")
        self.assertEqual(json.loads(files[".mcp.json"]), {"mcpServers": {
            "tedix": {"type": "http", "url": "https://connect.mcp.tedix.dev/mcp"}}})
        self.assertEqual(json.loads(files[".mcp.json"]),
                         json.loads((package.ROOT / ".mcp.json").read_text()))
        self.assertNotIn("plugin.json", files)
        self.assertNotIn("mcp.json", files)
        self.assertFalse(any(name.startswith(("hooks/", ".codex-plugin/", "review/")) for name in files))
        self.assertEqual({name for name in files if name.startswith("skills/")},
                         {name for name in package.package_files() if name.startswith("skills/")})

    def test_claude_local_hooks_are_native_and_not_duplicated(self):
        files = package.package_files(host="claude", local=True)
        manifest = json.loads(files[".claude-plugin/plugin.json"])
        self.assertNotIn("hooks", manifest)
        self.assertNotIn("mcpServers", manifest)
        hooks = json.loads(files["hooks/hooks.json"])["hooks"]
        self.assertEqual(set(hooks), {"SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "PermissionRequest",
                                      "Notification", "PostToolUse", "SessionEnd"})
        for definitions in hooks.values():
            for definition in definitions:
                for handler in definition["hooks"]:
                    self.assertNotIn("additionalContextLimit", handler)
                    self.assertEqual(handler["command"], "python3")
                    self.assertTrue(handler["args"][0].startswith("${CLAUDE_PLUGIN_ROOT}/hooks/"))
                    self.assertEqual(handler["args"][1:], ["stop"] if definition is hooks["Stop"][0] else
                                     ["reply"] if "decision_capture" in handler["args"][0] else [])
        self.assertEqual(files["hooks/session_start.py"],
                         (package.ROOT / "hooks/session_start.py").read_bytes())
        self.assertEqual(files["hooks/agent_status.py"],
                         (package.ROOT / "hooks/agent_status.py").read_bytes())

    def test_explicit_local_endpoint_and_remote_validation(self):
        for url in ("http://localhost:8787/mcp", "http://127.0.0.1:8787/mcp", "http://[::1]:8787/mcp", "http://local-tedix-unified.localhost:3000/mcp"):
            files = package.package_files(host="claude", local=True, mcp_url=url)
            self.assertEqual(json.loads(files[".mcp.json"])["mcpServers"]["tedix"]["url"], url)
            with self.assertRaises(ValueError):
                package.package_files(host="claude", mcp_url=url)
        for url in ("http://example.com/mcp", "http://localhost.example.com/mcp", "http://.localhost/mcp", "https://user:secret@example.com/mcp",
                    "https://example.com/mcp?token=secret", "https://example.com/mcp#token",
                    "https://example.com:bad/mcp", "file:///tmp/mcp", "https://example.com\\evil/mcp"):
            with self.assertRaises(ValueError):
                package.package_files(host="claude", local=True, mcp_url=url)
        files = package.package_files(host="claude", mcp_url="https://example.com/mcp")
        self.assertEqual(json.loads(files[".mcp.json"])["mcpServers"]["tedix"]["url"], "https://example.com/mcp")
        with self.assertRaises(ValueError):
            package.package_files(mcp_url="https://example.com/mcp")
        with self.assertRaises(ValueError):
            package.package_files(host="unknown")

    def test_local_bearer_is_only_an_explicit_environment_reference(self):
        files = package.package_files(host="claude", local=True, mcp_url="http://localhost:3000/mcp",
                                      mcp_bearer_env="TEDIX_MCP_BEARER_TOKEN")
        self.assertEqual(json.loads(files[".mcp.json"])["mcpServers"]["tedix"]["headers"],
                         {"Authorization": "Bearer ${TEDIX_MCP_BEARER_TOKEN}"})
        for options in ({}, {"host": "claude"}, {"host": "claude", "local": True},
                        {"host": "claude", "local": True, "mcp_url": "http://localhost:3000/mcp",
                         "mcp_bearer_env": "secret-token"}):
            with self.assertRaises(ValueError):
                package.package_files(**({"mcp_bearer_env": "TOKEN"} | options))

    def test_claude_reproducible_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            for local in (False, True):
                first = Path(directory) / f"first-{local}.zip"
                second = Path(directory) / f"second-{local}.zip"
                package.build(first, host="claude", local=local)
                package.build(second, host="claude", local=local)
                self.assertEqual(first.read_bytes(), second.read_bytes())


if __name__ == "__main__":
    unittest.main()
