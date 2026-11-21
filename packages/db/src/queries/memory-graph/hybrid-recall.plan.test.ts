import { expect, it, vi } from "vite-plus/test";
import { createDbClient } from "../../client";
import {
	memoryDomains,
	memoryFacts,
	tediExpertise,
} from "../../schema/memory-graph";
import { sweepExpiredProbationFacts } from "../fact-lifecycle";
import { getExpertise } from "./expertise";
import { tedis } from "../../schema/tedis";
import { decayConfidence } from "./fact-lifecycle";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { recordRecallAccess } from "./hybrid-recall";

it("records recall access by fact id, not by walking the organization's facts", async () => {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const plans: string[] = [];
	const db = createDbQueryClient(
		createD1Facade({
			prepare(query) {
				if (query.startsWith('update "memory_facts"'))
					plans.push(
						...sqlite
							.prepare(`EXPLAIN QUERY PLAN ${query}`)
							.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
							.map((row) => String(row.detail)),
					);
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}) as never,
	);
	await recordRecallAccess(db as never, { organizationId: "org-example" }, [
		"fact-a",
		"fact-b",
	]);
	expect(plans.join("\n")).toMatch(
		/SEARCH memory_facts USING INDEX sqlite_autoindex_memory_facts_1 \(id=\?\)/,
	);
});

it.each([10, 100])(
	"throttles %i recall results and preserves projection and lifecycle inputs",
	async (size) => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-21T12:00:00.000Z"));
		try {
			const sqlite = createMigratedSqlite({ foreignKeys: false });
			const db = createDbClient(createD1Facade(sqlite));
			const scope = { organizationId: "orchard" };
			await db.insert(tedis).values({
				id: "tedi",
				organizationId: "orchard",
				name: "Shipping",
				slug: "shipping",
			});
			await db
				.insert(memoryDomains)
				.values({ id: "domain", organizationId: "orchard", name: "Shipping" });
			await db.insert(tediExpertise).values({
				id: "expertise",
				tediId: "tedi",
				domainId: "domain",
				factCount: size,
				avgConfidence: 0.8,
			});
			const ids = Array.from({ length: size }, (_, i) => `fact-${i}`);
			for (const id of [...ids, "overflow", "foreign"]) {
				await db.insert(memoryFacts).values({
					id,
					organizationId: id === "foreign" ? "other" : "orchard",
					tediId: id === "foreign" ? null : "tedi",
					domainId: id === "foreign" ? null : "domain",
					content: "Shipping advice",
					factType: "technical",
					confidence: 0.8,
					usageCount: 1,
					status: "probation",
					createdAt: "2020-01-01T00:00:00.000Z",
					updatedAt: "2020-01-01T00:00:00.000Z",
				});
			}
			const changes = () =>
				Number(sqlite.prepare("SELECT total_changes() AS n").get()!.n);
			const measure = async (run: () => unknown) => {
				const before = changes();
				await run();
				return changes() - before;
			};
			// Previous memory.search bookkeeping, including the real migration triggers.
			const previous = () =>
				sqlite
					.prepare(
						"UPDATE memory_facts SET last_accessed_at=?, access_count=access_count+1 WHERE id IN (SELECT value FROM json_each(?)) AND +organization_id=?",
					)
					.run(new Date().toISOString(), JSON.stringify(ids), "orchard");
			const before = [await measure(previous), await measure(previous)];
			sqlite.exec(
				"UPDATE memory_facts SET last_accessed_at=NULL, access_count=0; DELETE FROM graph_projection_outbox",
			);
			const searchIds = [
				...ids,
				...ids,
				"foreign",
				...(size === 100 ? ["overflow"] : []),
			];
			const first = await measure(() =>
				recordRecallAccess(db, scope, searchIds),
			);
			expect(first).toBe(before[0]);
			const burst = await measure(() =>
				Promise.all(
					Array.from({ length: 5 }, () =>
						recordRecallAccess(db, scope, searchIds),
					),
				),
			);
			expect(burst).toBe(0);
			vi.setSystemTime(new Date("2026-11-21T12:04:59.999Z"));
			expect(
				await measure(() => recordRecallAccess(db, scope, searchIds)),
			).toBe(0);
			vi.setSystemTime(new Date("2026-11-21T12:05:00.000Z"));
			const nextWindow = await measure(() =>
				recordRecallAccess(db, scope, searchIds),
			);
			expect(nextWindow).toBe(first);
			expect(
				sqlite
					.prepare(
						"SELECT count(*) AS n FROM memory_facts WHERE access_count=2 AND last_accessed_at='2026-11-21T12:05:00.000Z'",
					)
					.get()!.n,
			).toBe(size);
			expect(
				sqlite
					.prepare("SELECT access_count FROM memory_facts WHERE id='foreign'")
					.get()!.access_count,
			).toBe(0);
			expect(
				sqlite
					.prepare(
						"SELECT count(*) AS n FROM graph_projection_outbox WHERE entity_kind='fact' AND operation='upsert'",
					)
					.get()!.n,
			).toBe(2 * size);
			const [expertise] = await getExpertise(db, scope, "tedi");
			// The untouched overflow fact keeps the baseline score.
			expect(expertise!.competenceScore).toBeCloseTo(
				(size * 0.4 + 0.8) / (size + 1),
			);
			expect(
				await decayConfidence(db, scope, 0.99, 0.1, { factIds: ids }),
			).toBe(0);
			const archived = await sweepExpiredProbationFacts(db, {
				organizationId: "orchard",
			});
			expect(archived.archivedIds.some((id) => ids.includes(id))).toBe(false);
			expect(archived.archivedIds).toContain("overflow");
			console.info(
				JSON.stringify({
					results: size,
					sqliteRowWrites: { before, first, burst, nextWindow },
					note: "Includes trigger rows; excludes physical index writes",
				}),
			);
		} finally {
			vi.useRealTimers();
		}
	},
);
