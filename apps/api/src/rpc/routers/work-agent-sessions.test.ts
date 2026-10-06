import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { workAgentSessions } from "@tedix/db/schema/work-agent-sessions";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { workAgentSessionsContractRouter } from "./work-agent-sessions";

const ORG_ID = "00000000-0000-4000-8000-000000000001";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(workAgentSessions));
	const facade = createD1Facade(sqlite);
	const baseContext = {
		db: createDbClient(facade),
		env: { ENVIRONMENT: "test", DB: facade } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG_ID,
		url: new URL("https://api.tedix.test/rpc/workAgentSessions"),
	};
	const userClient = (userId: string) =>
		createRouterClient(workAgentSessionsContractRouter, {
			context: {
				...baseContext,
				authType: "user",
				userId,
				userRole: "member",
				user: {
					aud: "test",
					dct: "tenant-1",
					exp: 2,
					iat: 1,
					iss: "https://auth.tedix.test",
					permissions: [],
					roles: [],
					sub: `${userId}-sub`,
				},
			} as BaseContext,
		});
	const tediClient = createRouterClient(workAgentSessionsContractRouter, {
		context: {
			...baseContext,
			organizationId: undefined,
			headers: new Headers({
				"X-Service-Binding": "true",
				"X-Tedix-Org-Id": ORG_ID,
				"X-Tedix-Tedi-Id": "55555555-5555-4555-8555-555555555555",
				"X-Tedix-Tedi-Scopes": "mcp:work.read mcp:work.write",
			}),
		} as BaseContext,
	});
	return {
		sqlite,
		ada: userClient("ada"),
		grace: userClient("grace"),
		tediClient,
	};
}

const report = {
	harness: "claude-code" as const,
	sessionKey: "session-1",
	state: "needs_you" as const,
	summary: "Waiting\u0007 for\n\napproval\u001b[31m",
	label: "  tedix\tmain  ",
};

describe("workAgentSessions router", () => {
	it("records a sanitized report for the calling human and lists it", async () => {
		const { ada } = fixture();
		const first = await ada.report(report);
		expect(first.changed).toBe(true);
		expect(first.session).toMatchObject({
			state: "needs_you",
			effectiveState: "needs_you",
			summary: "Waiting for approval [31m",
			label: "tedix main",
		});
		expect((await ada.report(report)).changed).toBe(false);

		const board = await ada.list({});
		expect(board.sessions.map((session) => session.sessionKey)).toEqual([
			"session-1",
		]);
		expect(board.counts).toEqual({
			needs_you: 1,
			error: 0,
			done: 0,
			working: 0,
			idle: 0,
			ended: 0,
		});
	});

	it("never shows one user's sessions to another", async () => {
		const { ada, grace } = fixture();
		await ada.report(report);
		expect((await grace.list({})).sessions).toEqual([]);
	});

	it("hides ended sessions unless asked", async () => {
		const { ada } = fixture();
		await ada.report({ ...report, state: "ended" });
		expect((await ada.list({})).sessions).toEqual([]);
		expect(
			(await ada.list({ includeEnded: true })).sessions.map(
				(session) => session.effectiveState,
			),
		).toEqual(["ended"]);
	});

	it("rejects non-human principals", async () => {
		const { tediClient } = fixture();
		await expect(tediClient.report(report)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(tediClient.list({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});
