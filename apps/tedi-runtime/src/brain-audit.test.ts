import assert from "node:assert/strict";
import {
	auditMemoryGraph,
	type BrainAuditDeps,
} from "@tedix/db/queries/memory-audit";

type QueryRecord = {
	sql: string;
	params: unknown[];
	kind: "all" | "first";
};

function makeDb(records: QueryRecord[]): BrainAuditDeps["db"] {
	return {
		prepare(sql: string) {
			return {
				bind(...params: unknown[]) {
					return {
						async first<T>(): Promise<T | null> {
							records.push({ sql, params, kind: "first" });
							return { count: 2 } as T;
						},
						async all<T>(): Promise<{ results?: T[] }> {
							records.push({ sql, params, kind: "all" });
							if (sql.includes("SELECT COALESCE(")) {
								return {
									results: [
										{ value: "pending", count: 1 },
										{ value: "__null__", count: 1 },
									] as T[],
								};
							}
							return {
								results: [
									{
										id: "fact-1",
										tediId: "tedi-1",
										contentPreview: "Acme should keep CMS quality facts.",
										summary: "CMS quality",
										factType: "decision",
										confidence: 0.9,
										status: "active",
										source: "conversation://run-1",
										sourceSessionId: "run-1",
										topicKey: null,
										memoryScope: "tedi",
										usePolicy: "can_use_as_evidence",
										reviewStatus: "pending",
										metadata: JSON.stringify({
											producer: "observer",
											sourceKind: "turn",
										}),
										producer: "observer",
										sourceKind: "turn",
										priority: "active",
										visibility: "private",
										promotedFrom: null,
										promotedAt: null,
										archivedAt: null,
										createdAt: "2026-06-28T10:00:00Z",
										updatedAt: "2026-06-28T10:00:00Z",
									},
									{
										id: "fact-2",
										tediId: "tedi-1",
										contentPreview: "Second fact",
										summary: null,
										factType: "episode",
										confidence: "0.8",
										status: "active",
										source: "conversation://run-2",
										sourceSessionId: "run-2",
										topicKey: "acme.cms.latest",
										memoryScope: "tedi",
										usePolicy: "can_use_as_evidence",
										reviewStatus: "confirmed",
										metadata: null,
										producer: null,
										sourceKind: null,
										priority: "core",
										visibility: "private",
										promotedFrom: null,
										promotedAt: null,
										archivedAt: null,
										createdAt: "2026-06-28T11:00:00Z",
										updatedAt: "2026-06-28T11:00:00Z",
									},
								] as T[],
							};
						},
					};
				},
			};
		},
	};
}

const records: QueryRecord[] = [];
const result = await auditMemoryGraph(
	{
		db: makeDb(records),
		organizationId: "org-1",
		tediId: "tedi-1",
	},
	{
		scope: "self",
		topic_key_state: "missing",
		review_status: "pending",
		producer: "observer",
		limit: 999,
		offset: -10,
	},
);

assert.equal(result.ok, true);
assert.equal(result.filters.scope, "self");
assert.equal(result.filters.limit, 100);
assert.equal(result.filters.offset, 0);
assert.equal(result.counts.total, 2);
assert.equal(result.counts.activePendingMissingTopicKey, 2);
assert.equal(result.facts.length, 2);
assert.deepEqual(result.facts[0]?.metadata, {
	producer: "observer",
	sourceKind: "turn",
});
assert.equal(result.facts[1]?.confidence, 0.8);
assert.equal(result.nextOffset, null);

const factSelect = records.find(
	(record) =>
		record.kind === "all" &&
		record.sql.includes("SELECT") &&
		record.sql.includes("contentPreview"),
);
assert.ok(factSelect, "fact select query was executed");
assert.match(factSelect.sql, /organization_id = \?/);
assert.match(factSelect.sql, /tedi_id = \?/);
assert.match(factSelect.sql, /archived_at IS NULL/);
assert.match(factSelect.sql, /topic_key IS NULL OR trim\(topic_key\) = ''/);
assert.match(factSelect.sql, /review_status = \?/);
assert.match(factSelect.sql, /json_extract\(metadata, '\$\.producer'\) = \?/);
assert.deepEqual(factSelect.params, [
	"org-1",
	"tedi-1",
	"pending",
	"observer",
	100,
	0,
]);

const qualityCount = records.find((record) =>
	record.sql.includes("activePendingMissingTopicKey"),
);
assert.equal(qualityCount, undefined, "count aliases stay out of SQL");

const activePendingCount = records.find(
	(record) =>
		record.kind === "first" && record.sql.includes("review_status = 'pending'"),
);
assert.ok(
	activePendingCount,
	"active pending missing-topic count was executed",
);
assert.deepEqual(activePendingCount.params, ["org-1", "tedi-1"]);

const visibleRecords: QueryRecord[] = [];
await auditMemoryGraph(
	{
		db: makeDb(visibleRecords),
		organizationId: "org-1",
		tediId: "tedi-1",
	},
	{ scope: "visible", topic_key_state: "present", include_archived: true },
);
const visibleSelect = visibleRecords.find(
	(record) => record.kind === "all" && record.sql.includes("contentPreview"),
);
assert.ok(visibleSelect, "visible fact select query was executed");
assert.match(visibleSelect.sql, /tedi_id = \? OR tedi_id IS NULL/);
assert.doesNotMatch(visibleSelect.sql, /archived_at IS NULL/);
assert.match(
	visibleSelect.sql,
	/topic_key IS NOT NULL AND trim\(topic_key\) <> ''/,
);
assert.deepEqual(visibleSelect.params, ["org-1", "tedi-1", 25, 0]);

const allRecords: QueryRecord[] = [];
await auditMemoryGraph(
	{
		db: makeDb(allRecords),
		organizationId: "org-1",
		tediId: "tedi-1",
	},
	{ scope: "all" },
);
const allSelect = allRecords.find(
	(record) => record.kind === "all" && record.sql.includes("contentPreview"),
);
assert.ok(allSelect, "all-scope fact select query was executed");
assert.match(allSelect.sql, /organization_id = \?/);
assert.doesNotMatch(allSelect.sql, /tedi_id = \?/);
assert.deepEqual(allSelect.params, ["org-1", 25, 0]);

console.log("All brain-audit tests passed.");
