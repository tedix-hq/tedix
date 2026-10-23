import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("broker retries transient exchanges without retrying rejected identities", () => {
	const cases: [string, boolean][] = [
		['{"error":"Session exchange failed"}', true],
		['tedix failed (1): {"error":"Session exchange failed"}', true],
		[
			"External-agent session exchange failed (502). Inspect agent status",
			true,
		],
		["Session backend unavailable; retry shortly with the same session", true],
		["External-agent credential exchange timed out", true],
		["Native call deadline elapsed", true],
		["429 exchange_rate_limited", true],
		['{"error":"Session exchange rejected"}', false],
		["External-agent session exchange failed (401)", false],
		["External-agent session exchange failed (403)", false],
		["Session exchange failed (409, session_ended)", false],
		["credential_binding_mismatch", false],
		["enrollment_expired", false],
		["Work lease expired", false],
		["arbitrary command failed", false],
	];
	const result = spawnSync(
		"python3",
		[
			"-B",
			"-c",
			"import json, sys; from lane_session_errors import transient_session_error; print(json.dumps([transient_session_error(s) for s in json.load(sys.stdin)]))",
		],
		{
			cwd: fileURLToPath(new URL(".", import.meta.url)),
			input: JSON.stringify(cases.map(([message]) => message)),
			encoding: "utf8",
		},
	);
	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual(cases.map(([, retry]) => retry));
});
