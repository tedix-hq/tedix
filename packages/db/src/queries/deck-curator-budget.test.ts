import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { reserveDeckRankingBudget } from "./deck-curator-budget";

it("atomically caps concurrent reservations, preserves tenant metadata and resets only on a new UTC day", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec(schemaDdl(organizations));
		const db = createDbQueryClient(createD1Facade(sqlite));
		await db.insert(organizations).values([
			{
				id: "fictional-lighthouse",
				name: "Lighthouse",
				slug: "lighthouse",
				metadata: { industryVertical: "fictional" },
			},
			{ id: "fictional-harbor", name: "Harbor", slug: "harbor" },
		]);
		const input = {
			organizationId: "fictional-lighthouse",
			amountMicros: 5000,
			dailyLimitMicros: 10000,
		};
		const results = await Promise.all(
			Array.from({ length: 8 }, () => reserveDeckRankingBudget(db, input)),
		);
		expect(results.filter(Boolean)).toHaveLength(2);
		expect(
			await reserveDeckRankingBudget(db, {
				...input,
				organizationId: "missing",
			}),
		).toBe(false);
		expect(
			await reserveDeckRankingBudget(db, { ...input, amountMicros: -1 }),
		).toBe(false);
		const metadata = () =>
			JSON.parse(
				String(
					sqlite
						.prepare(
							"SELECT metadata FROM organizations WHERE id='fictional-lighthouse'",
						)
						.get()!.metadata,
				),
			);
		expect(metadata()).toMatchObject({
			industryVertical: "fictional",
			deckRankerBudget: { reservedMicros: 10000 },
		});
		expect(
			sqlite
				.prepare(
					"SELECT metadata FROM organizations WHERE id='fictional-harbor'",
				)
				.get()!.metadata,
		).toBeNull();
		sqlite.exec(
			"UPDATE organizations SET metadata=json_set(metadata,'$.deckRankerBudget.day','2000-01-01') WHERE id='fictional-lighthouse'",
		);
		expect(await reserveDeckRankingBudget(db, input)).toBe(true);
		expect(metadata().deckRankerBudget.reservedMicros).toBe(5000);
		sqlite.exec(
			"UPDATE organizations SET metadata=json_set(metadata,'$.deckRankerBudget.reservedMicros','corrupt') WHERE id='fictional-lighthouse'",
		);
		expect(await reserveDeckRankingBudget(db, input)).toBe(false);
	} finally {
		sqlite.close();
	}
});
