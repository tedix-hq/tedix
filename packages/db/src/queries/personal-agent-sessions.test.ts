import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { coreTable } from "../core-store/client";
import { createPGliteFacade } from "../test/pglite-facade";
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

let close: (() => void | Promise<void>) | undefined;
afterEach(async () => {
	await close?.();
	close = undefined;
});
async function fixture(store: "d1" | "postgres") {
	if (store === "postgres") {
		const fixture = await createPGliteFacade();
		close = fixture.close;
		for (const migration of readMigrationFiles({
			migrationsFolder: fileURLToPath(
				new URL("../../drizzle-pg", import.meta.url),
			),
		}))
			for (const ddl of migration.sql) await fixture.engine.exec(ddl);
		await fixture.db.insert(coreTable(fixture.db, organizations)).values([
			{ id: "org-example", name: "Example", slug: "example" },
			{ id: "other-org", name: "Other", slug: "other" },
		]);
		return { db: fixture.db };
	}

	const sqlite = new DatabaseSync(":memory:");
	close = () => sqlite.close();
	sqlite.exec(
		schemaDdl(organizations, personalAgentSessions, personalAgentClientRates),
	);
	sqlite
		.prepare("INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)")
		.run("org-example", "Example", "example");
	sqlite
		.prepare("INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)")
		.run("other-org", "Other", "other");
	return { db: createDbQueryClient(createD1Facade(sqlite)) };
}
const session = {
	organizationId: "org-example",
	clientId: "https://agent.example/client.json",
	sessionId: "session-1",
	userId: "user-1",
	version: "1.0",
	now: 1_800_000_000_000,
};

for (const store of ["d1", "postgres"] as const)
	describe(`personal agent sessions (${store})`, () => {
		it("starts once, continues, and permits multiple Sessions per user", async () => {
			const { db } = await fixture(store);
			expect(await continuePersonalAgentSession(db, session)).toBe("started");
			expect(await continuePersonalAgentSession(db, session)).toBe("accepted");
			expect(
				await continuePersonalAgentSession(db, {
					...session,
					sessionId: "session-2",
				}),
			).toBe("started");
		});
		it("retains ended tombstones and isolates organizations, clients and users", async () => {
			const { db } = await fixture(store);
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
				).toBe("started");
			}
			expect(await continuePersonalAgentSession(db, session)).toBe(
				"session_ended",
			);
		});
		it("rejects an agent or version change within the same Session", async () => {
			const { db } = await fixture(store);
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
			const { db } = await fixture(store);
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
		});
	});
