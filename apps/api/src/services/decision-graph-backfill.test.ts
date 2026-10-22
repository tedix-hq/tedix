import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { organizations } from "@tedix/db/schema/organizations";
import { osOutputs } from "@tedix/db/schema/os-workspaces";
import { decisionEdges } from "@tedix/db/schema/decision-graph";
import {
	workItems,
	workItemComments,
	workItemRelations,
	workEvidence,
} from "@tedix/db/schema/work-items";
import {
	workInteractions,
	workInteractionResponses,
	workApprovalProposals,
	workApprovalDecisions,
} from "@tedix/db/schema/work-factory";
import { memoryFacts } from "@tedix/db/schema/memory-graph";
import { tediApprovalRequests } from "@tedix/db/schema/approvals";
import { tediRationaleRecords } from "@tedix/db/schema/rationale-records";
import { platformCronCheckpoints } from "@tedix/db/schema/platform-cron-executions";
import {
	runDecisionGraphBackfillPage,
	runScheduledDecisionGraphBackfill,
} from "./decision-graph-backfill";

const ORG = "fictional-harbor";
const TIME = "2026-06-01T10:00:00.000Z";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(
			organizations,
			osOutputs,
			decisionEdges,
			workItems,
			workItemComments,
			workItemRelations,
			workEvidence,
			workInteractions,
			workInteractionResponses,
			workApprovalProposals,
			workApprovalDecisions,
			memoryFacts,
			tediApprovalRequests,
			tediRationaleRecords,
			platformCronCheckpoints,
		),
	);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite
		.prepare("INSERT INTO organizations(id,name,slug) VALUES (?,?,?),(?,?,?)")
		.run(ORG, "Harbor", "harbor", "fictional-ridge", "Ridge", "ridge");
	const db = createDbQueryClient(createD1Facade(sqlite));
	const count = (table = "decision_edges") =>
		Number(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
	return { sqlite, db, count };
}
async function seed(f: ReturnType<typeof fixture>) {
	await f.db.insert(workItems).values({
		id: "work-a",
		orgId: ORG,
		title: "Fictional audit",
		createdAt: TIME,
		accountableOwnerType: "user",
		accountableOwnerId: "person-river",
	});
	await f.db.insert(workItems).values({
		id: "work-b",
		orgId: ORG,
		title: "Fictional release",
		createdAt: TIME,
	});
	await f.db.insert(workItems).values({
		id: "foreign-work",
		orgId: "fictional-ridge",
		title: "Other tenant",
		createdAt: TIME,
	});
	await f.db.insert(workInteractions).values({
		id: "card-a",
		orgId: ORG,
		workItemId: "work-a",
		kind: "question",
		status: "resolved",
		subject: "Audit",
		prompt: "Review",
		creatorType: "system",
		creatorId: "deck",
		targetType: "user",
		targetId: "person-river",
		createdAt: TIME,
		version: 2,
	});
	await f.db.insert(workInteractions).values({
		id: "card-c",
		orgId: ORG,
		projectId: "project-a",
		kind: "question",
		status: "cancelled",
		subject: "Older review",
		prompt: "Review",
		creatorType: "system",
		creatorId: "deck",
		createdAt: TIME,
		metadata: {
			curation: {
				successorId: "card-b",
				retirement: { reason: "duplicate" },
			},
		},
	});
	await f.db.insert(workInteractions).values({
		id: "card-b",
		orgId: ORG,
		workItemId: "work-a",
		kind: "question",
		subject: "Audit again",
		prompt: "Review",
		creatorType: "system",
		creatorId: "deck",
		createdAt: TIME,
	});
	await f.db.insert(workInteractionResponses).values({
		id: "answer-a",
		orgId: ORG,
		interactionId: "card-a",
		resolvedRequestVersion: 2,
		resolutionFence: "answer-fence",
		responderType: "user",
		responderId: "person-river",
		body: "Approved",
		responseKind: "answer",
		resolvesRequest: true,
		respondedAt: TIME,
	});
	await f.db.insert(workApprovalProposals).values({
		id: "proposal-a",
		orgId: ORG,
		workItemId: "work-a",
		workItemVersion: 1,
		authorityKey: "review",
		action: "review",
		proposal: {},
		requesterType: "system",
		requesterId: "reviewer",
		approverType: "user",
		approverId: "person-river",
		status: "approved",
		rationale: "Review",
		expiresAt: TIME,
		createdAt: TIME,
	});
	await f.db.insert(workApprovalDecisions).values({
		id: "approval-a",
		proposalId: "proposal-a",
		resolvedProposalVersion: 2,
		decision: "approved",
		deciderType: "user",
		deciderId: "person-river",
		rationale: "Approved",
		decidedAt: TIME,
	});
	await f.db.insert(workItemRelations).values({
		id: "relation-a",
		orgId: ORG,
		fromWorkItemId: "work-a",
		toWorkItemId: "work-b",
		relationType: "blocks",
		createdAt: TIME,
	});
	await f.db.insert(workItemComments).values({
		id: "comment-a",
		orgId: ORG,
		workItemId: "work-a",
		authorType: "user",
		authorId: "person-river",
		body: "Use the reviewed plan",
		createdAt: TIME,
	});
	await f.db.insert(memoryFacts).values({
		id: "instruction-a",
		organizationId: ORG,
		content: "Use the reviewed plan",
		factType: "feedback",
		status: "active",
		reviewStatus: "confirmed",
		usePolicy: "can_use_as_instruction",
		source: "work-comment://comment-a",
		createdAt: TIME,
	});
	await f.db.insert(memoryFacts).values({
		id: "unreviewed",
		organizationId: ORG,
		content: "Possible plan",
		factType: "feedback",
		reviewStatus: "pending",
		usePolicy: "requires_user_confirmation",
		metadata: { workItemId: "work-a" },
		createdAt: TIME,
	});
	await f.db.insert(memoryFacts).values({
		id: "foreign-link",
		organizationId: ORG,
		content: "Foreign plan",
		factType: "decision",
		reviewStatus: "confirmed",
		usePolicy: "can_use_as_instruction",
		metadata: { workItemId: "foreign-work" },
		createdAt: TIME,
	});
	await f.db.insert(workEvidence).values({
		id: "evidence-a",
		orgId: ORG,
		workItemId: "work-a",
		claimKey: "review",
		kind: "work",
		uri: "work://work-b",
		submittedByType: "system",
		submittedById: "reviewer",
		submittedAt: TIME,
	});
	await f.db.insert(osOutputs).values({
		id: "output-a",
		organizationId: ORG,
		kind: "document",
		title: "Audit evidence",
		createdByKind: "user",
		createdById: "person-river",
	});
	await f.db.insert(workEvidence).values({
		id: "evidence-output",
		orgId: ORG,
		workItemId: "work-a",
		claimKey: "report",
		kind: "document",
		uri: "output://output-a/revision-a",
		submittedByType: "system",
		submittedById: "reviewer",
		submittedAt: TIME,
	});
	await f.db.insert(tediApprovalRequests).values({
		id: "tedi-approval",
		tediId: "tedi-river",
		orgId: ORG,
		actionType: "custom",
		description: "Review",
		payload: { workItemId: "work-a" },
		status: "approved",
		createdAt: TIME,
		expiresAt: TIME,
		resolvedAt: TIME,
	});
	await f.db.insert(tediRationaleRecords).values({
		id: "decision-a",
		tediId: "tedi-river",
		orgId: ORG,
		action: "Review",
		rationale: "Reviewed plan",
		category: "decision",
		outcomeStatus: "success",
		workItemId: "work-a",
		createdAt: TIME,
	});
}

