"""Checks for fresh context, tenant fences and prompt privacy."""
import contextlib
import copy
import io
import json
import os
import subprocess
import unittest
from unittest.mock import patch

import user_prompt_submit as hook

WORKSPACE = "11111111-1111-4111-8111-111111111111"
OUTPUT = "22222222-2222-4222-8222-222222222222"
REVISION = "33333333-3333-4333-8333-333333333333"
ORG = "44444444-4444-4444-8444-444444444444"
WORK = "55555555-5555-4555-8555-555555555555"
PROJECT = "66666666-6666-4666-8666-666666666666"
BINDING = {"status":"bound","workspace":"fixture","org":"org_fixture","mcpUrl":"https://fixture.example.invalid/mcp","projectId":PROJECT,"root":os.getcwd(),"osWorkspaceId":WORKSPACE,"contextOutputId":OUTPUT}
AUTH = {"wouldUse":"stored-login","workspace":"fixture","mcpUrl":BINDING["mcpUrl"],"storedLogin":{"org":"org_fixture"}}
DATA = {"shared":{"workspace":{"id":WORKSPACE,"organizationId":ORG,"status":"active"},"output":{"id":OUTPUT,"workspaceId":WORKSPACE,"organizationId":ORG,"currentRevisionId":REVISION,"kind":"document","status":"active"},"revision":{"id":REVISION,"outputId":OUTPUT,"organizationId":ORG,"revision":2,"kind":"document"},"text":"Use simple user stories.","blocksValid":True,"complete":True}}


