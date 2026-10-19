import { AGENT_IDENTITY_ENV } from "./hooks/hook-io";

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
		"TEDIX_HOOK_HOST",
		"TEDIX_DEVIN_LANE_ROOT",
		"TEDIX_DEVIN_HEADLESS",
	])
		delete child[key];
	return child;
}
