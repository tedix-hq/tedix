"""Behavior checks for the bounded, read-only session brief."""

import contextlib
import io
import json
import unittest
from unittest.mock import patch

import session_start


WORK_ID = "ac651d65-a993-4e57-aa05-d4c45c78cfda"
AUTH = {"wouldUse": "stored-login", "workspace": "tedix", "mcpUrl":"https://tedix-unified.mcp.tedix.dev/mcp", "storedLogin": {"org":"org_tedix", "grantedScopes": ["mcp:work.read"]}}


class SessionBriefTest(unittest.TestCase):
    def test_connect_routes_selected_org_and_rejects_cross_org_work(self):
        binding = {"status":"bound", "workspace":"connect", "org":"org_target", "organization":"org_target", "mcpUrl":"https://connect.mcp.tedix.dev/mcp", "projectId":"project-id", "workItemId":WORK_ID}
        auth = {"wouldUse":"stored-login", "workspace":"connect", "mcpUrl":binding["mcpUrl"], "storedLogin":{"org":"incidental", "accessToken":{"selectedOrganizations":["org_target"]}}}
        org = "11111111-1111-4111-8111-111111111111"
        for actual in [org, WORK_ID]:
            output = io.StringIO()
            item = {"title":"Scoped task", "projectId":"project-id", "orgId":actual, "disposition":"accepted", "acceptanceContract":{"doneLooksLike":"Finish"}}
            with patch.dict(session_start.os.environ, {}, clear=True), patch.object(session_start.shutil,"which",return_value="tedix"), patch.object(session_start,"read_json",side_effect=[binding,auth,{"organizationId":org},item,{"data":[]}]) as read, patch.object(session_start.sys,"stdin",io.StringIO("{}")),contextlib.redirect_stdout(output):
                session_start.main()
            calls = read.call_args_list
            self.assertEqual(calls[2].args[0][3:5], ["--organization","org_target"])
            self.assertEqual(calls[3].args[0][3:5], ["--organization","org_target"])
            if actual == org:
                self.assertIn("Scoped task", output.getvalue())
            else:
                self.assertNotIn("Scoped task", output.getvalue())
                self.assertEqual(len(calls), 4)
        output = io.StringIO()
        with patch.dict(session_start.os.environ,{},clear=True),patch.object(session_start.shutil,"which",return_value="tedix"),patch.object(session_start,"read_json",side_effect=[binding,{**auth,"storedLogin":{"accessToken":{"selectedOrganizations":["other"]}}}]) as read,patch.object(session_start.sys,"stdin",io.StringIO("{}")),contextlib.redirect_stdout(output):
            session_start.main()
        self.assertIn("no longer selected",output.getvalue())
        self.assertEqual(len(read.call_args_list),2)

    def test_cli_free_hint_has_no_network_read_or_authority(self):
        for opt_in in ["", "0", "1"]:
            output = io.StringIO()
            with patch.dict(session_start.os.environ, {"TEDIX_PLUGIN_PREFLIGHT": opt_in}, clear=True), patch.object(session_start.shutil, "which", return_value=None), patch.object(session_start, "read_json") as read, contextlib.redirect_stdout(output):
                session_start.main()
            read.assert_not_called()
            if opt_in == "1":
                context = json.loads(output.getvalue())["hookSpecificOutput"]["additionalContext"]
                self.assertIn("no live preflight was read", context)
                self.assertIn("tedix-session-guide", context)
                self.assertIn("No identity, scope, Work state", context)
            else:
                self.assertEqual(output.getvalue(), "")

    def brief(self, outcome, attempts=None, source="startup"):
        item = {"title": "Selected task", "disposition": "accepted", "acceptanceContract": {"doneLooksLike": outcome}}
        output = io.StringIO()
        with patch.dict(session_start.os.environ, {"TEDIX_PLUGIN_PREFLIGHT": "1", "TEDIX_WORKSPACE": "tedix", "TEDIX_WORK_ITEM_ID": WORK_ID}, clear=True), patch.object(session_start.shutil, "which", return_value="/usr/local/bin/tedix"), patch.object(session_start, "read_json", side_effect=[AUTH, item, {"data": attempts or []}]), patch.object(session_start.sys, "stdin", io.StringIO(json.dumps({"source": source}))), contextlib.redirect_stdout(output):
            session_start.main()
        return json.loads(output.getvalue())["hookSpecificOutput"]["additionalContext"]

    def test_all_lifecycle_sources_preserve_ordinary_outcome(self):
        outcome = "Verify the installed plugin in a fresh session and report its Work state. " * 5
        for source in ["startup", "resume", "clear", "compact", "fork"]:
            with self.subTest(source=source):
                context = self.brief(outcome, source=source)
                self.assertIn(outcome, context)
                self.assertIn("outcomeComplete=true", context)
                self.assertIn(f"source={source}; observed=", context)

    def test_oversized_outcome_is_explicitly_incomplete(self):
        context = self.brief("x" * 1000)
        self.assertIn("outcomeComplete=false", context)
        self.assertIn("Outcome missing or truncated", context)
        self.assertNotIn("x" * 801, context)

    def test_missing_outcome_cannot_be_treated_as_complete(self):
        self.assertIn("outcomeComplete=false", self.brief(""))

    def test_observed_attempt_identifies_owner_without_inheriting_authority(self):
        context = self.brief("Finish the task", [{"id": "attempt-id", "attemptNumber": 2, "runtimeState": "running", "executorType": "external_agent", "executorId": "executor-id", "externalSessionKey": "codex:other-session", "expiresAt": "1970-01-01T00:00:00Z"}])
        self.assertIn("Observed Attempt attempt-id", context)
        self.assertIn("executor=external_agent:executor-id", context)
        self.assertIn("codex:other-session", context)
        self.assertIn("does not inherit its authority", context)
        self.assertIn("Verify current identity and fence before write", context)
        self.assertIn("lease=expired", context)
        self.assertIn("requires fresh admission", context)

    def test_unknown_event_is_not_a_claim_of_fresh_startup(self):
        self.assertIn("source=unknown", self.brief("Finish", source="invented"))

    def test_disabled_hook_is_silent_and_performs_no_read(self):
        output = io.StringIO()
        with patch.dict(session_start.os.environ, {"TEDIX_PLUGIN_PREFLIGHT": "0"}, clear=True), patch.object(session_start, "read_json") as read, contextlib.redirect_stdout(output):
            session_start.main()
        read.assert_not_called()
        self.assertEqual(output.getvalue(), "")

    def automatic_brief(self, binding, project="project-id", env=None, event=None):
        output = io.StringIO()
        if binding.get("status") == "bound":
            binding = {"org":"org_tedix", "mcpUrl":AUTH["mcpUrl"], **binding}
        item = {"title": "Bound task", "projectId": project, "disposition": "completed", "acceptanceContract": {"doneLooksLike": "Deliver the result"}}
        with patch.dict(session_start.os.environ, env or {}, clear=True), patch.object(session_start.shutil, "which", return_value="tedix"), patch.object(session_start, "read_json", side_effect=[binding, AUTH, item, {"data": []}]) as read, patch.object(session_start.sys, "stdin", io.StringIO(json.dumps(event or {"source":"resume"}))), contextlib.redirect_stdout(output):
            session_start.main()
        return output.getvalue(), read.call_args_list

    def test_bound_wrong_org_gateway_or_explicit_token_never_reads_work(self):
        binding={"status":"bound","workspace":"tedix","org":"org_tedix","mcpUrl":AUTH["mcpUrl"],"projectId":"project-id","workItemId":WORK_ID}
        for auth in [{**AUTH,"mcpUrl":"https://wrong.invalid/mcp"},{**AUTH,"storedLogin":{"org":"org_other"}},{**AUTH,"wouldUse":"direct-token"},{**AUTH,"wouldUse":"external-agent:key","externalAgent":{"configured":True,"mcpUrl":"https://wrong.invalid/mcp","organizationId":WORK_ID}}]:
            output=io.StringIO()
            with patch.dict(session_start.os.environ,{},clear=True),patch.object(session_start.shutil,"which",return_value="tedix"),patch.object(session_start,"read_json",side_effect=[binding,auth]) as read,patch.object(session_start.sys,"stdin",io.StringIO("{}")),contextlib.redirect_stdout(output):
                session_start.main()
            self.assertIn("no Work was read",output.getvalue())
            self.assertEqual(len(read.call_args_list),2)

    def test_explicit_work_cannot_override_current_chat_selection(self):
        other = "11111111-1111-4111-8111-111111111111"
        output, calls = self.automatic_brief({"status": "bound", "workspace": "tedix", "projectId": "project-id", "workItemId": other, "contextSessionId": WORK_ID}, env={"TEDIX_PLUGIN_PREFLIGHT": "1", "TEDIX_WORK_ITEM_ID": WORK_ID}, event={"session_id": WORK_ID})
        self.assertIn("conflicts", output)
        self.assertEqual(len(calls), 1)

    def test_host_session_is_passed_to_local_resolver(self):
        output, calls = self.automatic_brief({"status": "bound", "workspace": "tedix", "projectId": "project-id", "workItemId": WORK_ID, "contextSessionId": WORK_ID}, event={"source": "resume", "session_id": WORK_ID})
        self.assertEqual(calls[0].args[0][-2:], ["--session", WORK_ID])
        self.assertIn("Work Item is terminal", output)

    def test_conflicting_host_identity_performs_no_reads(self):
        output, calls = self.automatic_brief({}, env={"CODEX_THREAD_ID": "11111111-1111-4111-8111-111111111111"}, event={"session_id": WORK_ID})
        self.assertIn("conflicting", output)
        self.assertEqual(calls, [])

    def test_resolved_wrong_chat_cannot_read_work_even_with_opt_in(self):
        output, calls = self.automatic_brief({"contextSessionId": WORK_ID}, env={"TEDIX_PLUGIN_PREFLIGHT": "1"}, event={"session_id": "11111111-1111-4111-8111-111111111111"})
        self.assertIn("unavailable", output)
        self.assertEqual(len(calls), 1)

    def test_unconfigured_session_performs_only_local_resolution(self):
        output, calls = self.automatic_brief({"status": "unbound"})
        self.assertEqual(output, "")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].args[0], ["tedix", "setup", "agents", "context", "show", "--json"])

    def test_binding_recovers_terminal_work_without_environment(self):
        output, calls = self.automatic_brief({"status": "bound", "workspace": "tedix", "projectId": "project-id", "workItemId": WORK_ID, "contextSource": "worktree"})
        self.assertIn(WORK_ID, output)
        self.assertIn("Work Item is terminal; no running Attempt", output)
        self.assertIn("source=resume", output)
        self.assertTrue(all(call.args[0][1:3] == ["-w", "tedix"] for call in calls[1:]))

    def test_no_selected_work_guides_authorized_task_without_hook_mutations(self):
        output, calls = self.automatic_brief({"status": "bound", "workspace": "tedix", "projectId": "project-id"})
        context = json.loads(output)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("activation alone does not authorize creating Work", context)
        self.assertIn("user-authorized repo task", context)
        self.assertIn("bookkeeping/admission under repo policy", context)
        self.assertIn("do not re-ask permission for that task", context)
        self.assertIn("ambiguous target or reserved decision", context)
        self.assertEqual([call.args[0] for call in calls], [
            ["tedix", "setup", "agents", "context", "show", "--json"],
            ["tedix", "-w", "tedix", "auth", "status", "--json"],
        ])

    def test_bound_project_mismatch_hides_item_and_skips_attempts(self):
        output, calls = self.automatic_brief({"status": "bound", "workspace": "tedix", "projectId": "expected", "workItemId": WORK_ID})
        self.assertIn("does not match the bound project", output)
        self.assertNotIn("Bound task", output)
        self.assertEqual(len(calls), 3)

    def test_explicit_other_profile_does_not_use_bound_work(self):
        output, calls = self.automatic_brief({"status": "bound", "workspace": "tedix", "projectId": "project-id", "workItemId": WORK_ID}, env={"TEDIX_WORKSPACE": "other"})
        self.assertEqual(output, "")
        self.assertEqual(len(calls), 1)

    def test_invalid_binding_reports_local_fix_without_gateway_reads(self):
        output, calls = self.automatic_brief({"status": "invalid"})
        self.assertIn("local binding is invalid", output)
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
