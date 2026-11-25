import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import {
	decisionSourcesCurrent,
	decisionSourcesReview,
	prefetchDecisionSources,
} from "./decision-sources";
import { createMigratedSqlite } from "../../test/migrated-sqlite";

it.each([
	[
		"00000000-0000-4000-8000-000000000001",
		"00000000-0000-4000-8000-000000000006",
		true,
	],
	[
		"00000000-0000-4000-8000-000000000001",
		"00000000-0000-4000-8000-000000000007",
		false,
	],
	[
		"00000000-0000-4000-8000-000000000002",
		"00000000-0000-4000-8000-000000000008",
		false,
	],
	[
		"00000000-0000-4000-8000-000000000003",
		"00000000-0000-4000-8000-000000000009",
		false,
	],
	[
		"00000000-0000-4000-8000-000000000004",
		"00000000-0000-4000-8000-000000000010",
		false,
	],
	[
		"00000000-0000-4000-8000-000000000005",
		"00000000-0000-4000-8000-000000000011",
		false,
	],
] as const)(
	"checks indexed output %s pinned to %s",
	async (id, revisionId, expected) => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(`
	CREATE TABLE workspace_output_index(output_id TEXT, organization_id TEXT, revision_id TEXT, status TEXT, is_current INTEGER);
	INSERT INTO workspace_output_index VALUES
	('00000000-0000-4000-8000-000000000001','org','00000000-0000-4000-8000-000000000007','active',0),
	('00000000-0000-4000-8000-000000000001','org','00000000-0000-4000-8000-000000000006','active',1),
	('00000000-0000-4000-8000-000000000002','org','00000000-0000-4000-8000-000000000008','archived',1),
	('00000000-0000-4000-8000-000000000003','org','00000000-0000-4000-8000-000000000009','active',0),
	('00000000-0000-4000-8000-000000000004','other','00000000-0000-4000-8000-000000000010','active',1);
	`);
		expect(
			await decisionSourcesCurrent(
				createDbQueryClient(createD1Facade(sqlite)),
				"org",
				{
					status: "open",
					kind: "question",
					targetType: "user",
					subject: "Review plan",
					prompt: "Is the plan ready?",
					metadata: { decisionSources: [{ kind: "output", id, revisionId }] },
				},
			),
		).toBe(expected);
		sqlite.close();
	},
);

it("batches changed Work citations without changing progress, review and tenant boundaries", async () => {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const orgId = "org";
	const workId = "00000000-0000-4000-8000-000000000001";
	sqlite
		.prepare(
			"INSERT INTO work_items(id,org_id,title,version,admission_spec_revision,created_at) VALUES (?,?,'Source',1,'revision','2026-01-01')",
		)
		.run(workId, orgId);
	const comment = sqlite.prepare(
		"INSERT INTO work_item_comments(id,org_id,work_item_id,author_type,author_id,body,metadata,created_at) VALUES (?,?,?,?,?,?,?,?)",
	);
	comment.run(
		"baseline",
		orgId,
		workId,
		"user",
		"reader",
		"Original",
		"{}",
		"2026-01-01",
	);
	comment.run(
		"facts-a",
		orgId,
		workId,
		"user",
		"reader",
		"Earlier facts",
		"{}",
		"2026-01-03",
	);
	comment.run(
		"facts-z",
		orgId,
		workId,
		"user",
		"reader",
		"Latest facts " + "🔍".repeat(600),
		"{}",
		"2026-01-03",
	);
	comment.run(
		"progress",
		orgId,
		workId,
		"external_agent",
		"agent",
		"Progress",
		'{"decisionImpact":"progress"}',
		"2026-01-04",
	);
	comment.run(
		"answer",
		orgId,
		workId,
		"user",
		"reader",
		"Answer record",
		'{"schema":"tedix.decision-answer.v1"}',
		"2026-01-05",
	);
	comment.run(
		"foreign",
		"other",
		workId,
		"user",
		"reader",
		"Private",
		"{}",
		"2026-01-06",
	);
	const statements: string[] = [];
	const db = createDbQueryClient(
		createD1Facade(sqlite, { onPrepare: (query) => statements.push(query) }),
	);
	const requests = Array.from({ length: 100 }, (_, index) => ({
		status: "open",
		targetType: "user",
		kind: "question",
		subject: "Review",
		prompt: "Ready?",
		createdAt:
			index % 4 === 0
				? undefined
				: index % 4 === 1
					? "2026-01-02"
					: "2026-01-03",
		creatorType: index % 2 ? "external_agent" : "user",
		creatorId: index % 2 ? "agent" : "reader",
		metadata: {
			decisionSources: [
				{
					kind: "work",
					id: workId,
					version: index === 99 ? 2 : 1,
					commentCount: index % 4 === 1 ? 1 : 3,
				},
			],
		},
	}));
	try {
		const expected = await Promise.all(
			requests.map((request) => decisionSourcesReview(db, orgId, request)),
		);
		statements.length = 0;
		const prefetch = await prefetchDecisionSources(db, orgId, requests);
		expect(
			await Promise.all(
				requests.map((request) =>
					decisionSourcesReview(db, orgId, request, { prefetch }),
				),
			),
		).toEqual(expected);
		expect(statements).toHaveLength(3);
		expect(expected[1]).toEqual({
			current: false,
			reviewable: {
				through: "2026-01-03",
				note: ("Latest facts " + "🔍".repeat(600)).slice(0, 600),
			},
		});
		expect(expected[3]).toEqual({ current: true });
		for (const reviewedThrough of ["2026-01-02", "2026-01-03", "2026-01-07"])
			expect(
				await decisionSourcesReview(db, orgId, requests[1]!, {
					prefetch,
					reviewedThrough,
				}),
			).toEqual(
				await decisionSourcesReview(db, orgId, requests[1]!, {
					reviewedThrough,
				}),
			);
	} finally {
		sqlite.close();
	}
});