async function sweep(
	f: ReturnType<typeof fixture>,
	dryRun: boolean,
	limit = 50,
) {
	let cursor = null;
	const counts: Record<string, number> = {};
	let pages = 0;
	do {
		const page = await runDecisionGraphBackfillPage(f.db, ORG, {
			dryRun,
			cursor,
			limit,
		});
		expect(page.scanned).toBeLessThanOrEqual(limit);
		for (const [kind, n] of Object.entries(page.counts))
			counts[kind] = (counts[kind] ?? 0) + n;
		cursor = page.nextCursor;
		expect(++pages).toBeLessThan(100);
	} while (cursor);
	return counts;
}

describe("decision graph backfill", () => {
	it("does not restore answers or supersession metadata on reopened cards", async () => {
		const f = fixture();
		try {
			await seed(f);
			f.sqlite.exec(
				"UPDATE work_interactions SET status='open', version=version+1 WHERE id IN ('card-a','card-c')",
			);
			const counts = await sweep(f, true);
			expect(counts.card_answers).toBe(2);
			expect(counts.supersedes).toBe(0);
			expect(counts.same_as).toBe(0);
		} finally {
			f.sqlite.close();
		}
	});
	it("previews without writes, then idempotently replays typed historical edges with original times", async () => {
		const f = fixture();
		try {
			await seed(f);
			const preview = await sweep(f, true, 2);
			expect(f.count()).toBe(0);
			expect(f.count("platform_cron_checkpoints")).toBe(0);
			const written = await sweep(f, false, 2);
			expect(written).toEqual(preview);
			expect(preview).toEqual({
				card_from_work: 2,
				card_answers: 3,
				decided_by: 5,
				same_as: 1,
				supersedes: 1,
				blocks: 1,
				involves: 3,
				evidence: 2,
				about: 0,
				depends_on: 0,
			});
			const n = f.count();
			expect(n).toBe(17);
			await sweep(f, false, 2);
			expect(f.count()).toBe(n);
			expect(
				f.sqlite
					.prepare(
						"SELECT to_id AS id FROM decision_edges WHERE to_kind='output'",
					)
					.all(),
			).toEqual([{ id: "output-a" }]);
			expect(
				f.sqlite
					.prepare("SELECT DISTINCT occurred_at AS at FROM decision_edges")
					.all(),
			).toEqual([{ at: TIME }]);
			expect(
				f.sqlite
					.prepare(
						"SELECT to_id AS id FROM decision_edges WHERE to_kind='owner_instruction'",
					)
					.all(),
			).toEqual([{ id: "instruction-a" }]);
			expect(
				f.sqlite
					.prepare(
						"SELECT id FROM decision_edges WHERE org_id<>? OR to_id='foreign-work'",
					)
					.all(ORG),
			).toEqual([]);
		} finally {
			f.sqlite.close();
		}
	});
	it("resumes beyond 50 rows without gaps and rejects a cursor from another tenant", async () => {
		const f = fixture();
		try {
			for (let i = 0; i < 101; i++)
				await f.db.insert(workInteractions).values({
					id: `card-${String(i).padStart(3, "0")}`,
					orgId: ORG,
					projectId: "project-a",
					kind: "question",
					subject: "Review",
					prompt: "Review",
					creatorType: "system",
					creatorId: "deck",
					targetType: "user",
					targetId: "person-river",
					createdAt: TIME,
				});
			const first = await runDecisionGraphBackfillPage(f.db, ORG, {
				dryRun: true,
				limit: 50,
				cursor: null,
			});
			expect(first.scanned).toBe(50);
			expect(first.nextCursor?.afterId).toBe("card-049");
			await expect(
				runDecisionGraphBackfillPage(f.db, "fictional-ridge", {
					dryRun: true,
					limit: 50,
					cursor: first.nextCursor,
				}),
			).rejects.toThrow("organization");
			const counts = await sweep(f, false);
			expect(counts.involves).toBe(101);
			expect(f.count()).toBe(101);
		} finally {
			f.sqlite.close();
		}
	});
	it("checkpoints scheduled pages only after successful writes and eventually finishes every tenant", async () => {
		const f = fixture();
		try {
			await seed(f);
			f.sqlite.exec(
				"CREATE TRIGGER fail_edges BEFORE INSERT ON decision_edges BEGIN SELECT RAISE(ABORT, 'simulated outage'); END",
			);
			await expect(runScheduledDecisionGraphBackfill(f.db)).rejects.toThrow();
			expect(f.count("platform_cron_checkpoints")).toBe(0);
			f.sqlite.exec("DROP TRIGGER fail_edges");
			for (let i = 0; i < 30; i++)
				await runScheduledDecisionGraphBackfill(f.db);
			expect(f.count()).toBeGreaterThan(0);
			const n = f.count();
			for (let i = 0; i < 5; i++) await runScheduledDecisionGraphBackfill(f.db);
			expect(f.count()).toBe(n);
		} finally {
			f.sqlite.close();
		}
	});
});
