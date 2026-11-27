import { expect, test } from "bun:test";
import { scopeSession } from "../session-scope";
import { harnessOf } from "./agent-status";
import {
	CURSOR_HOOKS,
	cursorHookEvent,
	cursorHookOutput,
} from "./cursor-event";
import { hostEvent } from "./hook-io";

const CHAT = "3f6b1c2e-9a4d-4e8f-b2c1-7d5e6f8a9b0c";

test("Cursor hook identity comes from session_id or conversation_id", () => {
	for (const key of ["session_id", "conversation_id"]) {
		const mapped = cursorHookEvent(
			JSON.stringify({
				[key]: CHAT,
				hook_event_name: "stop",
				status: "completed",
			}),
			{},
		);
		expect(mapped.env.TEDIX_HOOK_HOST).toBe("cursor");
		const event = JSON.parse(mapped.stdin);
		expect(event.session_id).toBe(CHAT);
		expect(event.hook_event_name).toBe("Stop");
		expect(hostEvent(mapped.stdin, mapped.env, 10_000).session).toBe(CHAT);
	}
});

test("inherited host identities stay out of a Cursor event", () => {
	const mapped = cursorHookEvent(
		JSON.stringify({
			conversation_id: CHAT,
			hook_event_name: "postToolUse",
		}),
		{
			CODEX_THREAD_ID: "11111111-1111-4111-8111-111111111111",
			CLAUDE_CODE_SESSION_ID: "22222222-2222-4222-8222-222222222222",
			TEDIX_AGENT_SESSION: "claude-code:22222222-2222-4222-8222-222222222222",
		},
	);
	for (const key of [
		"CODEX_THREAD_ID",
		"CLAUDE_CODE_SESSION_ID",
		"TEDIX_AGENT_SESSION",
	])
		expect(mapped.env[key]).toBeUndefined();
	expect(harnessOf({}, mapped.env)).toBe("cursor");
	expect(JSON.parse(mapped.stdin).hook_event_name).toBe("PostToolUse");
});

test("Cursor stop failures and session ends map to canonical names", () => {
	const failed = JSON.parse(
		cursorHookEvent(
			JSON.stringify({
				conversation_id: CHAT,
				hook_event_name: "stop",
				status: "error",
				error_message: "model unavailable",
			}),
			{},
		).stdin,
	);
	expect(failed.hook_event_name).toBe("StopFailure");
	expect(failed.error).toBe("model unavailable");
	const ended = JSON.parse(
		cursorHookEvent(
			JSON.stringify({
				session_id: CHAT,
				hook_event_name: "sessionEnd",
				reason: "user_close",
			}),
			{},
		).stdin,
	);
	expect(ended.hook_event_name).toBe("SessionEnd");
	expect(ended.reason).toBe("user_close");
});

test("workspace_roots supplies the hook cwd", () => {
	const mapped = cursorHookEvent(
		JSON.stringify({
			conversation_id: CHAT,
			hook_event_name: "beforeSubmitPrompt",
			prompt: "hello",
			workspace_roots: ["/work/repo"],
		}),
		{},
	);
	const event = JSON.parse(mapped.stdin);
	expect(event.cwd).toBe("/work/repo");
	expect(event.hook_event_name).toBe("UserPromptSubmit");
});

test("session-start context translates to Cursor's additional_context", () => {
	const line = JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "SessionStart",
			additionalContext: "Call the Tedix tool.",
		},
	});
	expect(JSON.parse(cursorHookOutput(line))).toEqual({
		additional_context: "Call the Tedix tool.",
	});
	expect(cursorHookOutput("not json")).toBe("not json");
});

test("only the wired hooks are accepted for Cursor", () => {
	expect(CURSOR_HOOKS.has("session-start")).toBe(true);
	expect(CURSOR_HOOKS.has("status")).toBe(true);
	expect(CURSOR_HOOKS.has("prompt-context")).toBe(false);
});

test("the Agent-Session prefix names the cursor harness", () => {
	expect(scopeSession({ TEDIX_AGENT_SESSION: `cursor:${CHAT}` })).toBe(CHAT);
});
