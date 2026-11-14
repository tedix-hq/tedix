import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { organizations } from "../schema/organizations";
import {
	personalAgentClientRates,
	personalAgentSessions,
} from "../schema/personal-agent-sessions";
import {
	consumePersonalAgentClientRate,
	continuePersonalAgentSession,
	endPersonalAgentSession,
} from "./personal-agent-sessions";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(organizations, personalAgentSessions, personalAgentClientRates),
	);
	sqlite
		.prepare("INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)")
		.run("org-example", "Example", "example");
	sqlite
		.prepare("INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)")
		.run("other-org", "Other", "other");
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}
const session = {
	organizationId: "org-example",
	clientId: "https://agent.example/client.json",
	sessionId: "session-1",
	userId: "user-1",
	version: "1.0",
	now: 1_800_000_000_000,
};

describe("personal agent Sessions on D1", () => {
	it("starts once, continues, and permits multiple Sessions per user", async () => {
		const { db, sqlite } = fixture();
		expect(await continuePersonalAgentSession(db, session)).toBe("accepted");
		expect(await continuePersonalAgentSession(db, session)).toBe("accepted");
		expect(
			sqlite
				.prepare("SELECT count(*) AS count FROM personal_agent_sessions")
				.get(),
		).toEqual({ count: 1 });
		expect(
			await continuePersonalAgentSession(db, {
				...session,
				sessionId: "session-2",
			}),
		).toBe("accepted");
		expect(
			sqlite
				.prepare("SELECT count(*) AS count FROM personal_agent_sessions")
				.get(),
		).toEqual({ count: 2 });
	});
	it("retains ended tombstones and isolates organizations, clients and users", async () => {
		const { db } = fixture();
		await continuePersonalAgentSession(db, session);
		await endPersonalAgentSession(db, session);
		expect(await continuePersonalAgentSession(db, session)).toBe(
			"session_ended",
		);
		for (const scope of [
			{ organizationId: "other-org" },
			{ clientId: "https://other.example/agent.json" },
			{ userId: "other-user" },
		]) {
			expect(
				await continuePersonalAgentSession(db, { ...session, ...scope }),
			).toBe("accepted");
		}
		expect(await continuePersonalAgentSession(db, session)).toBe(
			"session_ended",
		);
	});
	it("rejects an agent or version change within the same Session", async () => {
		const { db } = fixture();
		await continuePersonalAgentSession(db, session);
		expect(
			await continuePersonalAgentSession(db, {
				...session,
				agentId: "new-agent",
			}),
		).toBe("invalid_session");
		expect(
			await continuePersonalAgentSession(db, { ...session, version: "1.1" }),
		).toBe("invalid_session");
		expect(await continuePersonalAgentSession(db, session)).toBe("accepted");
	});
	it("counts requests across Sessions and resets only at the next minute", async () => {
		const { db, sqlite } = fixture();
		const request = {
			organizationId: session.organizationId,
			clientId: session.clientId,
			now: session.now,
			limit: 2,
		};
		expect(await consumePersonalAgentClientRate(db, request)).toBe(true);
		expect(await consumePersonalAgentClientRate(db, request)).toBe(true);
		expect(await consumePersonalAgentClientRate(db, request)).toBe(false);
		expect(
			await consumePersonalAgentClientRate(db, {
				...request,
				organizationId: "other-org",
			}),
		).toBe(true);
		expect(
			await consumePersonalAgentClientRate(db, {
				...request,
				now: request.now + 60_000,
			}),
		).toBe(true);
		expect(
			sqlite
				.prepare("SELECT count(*) AS count FROM personal_agent_client_rates")
				.get(),
		).toEqual({ count: 2 });
	});
});
