"""Checks for opt-in decision capture: pairing, redaction, opt-in and fail-silent behaviour."""
import io
import json
import os
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import decision_capture as hook

SESSION = "77777777-7777-4777-8777-777777777777"
PROJECT = "66666666-6666-4666-8666-666666666666"
WORK = "55555555-5555-4555-8555-555555555555"
REQUEST = "99999999-9999-4999-8999-999999999999"
BINDING = {"status":"bound","workspace":"fixture","org":"org_fixture","mcpUrl":"https://fixture.example.invalid/mcp","projectId":PROJECT,"root":os.getcwd(),"decisionCapture":True}
AUTH = {"wouldUse":"stored-login","workspace":"fixture","mcpUrl":BINDING["mcpUrl"],"storedLogin":{"loginId":"U-fixture-user"}}
CREATED = {"id":REQUEST,"version":1}


class DecisionCaptureTest(unittest.TestCase):
    def setUp(self):
        self.config = tempfile.TemporaryDirectory()
        self.addCleanup(self.config.cleanup)
        self.payloads = []

    def run_hook(self, mode, event, reads, env=None, during_create=None, fail_respond=False):
        responses = iter(reads)

        def fake_run(args, **kwargs):
            if args[0] == "git":
                return subprocess.CompletedProcess(args, 0, "main\n", "")
            self.assertNotIn("TEDIX_EXTERNAL_AGENT", kwargs["env"])
            if fail_respond and "interaction-respond" in args:
                return subprocess.CompletedProcess(args, 1, "", "offline")
            if "--input" in args:
                with open(args[args.index("--input") + 1][1:]) as file:
                    self.payloads.append((args, json.load(file)))
            if during_create and "interaction-create" in args:
                during_create()
            return subprocess.CompletedProcess(args, 0, json.dumps(next(responses)), "")

        environment = {"TEDIX_CONFIG_DIR": self.config.name, "TEDIX_EXTERNAL_AGENT": "agent", "CLAUDE_PLUGIN_ROOT": "/plugin"} | (env or {})
        with patch.dict(os.environ, environment, clear=False), \
                patch.object(hook.subprocess, "run", side_effect=fake_run) as run, \
                patch.object(hook.shutil, "which", return_value="/usr/bin/tedix"), \
                patch.object(hook.sys, "argv", ["decision_capture.py", mode]), \
                patch.object(hook.sys, "stdin", io.StringIO(json.dumps({"session_id": SESSION} | event))):
            for key in ("CODEX_SESSION_ID", "CODEX_THREAD_ID"):
                if key not in environment:
                    os.environ.pop(key, None)
            hook.main()
        return run.call_args_list

    def state(self):
        return os.path.join(self.config.name, "decision-capture", f"{SESSION}.json")

    def test_turn_end_and_reply_become_one_resolved_interaction(self):
        self.run_hook("stop", {"last_assistant_message": "## Deployed\nAll green. Want me to also clean up legacy?"}, [BINDING, AUTH, CREATED])
        args, created = self.payloads[0]
        self.assertIn("interaction-create", args)
        self.assertEqual(created["projectId"], PROJECT)
        self.assertEqual(created["requestedFrom"], {"type": "user", "id": "U-fixture-user"})
        self.assertEqual(created["kind"], "question")
        self.assertIn("claude-code waiting: Deployed", created["subject"])
        self.assertEqual(created["metadata"]["sessionId"], SESSION)
        self.assertTrue(os.path.exists(self.state()))
        self.run_hook("reply", {"prompt": "yes and aggressively remove the legacy path"}, [BINDING, AUTH, {"request": CREATED}])
        args, response = self.payloads[1]
        self.assertEqual(args[args.index("interaction-respond") + 1], REQUEST)
        self.assertEqual(response["body"], "yes and aggressively remove the legacy path")
        self.assertEqual(response["metadata"]["replyClass"], "simplify")
        self.assertTrue(response["resolvesRequest"])
        self.assertFalse(os.path.exists(self.state()))

    def test_selected_work_is_the_context_and_secrets_are_redacted(self):
        self.run_hook("stop", {"last_assistant_message": "Set TEDIX_API_KEY=abcd1234secret and Bearer abcdefghijklmnopqrstuvwxyz"}, [{**BINDING, "workItemId": WORK}, AUTH, CREATED])
        created = self.payloads[0][1]
        self.assertEqual(created["workItemId"], WORK)
        self.assertNotIn("projectId", created)
        self.assertNotIn("abcd1234secret", json.dumps(created))
        self.assertNotIn("abcdefghijklmnopqrstuvwxyz", json.dumps(created))

    def test_without_opt_in_nothing_is_sent_or_stored(self):
        calls = self.run_hook("stop", {"last_assistant_message": "done"}, [{**BINDING, "decisionCapture": False}])
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.payloads, [])
        self.assertFalse(os.path.exists(self.state()))
        calls = self.run_hook("stop", {"last_assistant_message": "done"}, [{"status": "unbound"}])
        self.assertEqual(self.payloads, [])

    def test_system_reentries_and_unpaired_prompts_are_not_replies(self):
        calls = self.run_hook("reply", {"prompt": "first prompt of a session"}, [])
        self.assertEqual(calls, [])
        self.run_hook("stop", {"last_assistant_message": "Running tests in the background."}, [BINDING, AUTH, CREATED])
        for prompt in ("<task-notification>\n<task-id>x</task-id>", "[SYSTEM NOTIFICATION - NOT USER INPUT]", "<system-reminder>x</system-reminder>"):
            self.assertEqual(self.run_hook("reply", {"prompt": prompt}, []), [])
        self.assertTrue(os.path.exists(self.state()))

    def test_a_pending_background_turn_is_not_waiting_on_the_user(self):
        self.run_hook("stop", {"last_assistant_message": "Waiting for agents.", "background_tasks": [{"id": "a"}]}, [BINDING, AUTH])
        self.assertEqual(self.payloads, [])

    def test_an_unanswered_turn_is_marked_superseded_when_the_next_one_ends(self):
        self.run_hook("stop", {"last_assistant_message": "first"}, [BINDING, AUTH, CREATED])
        second = {"id": "88888888-8888-4888-8888-888888888888", "version": 1}
        self.run_hook("stop", {"last_assistant_message": "second"}, [BINDING, AUTH, {"request": {"id": REQUEST, "version": 2}}, second])
        verbs = [next(verb for verb in ("interaction-create", "interaction-respond") if verb in args) for args, _ in self.payloads]
        self.assertEqual(verbs, ["interaction-create", "interaction-respond", "interaction-create"])
        self.assertEqual(self.payloads[1][1]["metadata"]["source"], "superseded")
        # Not the user's words: never recorded as an answer.
        self.assertEqual(self.payloads[1][1]["responseKind"], "coordination_update")
        self.assertTrue(self.payloads[1][1]["body"].startswith("Closed automatically"))
        self.assertNotIn("replyClass", self.payloads[1][1]["metadata"])
        with open(self.state()) as file:
            self.assertEqual(json.load(file)["requestId"], second["id"])

    def test_a_reply_typed_while_the_question_is_created_is_kept(self):
        state = hook.Path(self.state())

        def user_replies_now():
            self.assertEqual(hook.claim_reply({"prompt": "yes"}, state), "early")

        self.run_hook("stop", {"last_assistant_message": "Ship it?"}, [BINDING, AUTH, CREATED, {"request": CREATED}], during_create=user_replies_now)
        verbs = [next(verb for verb in ("interaction-create", "interaction-respond") if verb in args) for args, _ in self.payloads]
        self.assertEqual(verbs, ["interaction-create", "interaction-respond"])
        self.assertEqual(self.payloads[1][1]["body"], "yes")
        self.assertEqual(self.payloads[1][1]["responseKind"], "answer")
        self.assertEqual(self.payloads[1][1]["metadata"]["source"], "user-reply")
        self.assertFalse(os.path.exists(self.state()))

    def test_a_reply_that_fails_to_send_is_retried_at_the_next_turn_end(self):
        self.run_hook("stop", {"last_assistant_message": "first"}, [BINDING, AUTH, CREATED])
        self.run_hook("reply", {"prompt": "make it happen"}, [BINDING, AUTH], fail_respond=True)
        self.assertTrue(os.path.exists(self.state()))
        second = {"id": "88888888-8888-4888-8888-888888888888", "version": 1}
        self.run_hook("stop", {"last_assistant_message": "second"}, [BINDING, AUTH, {"request": CREATED}, second])
        retried = self.payloads[-2][1]
        self.assertEqual(retried["body"], "make it happen")
        self.assertEqual(retried["metadata"]["source"], "user-reply")

    def test_codex_identity_and_failures_stay_silent(self):
        self.run_hook("stop", {"last_assistant_message": "done"}, [BINDING, AUTH, CREATED], env={"CODEX_THREAD_ID": SESSION})
        self.assertIn("codex waiting", self.payloads[0][1]["subject"])
        self.run_hook("stop", {"last_assistant_message": "done"}, [BINDING, {**AUTH, "wouldUse": "external-agent:x"}])
        self.run_hook("stop", {"last_assistant_message": "done"}, [{**BINDING, "contextSessionId": REQUEST}])
        with patch.object(hook, "host_event", side_effect=ValueError("bad")):
            self.run_hook("stop", {}, [])

    def test_mined_reply_classes(self):
        for reply, label in [("continue", "continue"), ("make it happen", "approve"), ("its already done, right?", "challenge"),
                             ("recheck now", "verify"), ("explain me in simple user stories", "plain-english"),
                             ("fan out with subagents", "fan-out"), ("commit and push all deps bumps", "ship"),
                             ("status now?", "status"), ("Do you need me babysit you?", "frustration"),
                             ("add a sidebar button", "instruction")]:
            self.assertEqual(hook.classify(reply), label, reply)


if __name__ == "__main__":
    unittest.main()
