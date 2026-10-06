"""Checks for the opt-in turn-status reporter: consent, classification, silence and safe reporting."""
import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import agent_status as hook

SESSION = "11111111-1111-4111-8111-111111111111"


class AgentStatusTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name)
        clean = {key: value for key, value in os.environ.items()
                 if not key.startswith(("TEDIX_", "CODEX_"))}
        clean["TEDIX_CONFIG_DIR"] = str(self.base)
        environment = patch.dict(os.environ, clean, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        self.spawned = []
        popen = patch.object(hook.subprocess, "Popen", side_effect=lambda args, **kwargs: self.spawned.append((args, kwargs)))
        popen.start()
        self.addCleanup(popen.stop)
        which = patch.object(hook.shutil, "which", side_effect=lambda name: f"/usr/bin/{name}")
        which.start()
        self.addCleanup(which.stop)
        platform = patch.object(hook.sys, "platform", "darwin")
        platform.start()
        self.addCleanup(platform.stop)
        label = patch.object(hook, "label_for", return_value="repo · main")
        label.start()
        self.addCleanup(label.stop)

    def enable(self, **config):
        (self.base / "agent-status.json").write_text(json.dumps({"enabled": True, "profile": "connect", **config}))

    def fire(self, event, **fields):
        payload = {"session_id": SESSION, "cwd": "/work/repo", "hook_event_name": event, **fields}
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            hook.run(io.StringIO(json.dumps(payload)))
        self.assertEqual(stdout.getvalue(), "")
        return payload

    def state(self, harness="claude-code"):
        path = self.base / "agent-status" / f"{harness}-{SESSION}.json"
        return json.loads(path.read_text()) if path.exists() else None

    def notifications(self):
        return [args for args, _ in self.spawned if args[0] == "osascript"]

    def reports(self):
        return [args for args, _ in self.spawned if args[0] == "tedix"]

    def test_disabled_has_no_output_or_side_effects(self):
        self.fire("PermissionRequest", tool_name="Bash", tool_input={"command": "rm -rf build"})
        self.assertFalse((self.base / "agent-status").exists())
        self.assertEqual(self.spawned, [])
        self.enable()
        with patch.dict(os.environ, {"TEDIX_AGENT_STATUS": "0"}):
            self.fire("UserPromptSubmit")
        self.assertFalse((self.base / "agent-status").exists())

    def test_environment_opt_in_without_profile_skips_remote_report(self):
        with patch.dict(os.environ, {"TEDIX_AGENT_STATUS": "yes"}):
            self.fire("PermissionRequest", tool_name="Bash", tool_input={"command": "git push"})
        self.assertEqual(self.state()["state"], "needs_you")
        self.assertEqual(len(self.notifications()), 1)
        self.assertEqual(self.reports(), [])
        self.assertEqual(os.stat(self.base / "agent-status").st_mode & 0o777, 0o700)

    def test_stop_classifier(self):
        cases = [
            ("## Done\n\nFixed the **flaky** test in `api.ts`.\n\nAll checks pass.", "done", "Fixed the flaky test in api.ts."),
            ("I updated the config.\n\nShould I also push it to main?", "needs_you", "Should I also push it to main?"),
            ("Implemented it.\n\nLet me know if the naming works.", "needs_you", "Let me know if the naming works."),
            ("Two paths:\n\n```sh\nwhich option?\n```\n\nI chose the first; tests pass.", "done", "Two paths:"),
            ("Ready.\n\nWould you like me to deploy", "needs_you", "Would you like me to deploy"),
            ("", "done", "Turn complete"),
            (None, "done", "Turn complete"),
        ]
        for message, state, summary in cases:
            with self.subTest(message=message):
                self.assertEqual(hook.classify_stop(message), (state, summary))
        long_state, long_summary = hook.classify_stop("x" * 500)
        self.assertEqual((long_state, len(long_summary)), ("done", 160))
        self.assertNotIn("\n", hook.classify_stop("a\nb\n\nc")[1])

    def test_event_mapping(self):
        self.assertEqual(hook.transition({"hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "git push origin main"}}),
                         ("needs_you", "Approve Bash: git push origin main"))
        self.assertEqual(hook.transition({"hook_event_name": "Notification", "notification_type": "elicitation_dialog", "message": "Pick a target"}),
                         ("needs_you", "Pick a target"))
        self.assertIsNone(hook.transition({"hook_event_name": "Notification", "notification_type": "idle_prompt", "message": "Idle"}))
        self.assertEqual(hook.transition({"hook_event_name": "StopFailure", "error": "rate_limit", "error_details": "429 from provider"}),
                         ("error", "rate_limit: 429 from provider"))
        self.assertIsNone(hook.transition({"hook_event_name": "Stop", "stop_hook_active": True, "last_assistant_message": "Done"}))
        self.assertIsNone(hook.transition({"hook_event_name": "SubagentStop", "last_assistant_message": "Should I?"}))
        self.assertEqual(hook.transition({"hook_event_name": "SessionEnd", "reason": "logout"})[0], "ended")

    def test_change_detection_and_notification_only_on_transition(self):
        self.enable()
        self.fire("UserPromptSubmit")
        self.fire("UserPromptSubmit")
        self.assertEqual(len(self.reports()), 1)
        self.fire("PostToolUse", tool_name="Read")
        self.assertEqual(len(self.reports()), 1)
        self.fire("PermissionRequest", tool_name="Bash", tool_input={"command": "git push"})
        self.fire("Notification", notification_type="permission_prompt", message="Claude needs your permission to use Bash")
        self.assertEqual(self.state()["state"], "needs_you")
        self.assertEqual(len(self.notifications()), 1)
        self.assertEqual(len(self.reports()), 3)
        self.fire("PostToolUse", tool_name="Bash")
        self.assertEqual(self.state()["state"], "working")
        self.fire("Stop", last_assistant_message="Pushed.")
        self.fire("Stop", last_assistant_message="Pushed.")
        self.assertEqual(self.state()["state"], "done")
        self.assertEqual(len(self.reports()), 5)
        self.fire("StopFailure", error="server_error")
        self.assertEqual(len(self.notifications()), 2)
        self.fire("SessionEnd", reason="other")
        self.assertIsNone(self.state())
        prefix = f"async () => await {hook.REPORT_CALLABLE}("
        self.assertEqual(json.loads(self.reports()[-1][4][len(prefix):-1])["state"], "ended")

    def test_notify_false_suppresses_notifications(self):
        self.enable(notify=False)
        self.fire("StopFailure", error="server_error")
        self.assertEqual(self.notifications(), [])
        self.assertEqual(len(self.reports()), 1)

    def test_notification_passes_text_as_arguments(self):
        self.enable()
        self.fire("Notification", notification_type="permission_prompt", message='Run "x" \\ end tell; do shell script "id"')
        args = self.notifications()[0]
        self.assertTrue(all("do shell script" not in part for part in args[:7]))
        self.assertEqual(args[-3:], ['Run "x" \\ end tell; do shell script "id"', "Tedix · repo · main", "Needs you"])
        _, options = self.spawned[0]
        self.assertTrue(options["start_new_session"])

    def test_remote_command_uses_safe_json_literal(self):
        self.enable()
        self.fire("Stop", last_assistant_message='Done: `"); evil(); ("`   café </script>')
        args, options = next((args, options) for args, options in self.spawned if args[0] == "tedix")
        self.assertEqual(args[:4], ["tedix", "-w", "connect", "code"])
        source = args[4]
        prefix = f"async () => await {hook.REPORT_CALLABLE}("
        self.assertTrue(source.startswith(prefix) and source.endswith(")"))
        literal = source[len(prefix):-1]
        self.assertTrue(literal.isascii())
        decoded = json.loads(literal)
        self.assertEqual(set(decoded), {"harness", "sessionKey", "state", "summary", "label"})
        self.assertEqual(decoded["sessionKey"], SESSION)
        self.assertNotIn("cwd", decoded)
        self.assertTrue(options["start_new_session"])
        self.assertIs(options["stdin"], hook.subprocess.DEVNULL)
        with self.assertRaises(ValueError):
            hook.report_source({"harness": "claude-code", "sessionKey": "bad key", "state": "done"})

    def test_invalid_session_or_profile_is_ignored(self):
        self.enable(profile="Bad Profile")
        payload = {"session_id": "../escape", "hook_event_name": "UserPromptSubmit"}
        hook.run(io.StringIO(json.dumps(payload)))
        self.assertFalse((self.base / "agent-status").exists())
        self.fire("UserPromptSubmit")
        self.assertEqual(self.reports(), [])

    def test_harness_detection(self):
        self.enable()
        self.fire("Stop", turn_id="turn-1", model="gpt-5", last_assistant_message=None)
        self.assertEqual(self.state("codex")["state"], "done")
        self.assertIsNone(self.state("claude-code"))
        self.assertEqual(hook.harness_of({}), "claude-code")
        with patch.dict(os.environ, {"CODEX_THREAD_ID": SESSION}):
            self.assertEqual(hook.harness_of({}), "codex")

    def test_main_swallows_failures_silently(self):
        self.enable()
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(hook.sys, "stdin", io.StringIO("{not json")), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            hook.main()
        self.assertEqual((stdout.getvalue(), stderr.getvalue()), ("", ""))


if __name__ == "__main__":
    unittest.main()