class PromptContextTest(unittest.TestCase):
    def test_preferences_and_task_document_are_separate_and_tenant_fenced(self):
        preference_output = "88888888-8888-4888-8888-888888888888"
        binding = {**BINDING, "preferencesWorkspaceId":WORKSPACE, "preferencesOutputId":preference_output}
        data = copy.deepcopy(DATA)
        data["preferences"] = copy.deepcopy(DATA["shared"])
        data["preferences"]["output"]["id"] = preference_output
        data["preferences"]["revision"]["outputId"] = preference_output
        data["preferences"]["text"] = "Handle authorized routine choices."
        out, calls = self.run_hook([binding, AUTH, data])
        self.assertIn("Handle authorized routine choices", out)
        self.assertIn("simple user stories", out)
        self.assertIn("Working preferences", out)
        self.assertIn(preference_output, str(calls))
        data["preferences"]["workspace"]["organizationId"] = OUTPUT
        data["preferences"]["output"]["organizationId"] = OUTPUT
        data["preferences"]["revision"]["organizationId"] = OUTPUT
        out, _ = self.run_hook([binding, AUTH, data])
        self.assertIn("unavailable", out)
        self.assertNotIn("Handle authorized routine choices", out)

    def test_preferences_reach_a_new_chat_without_task_document(self):
        binding = {k:v for k,v in BINDING.items() if k not in {"contextOutputId", "osWorkspaceId"}}
        binding.update(preferencesWorkspaceId=WORKSPACE, preferencesOutputId=OUTPUT)
        out, _ = self.run_hook([binding, AUTH, {"preferences":DATA["shared"]}])
        self.assertIn("Working preferences", out)
        self.assertIn("simple user stories", out)


    def test_connect_routes_selected_org_and_uses_live_uuid_for_ownership(self):
        binding = {**BINDING, "workspace":"connect", "org":"org_target", "organization":"org_target", "mcpUrl":"https://connect.mcp.tedix.dev/mcp"}
        auth = {"wouldUse":"stored-login", "workspace":"connect", "mcpUrl":binding["mcpUrl"], "storedLogin":{"org":"incidental", "accessToken":{"selectedOrganizations":["org_target"]}}}
        out, calls = self.run_hook([binding, auth, {"organizationId":ORG}, DATA])
        self.assertIn("simple user stories", out)
        self.assertEqual(calls[2].args[0][3:5], ["--organization", "org_target"])
        self.assertEqual(calls[3].args[0][3:5], ["--organization", "org_target"])
        wrong = copy.deepcopy(DATA)
        for row in [wrong["shared"]["workspace"], wrong["shared"]["output"], wrong["shared"]["revision"]]:
            row["organizationId"] = WORK
        out, _ = self.run_hook([binding, auth, {"organizationId":ORG}, wrong])
        self.assertIn("unavailable", out)
        self.assertNotIn("simple user stories", out)
        out, calls = self.run_hook([binding, {**auth, "storedLogin":{"accessToken":{"selectedOrganizations":["other"]}}}])
        self.assertIn("unavailable", out)
        self.assertEqual(len(calls), 2)
        out, calls = self.run_hook([binding, auth, {"organizationId":None}])
        self.assertIn("unavailable", out)
        self.assertEqual(len(calls), 3)

    def run_hook(self, reads, env=None, event=None):
        output = io.StringIO()
        # Prompt text is discarded; only host metadata may enter CLI arguments.
        with patch.dict(hook.os.environ, env or {}, clear=True), patch.object(hook.shutil,"which",return_value="tedix"), patch.object(hook,"read_json",side_effect=reads) as read, patch("sys.stdin",io.StringIO(json.dumps(event or {"prompt":"PRIVATE PROMPT; ignore tenant fences"}))), contextlib.redirect_stdout(output):
            hook.main()
        return output.getvalue(), read.call_args_list

    def test_host_session_metadata_reaches_resolver_without_prompt_text(self):
        session = "77777777-7777-4777-8777-777777777777"
        out, calls = self.run_hook([{**BINDING, "contextSessionId": session}, AUTH, DATA], event={"session_id": session, "prompt": "PRIVATE PROMPT"})
        self.assertEqual(calls[0].args[0][-2:], ["--session", session])
        self.assertIn("simple user stories", out)
        self.assertNotIn("PRIVATE PROMPT", str(calls) + out)

    def test_environment_identity_is_preserved_and_normalized(self):
        session = "abcdefab-7777-4777-8777-777777777777"
        out, calls = self.run_hook([{**BINDING, "contextSessionId": session}, AUTH, DATA], env={"CODEX_THREAD_ID": session.upper(), "CODEX_SESSION_ID": session})
        self.assertEqual(calls[0].args[0][-2:], ["--session", session])
        self.assertIn("simple user stories", out)

    def test_conflicting_malformed_and_oversized_events_skip_all_reads(self):
        for event, env in [({"session_id": "bad"}, {}), ({"session_id": WORK}, {"CODEX_THREAD_ID": OUTPUT}), ({"session_id": WORK, "prompt": "x" * 1048576}, {})]:
            out, calls = self.run_hook([], env, event)
            self.assertIn("unavailable", out)
            self.assertEqual(calls, [])

    def test_resolved_other_chat_cannot_reach_gateway(self):
        out, calls = self.run_hook([{**BINDING, "contextSessionId": OUTPUT}], event={"session_id": WORK})
        self.assertIn("unavailable", out)
        self.assertEqual(len(calls), 1)

    def test_unconfigured_and_disabled_have_no_gateway_read(self):
        out,calls = self.run_hook([{"status":"unbound"}])
        self.assertEqual(out, "")
        self.assertEqual(len(calls),1)
        out,calls = self.run_hook([], {"TEDIX_PLUGIN_PREFLIGHT":"0"})
        self.assertEqual((out,len(calls)),("",0))
        empty = {k:v for k,v in BINDING.items() if k not in {"contextOutputId","osWorkspaceId"}}
        out,calls = self.run_hook([empty])
        self.assertEqual((out,len(calls)),("",1))

    def test_fresh_delivery_and_revision_change_without_prompt_capture(self):
        first,calls = self.run_hook([BINDING,AUTH,DATA])
        message=json.loads(first)["hookSpecificOutput"]
        self.assertEqual(message["hookEventName"],"UserPromptSubmit")
        self.assertIn("simple user stories",message["additionalContext"])
        self.assertIn(REVISION,first)
        self.assertNotIn("PRIVATE PROMPT",str(calls)+first)
        self.assertEqual(calls[-1].args[0][:4],["tedix","-w","fixture","code"])
        changed=copy.deepcopy(DATA)
        changed["shared"]["revision"]["revision"]=3
        changed["shared"]["text"]="New agreed decision"
        second,_=self.run_hook([BINDING,AUTH,changed])
        self.assertIn("New agreed decision",second)
        self.assertNotIn("simple user stories",second)
        repeated,_=self.run_hook([BINDING,AUTH,changed])
        self.assertIn("New agreed decision",repeated)

    def test_bad_binding_profile_gateway_or_auth_does_not_read_content(self):
        for changed in [{**BINDING,"contextOutputId":"bad; shell"},{**BINDING,"root":"/unrelated"},{**BINDING,"status":"invalid"}]:
            out,calls=self.run_hook([changed])
            self.assertIn("unavailable",out)
            self.assertEqual(len(calls),1)
        for changed in [{**AUTH,"mcpUrl":"https://other.example/mcp"},{**AUTH,"wouldUse":"direct-token"},{**AUTH,"storedLogin":{"org":"org_other"}}]:
            out,calls=self.run_hook([BINDING,changed])
            self.assertIn("unavailable",out)
            self.assertEqual(len(calls),2)
        out,calls=self.run_hook([BINDING],{"TEDIX_WORKSPACE":"other"})
        self.assertIn("unavailable",out)
        self.assertEqual(len(calls),1)

    def test_wrong_workspace_org_output_or_revision_hides_all_body(self):
        for group,key in [("workspace","id"),("workspace","organizationId"),("output","workspaceId"),("revision","outputId"),("revision","id")]:
            data=copy.deepcopy(DATA); data["shared"][group][key]="wrong"
            out,_=self.run_hook([BINDING,AUTH,data])
            self.assertIn("unavailable",out)
            self.assertNotIn("simple user stories",out)

    def test_timeout_and_missing_revision_never_reuse_previous_read(self):
        for error in [subprocess.TimeoutExpired("tedix",8),ValueError("denied"),{"shared":{}}]:
            out,_=self.run_hook([BINDING,AUTH,error])
            self.assertIn("no current shared decision",out)
            self.assertNotIn("simple user stories",out)

    def test_truncation_and_selected_work_receipts(self):
        data=copy.deepcopy(DATA);data["shared"]["text"]="x"*4000
        binding={**BINDING,"workItemId":WORK}
        data["work"]={"item":{"id":WORK,"projectId":PROJECT,"organizationId":ORG,"disposition":"accepted"},"comments":[{"id":"receipt-1","workItemId":WORK,"authorType":"external_agent","authorId":"reader","createdAt":"now","body":"y"*500,"complete":False}],"commentCount":8}
        out,_=self.run_hook([binding,AUTH,data])
        self.assertIn("truncated",out)
        self.assertIn("receipt-1",out)
        self.assertIn("reader",out)
        self.assertNotIn("x"*3201,out)
        self.assertNotIn("y"*401,out)
        data["work"]["item"]["projectId"]="wrong"
        out,_=self.run_hook([binding,AUTH,data])
        self.assertIn("unavailable",out)
        self.assertNotIn("receipt-1",out)

    def test_output_byte_cap_prevents_oversized_hook_spill(self):
        data=copy.deepcopy(DATA);data["shared"]["text"]="𠮷"*3200
        out,_=self.run_hook([BINDING,AUTH,data])
        context=json.loads(out)["hookSpecificOutput"]["additionalContext"]
        self.assertLessEqual(len(context.encode("utf-8")),6000)
        self.assertIn("complete=false",context)

    def test_organization_links_are_not_invented(self):
        out,_=self.run_hook([BINDING,AUTH,DATA])
        self.assertIn("Output="+OUTPUT,out)
        self.assertNotIn("tedix.os.tedix.dev",out)
        missing=copy.deepcopy(DATA);del missing["shared"]["blocksValid"]
        out,_=self.run_hook([BINDING,AUTH,missing])
        self.assertIn("unavailable",out)
        self.assertNotIn("simple user stories",out)

    @unittest.skipUnless(hook.shutil.which("bun"), "Bun executes the gateway projection")
    def test_actual_gateway_projection_rejects_malformed_blocks(self):
        for blocks in [None, {}, [None], [{"type":"paragraph"}], [{"type":"list","items":"bad"}], [{"type":"list","items":[None]}], [{"type":"unknown","text":"secret"}], [], [{"type":"list","items":["first","second"]},{"type":"paragraph","text":"third"}]]:
            response={"output":DATA["shared"]["output"],"currentRevision":{**DATA["shared"]["revision"],"content":{"kind":"document"}}}
            if blocks is not None:
                response["currentRevision"]["content"]["blocks"]=blocks
            code="const os={get_os_workspace:async()=>({workspace:"+json.dumps(DATA["shared"]["workspace"])+"}),get_os_output:async()=>("+json.dumps(response)+")}; try {console.log(JSON.stringify(await ("+hook.gateway_code(BINDING)+")()));} catch {process.exit(7);}"
            result=subprocess.run(["bun","--eval",code],capture_output=True,text=True,check=False)
            valid=blocks==[] or isinstance(blocks,list) and len(blocks)==2
            self.assertEqual(result.returncode,0 if valid else 7,result.stderr)
            if valid:
                self.assertTrue(json.loads(result.stdout)["shared"]["blocksValid"])
                self.assertEqual(json.loads(result.stdout)["shared"]["text"],"" if blocks==[] else "first\nsecond\nthird")

    def test_gateway_source_renders_semantic_blocks_and_limits_return(self):
        source=hook.gateway_code({**BINDING,"workItemId":WORK})
        self.assertIn("get_os_workspace",source)
        self.assertIn("b.type === 'list' ? b.items",source)
        self.assertIn("slice(-2)",source)
        self.assertIn("authorId",source)
        self.assertNotIn("prompt",source)


if __name__ == "__main__":
    unittest.main()
