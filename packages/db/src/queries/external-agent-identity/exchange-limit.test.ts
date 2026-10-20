import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import {
	externalAgentPrincipals,
	externalAgentExchangeLimits,
} from "../../schema/external-agent-identity";
import { createD1Facade } from "../../test/d1-facade";
import { tableDdl } from "../../test/schema-ddl";
import { consumeExternalAgentExchangeBudget } from "./sessions";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		[externalAgentPrincipals, externalAgentExchangeLimits]
			.flatMap(tableDdl)
			.join(";"),
	);
	return { sqlite, db: createDbClient(createD1Facade(sqlite)) };
}
const params = {
	organizationId: "fixture-org",
	principalId: "fixture-agent",
	nowMs: Date.parse("2030-01-01T00:00:10Z"),
};
describe("durable per-principal exchange budget", () => {
	it("permits thirty requests and rejects the thirty-first across client instances", async () => {
		const { sqlite, db } = fixture();
		try {
			for (let i = 0; i < 30; i++)
				expect(await consumeExternalAgentExchangeBudget(db, params)).toBe(true);
			const freshClient = createDbClient(createD1Facade(sqlite));
			expect(
				await consumeExternalAgentExchangeBudget(freshClient, params),
			).toBe(false);
			expect(
				sqlite
					.prepare("SELECT request_count FROM external_agent_exchange_limits")
					.get(),
			).toMatchObject({ request_count: 30 });
		} finally {
			sqlite.close();
		}
	});
	it("does not oversubscribe under concurrent requests", async () => {
		const { sqlite, db } = fixture();
		try {
			const admitted = await Promise.all(
				Array.from({ length: 61 }, () =>
					consumeExternalAgentExchangeBudget(db, params),
				),
			);
			expect(admitted.filter(Boolean)).toHaveLength(30);
			expect(admitted.filter((x) => !x)).toHaveLength(31);
		} finally {
			sqlite.close();
		}
	});
	it("isolates principals and organizations, rolls over at the minute boundary, and rejects older buckets", async () => {
		const { sqlite, db } = fixture();
		try {
			for (let i = 0; i < 30; i++)
				await consumeExternalAgentExchangeBudget(db, params);
			expect(
				await consumeExternalAgentExchangeBudget(db, {
					...params,
					principalId: "other-agent",
				}),
			).toBe(true);
			expect(
				await consumeExternalAgentExchangeBudget(db, {
					...params,
					organizationId: "other-org",
				}),
			).toBe(true);
			expect(
				await consumeExternalAgentExchangeBudget(db, {
					...params,
					nowMs: Date.parse("2030-01-01T00:00:59.999Z"),
				}),
			).toBe(false);
			expect(
				await consumeExternalAgentExchangeBudget(db, {
					...params,
					nowMs: Date.parse("2030-01-01T00:01:00.000Z"),
				}),
			).toBe(true);
			expect(await consumeExternalAgentExchangeBudget(db, params)).toBe(false);
			expect(
				sqlite
					.prepare(
						"SELECT count(*) AS total FROM external_agent_exchange_limits",
					)
					.get(),
			).toMatchObject({ total: 3 });
		} finally {
			sqlite.close();
		}
	});
});
