import { isHostSessionId } from "@tedix/api-contract/utils/host-session-id";
import { laneChildEnv } from "../lane-child-env";
import { devinCliCommand } from "../devin-config";
import { isObject } from "./hook-io";

/** Explicit host selection keeps inherited Claude/Codex environment out of Devin events. */
export function devinHookEvent(raw: string, env: NodeJS.ProcessEnv) {
	const event = JSON.parse(raw);
	if (!isObject(event) || !isHostSessionId(event.session_id))
		throw new Error("Invalid Devin native session id");
	const hostEnv: NodeJS.ProcessEnv = {
		...laneChildEnv(env),
		TEDIX_HOOK_HOST: "devin",
		DEVIN_SESSION_ID: event.session_id,
		DEVIN_PROJECT_DIR: env.DEVIN_PROJECT_DIR,
		TEDIX_DEVIN_HEADLESS: env.TEDIX_DEVIN_HEADLESS,
	};
	delete hostEnv.CLAUDE_CODE_SESSION_ATTENDED;
	return {
		env: hostEnv,
		stdin: JSON.stringify({
			...event,
			cwd: event.cwd ?? env.DEVIN_PROJECT_DIR,
			source: event.source === "new" ? "startup" : event.source,
			user_prompt: event.user_prompt ?? event.prompt,
			last_assistant_message: event.last_assistant_message ?? event.response,
		}),
	};
}

export function skipInheritedDevinHook(args: string[], env: NodeJS.ProcessEnv) {
	return (
		Boolean(env.DEVIN_PROJECT_DIR) &&
		!(args[1] === "--host" && args[2] === "devin")
	);
}

/** Devin exposes its id in hook stdin, not in the agent's shell environment. */
export function devinContextOutput(line: string, session: string) {
	const output = JSON.parse(line);
	if (
		isObject(output.hookSpecificOutput) &&
		typeof output.hookSpecificOutput.additionalContext === "string"
	)
		output.hookSpecificOutput.additionalContext = `Native Devin identity: use this exact CLI command (the shell PATH may select an older install): TEDIX_AGENT_SESSION=devin:${session} ${devinCliCommand()}. For coding Work only, bootstrap with --agent-harness devin and the actual CLI/model versions before admission. Read-only tasks do not need agent start or an Attempt. This identifies the session; it grants no Work authority.\n${output.hookSpecificOutput.additionalContext}`;
	return JSON.stringify(output);
}
