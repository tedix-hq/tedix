import { laneChildEnv } from "../lane-child-env";
import { isObject, type JsonObject } from "./hook-io";

/** The Tedix hooks the Cursor hooks.json entries run. */
export const CURSOR_HOOKS = new Set(["session-start", "status"]);

/**
 * Cursor's `hook_event_name` values mapped onto the names Tedix status
 * reporting and the session-start preflight already read.
 */
const CURSOR_EVENT_NAMES: Record<string, string> = {
	beforeSubmitPrompt: "UserPromptSubmit",
	postToolUse: "PostToolUse",
	postToolUseFailure: "PostToolUse",
	stop: "Stop",
	sessionEnd: "SessionEnd",
};

/**
 * Cursor sends its own event shape: the chat id is `session_id` on
 * sessionStart/sessionEnd and `conversation_id` everywhere else, and its
 * `stop` event reports `status` instead of an assistant message. Normalize
 * to the canonical event the shared hooks consume, keeping an inherited
 * Claude, Codex, Devin or OpenCode identity out of it.
 */
export function cursorHookEvent(raw: string, env: NodeJS.ProcessEnv) {
	const event: unknown = JSON.parse(raw);
	if (!isObject(event)) throw new Error("Invalid Cursor hook event");
	const id = event.session_id ?? event.conversation_id;
	if (typeof id !== "string" || !id || id.length > 128)
		throw new Error("Invalid Cursor session id");
	const name =
		typeof event.hook_event_name === "string" ? event.hook_event_name : "";
	const normalized: JsonObject = {
		...event,
		session_id: id,
		hook_event_name: CURSOR_EVENT_NAMES[name] ?? name,
	};
	if (name === "stop" && event.status === "error") {
		normalized.hook_event_name = "StopFailure";
		normalized.error =
			typeof event.error_message === "string" && event.error_message
				? event.error_message
				: "Cursor turn failed";
	}
	const roots = Array.isArray(event.workspace_roots)
		? event.workspace_roots
		: [];
	const cwd =
		typeof event.cwd === "string" && event.cwd
			? event.cwd
			: typeof roots[0] === "string"
				? roots[0]
				: undefined;
	if (cwd) normalized.cwd = cwd;
	const hostEnv: NodeJS.ProcessEnv = {
		...laneChildEnv(env),
		TEDIX_HOOK_HOST: "cursor",
		CURSOR_CONVERSATION_ID: id,
	};
	delete hostEnv.CLAUDE_CODE_SESSION_ATTENDED;
	return {
		env: hostEnv,
		stdin: JSON.stringify(normalized),
	};
}

/**
 * Cursor's sessionStart answer is `{additional_context}`, not Claude's
 * `hookSpecificOutput`; translate the context the shared hooks emitted.
 */
export function cursorHookOutput(line: string): string {
	try {
		const output: unknown = JSON.parse(line);
		if (isObject(output) && isObject(output.hookSpecificOutput)) {
			const context = output.hookSpecificOutput.additionalContext;
			if (typeof context === "string" && context)
				return JSON.stringify({ additional_context: context });
		}
	} catch {
		/* Not a context payload: pass the line through unchanged. */
	}
	return line;
}
