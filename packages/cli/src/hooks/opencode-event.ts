import { isHostSessionId } from "@tedix/api-contract/utils/host-session-id";
import { laneChildEnv } from "../lane-child-env";
import { isObject } from "./hook-io";

/** The hooks the OpenCode plugin runs. */
export const OPENCODE_HOOKS = new Set([
	"session-start",
	"prompt-context",
	"situational-recall",
	"capture-reply",
	"capture-stop",
	"await-reply",
	"status",
]);

/**
 * The OpenCode plugin sends a Claude-shaped event with its native `ses_` id.
 * Explicit host selection keeps an inherited Claude, Codex or Devin identity
 * out of the event, as for Devin.
 */
export function opencodeHookEvent(raw: string, env: NodeJS.ProcessEnv) {
	const event = JSON.parse(raw);
	if (
		!isObject(event) ||
		typeof event.session_id !== "string" ||
		!event.session_id.startsWith("ses_") ||
		!isHostSessionId(event.session_id)
	)
		throw new Error("Invalid OpenCode native session id");
	const hostEnv: NodeJS.ProcessEnv = {
		...laneChildEnv(env),
		TEDIX_HOOK_HOST: "opencode",
		OPENCODE_SESSION_ID: event.session_id,
	};
	delete hostEnv.CLAUDE_CODE_SESSION_ATTENDED;
	// Match the canonical chat key used by hostEvent and session-scope.
	return {
		env: hostEnv,
		stdin: JSON.stringify({
			...event,
			session_id: event.session_id.toLowerCase(),
		}),
	};
}
