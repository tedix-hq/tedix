/**
 * Fixed offline retrieval eval for chat memory. One fictional organization,
 * a corpus where high-confidence house rules crowd the static top facts, and
 * three query classes: ordinary questions, exact topics and date cues.
 * Recall@5 is the share of queries whose expected fact is in the top five.
 */
import { createDbClient } from "@tedix/db/client";
import { getTopPlatformFacts } from "@tedix/db/queries/memory-graph/platform-facts";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { recallMemoryFacts } from "./memory-hybrid-recall";

const ORG = "fictional-eval-org";
const NOW = "2026-10-24T12:00:00.000Z";

const CORPUS: Array<{
	id: string;
	content: string;
	confidence: number;
	priority: "core" | "active";
	validFrom: string;
}> = [
	// House rules: high confidence, rarely the answer to a specific question.
	["n1", "The team prefers short weekly status summaries.", 0.95, "core"],
	["n2", "Brand voice is plain and friendly in every message.", 0.95, "core"],
	["n3", "Use metric units in customer-facing documents.", 0.94, "core"],
	["n4", "All invoices are issued in EUR.", 0.93, "core"],
	["n5", "The support inbox is checked twice a day.", 0.92, "active"],
	["n6", "Design reviews happen on Thursdays.", 0.92, "active"],
	["n7", "Release notes go out after each deploy.", 0.91, "active"],
	["n8", "Meeting notes live in the shared workspace.", 0.9, "active"],
].map(([id, content, confidence, priority]) => ({
	id: id as string,
	content: content as string,
	confidence: confidence as number,
	priority: priority as "core" | "active",
	validFrom: "2026-06-01T09:00:00.000Z",
}));
for (const [id, content, validFrom] of [
	[
		"t1",
		"Acme Bikes asked for invoice reminders every 14 days instead of 30.",
		"2026-10-02T09:00:00.000Z",
	],
	[
		"t2",
		"Purchase order PO-4471 for 40 brake kits ships from the Leipzig warehouse.",
		"2026-10-05T09:00:00.000Z",
	],
	[
		"t3",
		"The Leipzig warehouse closes for its yearly inventory count on November 3.",
		"2026-10-06T09:00:00.000Z",
	],
	[
		"t4",
		"Agreed with Lena to pause the spring catalog until pricing is final.",
		"2026-10-20T15:00:00.000Z",
	],
	[
		"t5",
		"The churn review moved the renewal call with Nordwind to Friday.",
		"2026-10-23T10:00:00.000Z",
	],
	[
		"t6",
		"Shipping costs to Austria rose by 8 percent.",
		"2026-10-21T08:00:00.000Z",
	],
	[
		"t7",
		"The onboarding checklist now includes a data-protection step.",
		"2026-10-19T11:00:00.000Z",
	],
	[
		"t8",
		"Holger prefers phone calls over email for urgent stock issues.",
		"2026-09-30T09:00:00.000Z",
	],
	[
		"t9",
		"Benelux orders switched to a regional courier partner.",
		"2026-09-15T09:00:00.000Z",
	],
] as const)
	CORPUS.push({ id, content, confidence: 0.7, priority: "active", validFrom });

const QUERIES: Array<{
	kind: "ordinary" | "exact" | "date";
	query: string;
	expect: string;
}> = [
	{
		kind: "ordinary",
		query: "How often should we remind Acme Bikes about their invoices?",
		expect: "t1",
	},
	{
		kind: "ordinary",
		query: "What is the best way to reach Holger when stock is urgent?",
		expect: "t8",
	},
	{
		kind: "ordinary",
		query: "Can you tell me what we decided about the spring catalog?",
		expect: "t4",
	},
	{ kind: "exact", query: "PO-4471", expect: "t2" },
	{ kind: "exact", query: "Leipzig warehouse inventory count", expect: "t3" },
	{ kind: "exact", query: "Austria shipping costs", expect: "t6" },
	{ kind: "date", query: "What happened yesterday?", expect: "t5" },
	{ kind: "date", query: "What did we agree on October 20?", expect: "t4" },
	{ kind: "date", query: "What changed 3 days ago?", expect: "t6" },
	{ kind: "date", query: "Anything new this week?", expect: "t7" },
	{ kind: "date", query: "What did we change in September?", expect: "t9" },
];

let db: ReturnType<typeof createDbClient>;
beforeAll(() => {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const insert = sqlite.prepare(
		`INSERT INTO memory_facts(id,organization_id,content,fact_type,visibility,confidence,priority,valid_from,created_at,review_status,memory_scope,use_policy)
		VALUES (?,?,?,'business','org',?,?,?,?,'confirmed','org','can_use_as_evidence')`,
	);
	for (const fact of CORPUS)
		insert.run(
			fact.id,
			ORG,
			fact.content,
			fact.confidence,
			fact.priority,
			fact.validFrom,
			fact.validFrom,
		);
	db = createDbClient(createD1Facade(sqlite));
	vi.useFakeTimers({ toFake: ["Date"], now: new Date(NOW) });
});
afterAll(() => vi.useRealTimers());

function recallAt5(hits: boolean[]) {
	return hits.filter(Boolean).length / hits.length;
}

describe("chat memory retrieval eval", () => {
	it("finds the asked-about fact for ordinary, exact-topic and date-cued messages", async () => {
		const staticTop = (await getTopPlatformFacts(db, ORG, { limit: 5 })).map(
			(row) => row.fact.id,
		);
		const rows = [];
		for (const query of QUERIES) {
			const started = performance.now();
			const ranked = await recallMemoryFacts(db, {
				orgId: ORG,
				query: query.query,
				topK: 5,
			});
			rows.push({
				...query,
				ms: performance.now() - started,
				message: ranked.some((row) => row.factId === query.expect),
				static: staticTop.includes(query.expect),
			});
		}
		const byKind = Object.fromEntries(
			(["ordinary", "exact", "date"] as const).map((kind) => {
				const of = rows.filter((row) => row.kind === kind);
				return [
					kind,
					{
						static: recallAt5(of.map((row) => row.static)),
						message: recallAt5(of.map((row) => row.message)),
					},
				];
			}),
		);
		console.info(
			JSON.stringify({
				eval: "chat-memory-recall@5",
				byKind,
				misses: rows.filter((row) => !row.message).map((row) => row.query),
				meanMs:
					rows.reduce((sum, row) => sum + row.ms, 0) / Math.max(1, rows.length),
			}),
		);
		// House rules crowd every asked-about fact out of the static top five.
		for (const kind of ["ordinary", "exact", "date"])
			expect(byKind[kind]!.static).toBe(0);
		expect(byKind.ordinary!.message).toBe(1);
		expect(byKind.exact!.message).toBe(1);
	});
});
