import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	recordSessionScope,
	readSessionScopes,
	scopeFromWorkResult,
	scopeSession,
} from "./session-scope";

const session = "11111111-1111-4111-8111-111111111111";
test("scope is private to the host session and expires; hook calls cannot pin it", () => {
	const configDir = mkdtempSync(join(tmpdir(), "session-scope-"));
	try {
		const env = { CODEX_THREAD_ID: session };
		recordSessionScope(
			{ workspace: "fixture", organization: "org_orchid" },
			env,
			{ configDir },
		);
		recordSessionScope(
			{ workspace: "fixture", organization: "org_cedar" },
			{ ...env, TEDIX_HOOK_READ: "1" },
			{ configDir },
		);
		expect(
			readSessionScopes(session, { configDir }).map((row) => row.organization),
		).toEqual(["org_orchid"]);
		expect(
			readSessionScopes("22222222-2222-4222-8222-222222222222", { configDir }),
		).toEqual([]);
		expect(
			readSessionScopes(session, { configDir }, Date.now() + 3 * 60 * 60_000),
		).toEqual([]);
		expect(
			scopeSession({
				...env,
				CLAUDE_CODE_SESSION_ID: "22222222-2222-4222-8222-222222222222",
			}),
		).toBeUndefined();
	} finally {
		rmSync(configDir, { recursive: true, force: true });
	}
});

test("Code Mode Work results correlate only this session's live Attempt", () => {
	const value = {
		workItem: {
			id: "22222222-2222-4222-8222-222222222222",
			projectId: "33333333-3333-4333-8333-333333333333",
		},
		attempt: {
			runtimeState: "running",
			externalSessionKey: `codex:${session}`,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		},
	};
	expect(scopeFromWorkResult(value, session)).toMatchObject({
		workItemId: value.workItem.id,
	});
	expect(
		scopeFromWorkResult(value, "44444444-4444-4444-8444-444444444444")
			.workItemId,
	).toBeUndefined();
	expect(
		scopeFromWorkResult(
			{ ...value, attempt: { ...value.attempt, runtimeState: "settled" } },
			session,
		).workItemId,
	).toBeUndefined();
});
