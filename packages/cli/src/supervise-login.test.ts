import { expect, test } from "bun:test";
import { isolateRenewalTests } from "./renewal-test-env";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { alertStrandedLogins } from "./supervise-login";
import { acquireCredentialLock } from "./credential-lock";
import { writeWorkspaceCredentials } from "./credential-store";

isolateRenewalTests();

test("four runners alert once across passes and restart, after the renewer exits", async () => {
	const directory = process.env.TEDIX_CONFIG_DIR!;
	const env = { TEDIX_CONFIG_DIR: directory };
	writeFileSync(
		join(directory, "supervisor-runners.json"),
		JSON.stringify({
			version: 1,
			runners: ["codex", "claude-code", "opencode", "devin"].map(
				(executor) => ({
					workspace: "fixture",
					organization: "org_fixture",
					executor,
					max: 1,
					rules: "lane-rules",
					repo: "/fixture",
				}),
			),
		}),
	);
	const credential = {
		loginId: "fixture-owner",
		oauthRefreshPending: true,
		accessTokenExpiresAtSeconds: Math.floor(Date.now() / 1000) + 600,
		oauthTokens: {
			access_token: "fixture-access",
			refresh_token: "spent",
			token_type: "Bearer",
		},
	};
	writeWorkspaceCredentials("fixture", credential);
	let notifications = 0;
	const notify = (message: string) => {
		notifications++;
		expect(message).toContain("tedix login --workspace fixture");
		expect(message).not.toContain("spent");
		return true;
	};
	const lock = await acquireCredentialLock("fixture");
	try {
		expect(alertStrandedLogins(env, notify)).toBe(0);
	} finally {
		lock?.release();
	}
	// Notification transport failure must remain retryable.
	expect(alertStrandedLogins(env, () => false)).toBe(0);
	expect(alertStrandedLogins(env, notify)).toBe(1);
	expect(alertStrandedLogins({ ...env }, notify)).toBe(0);
	expect(notifications).toBe(1);
	writeWorkspaceCredentials("fixture", {
		...credential,
		oauthRefreshPending: undefined,
	});
	expect(alertStrandedLogins(env, notify)).toBe(0);
	writeWorkspaceCredentials("fixture", {
		...credential,
		oauthRefreshPending: undefined,
		oauthRefreshInvalidated: true,
		oauthTokens: { ...credential.oauthTokens, refresh_token: "another-spent" },
	});
	expect(alertStrandedLogins(env, notify)).toBe(1);
	expect(notifications).toBe(2);
});
