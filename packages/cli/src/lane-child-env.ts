import { AGENT_IDENTITY_ENV } from "./shared";

export function laneChildEnv(env = process.env): NodeJS.ProcessEnv {
	const child = { ...env };
	for (const key of [
		...AGENT_IDENTITY_ENV,
		"CODEX_THREAD_ID",
		"CODEX_SESSION_ID",
		"CLAUDE_CODE_SESSION_ID",
		"CLAUDECODE",
		"DEVIN_SESSION_ID",
		"DEVIN_PROJECT_DIR",
		"OPENCODE_SESSION_ID",
		"OPENCODE_LANE_RESUME_SESSION",
		"TEDIX_HOOK_HOST",
		"TEDIX_DEVIN_LANE_ROOT",
		"TEDIX_DEVIN_HEADLESS",
		"TEDIX_LANE_AGENT_STORE",
	])
		delete child[key];
	return child;
}
