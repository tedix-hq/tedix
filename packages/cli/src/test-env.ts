import { setProcessTableReader } from "./host-ancestry";

/**
 * Bun test preload: start every test file without the caller's Tedix or
 * harness identity. Launched agent shells export these, and the CLI would
 * otherwise pick up a real credential or session; tests set what they need.
 */
const HARNESS_SESSION_ENV = [
	"CLAUDE_CODE_SESSION_ID",
	"CLAUDE_PID",
	"CODEX_SESSION_ID",
	"CODEX_THREAD_ID",
	"CODEX_VERSION",
	"CURSOR_TRACE_ID",
];

for (const name of Object.keys(process.env)) {
	if (name.startsWith("TEDIX_") || HARNESS_SESSION_ENV.includes(name)) {
		delete process.env[name];
	}
}

// The test runner's own host (a Codex or Claude shell) must not pick a session.
setProcessTableReader(() => []);
