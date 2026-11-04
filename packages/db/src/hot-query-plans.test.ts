import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "./client";
import { createDbQueryClient } from "./query-client";
import {
	findOrphanRuns,
	listRecentKernelRunsForOrganization,
} from "./queries/cognitive-runtime";
import { listOwnerLearningInteractionsPage } from "./queries/learning-feedback";
import { pendingFilingLessons } from "./queries/request-filings";
import { listWorkApprovalInbox } from "./queries/work-items/approvals";
import { listPersonalCardStyleRules } from "./queries/work-items/card-style-rules";
import { createD1Facade } from "./test/d1-facade";
import { createMigratedSqlite } from "./test/migrated-sqlite";

/**
 * Query plans for the reads that overloaded production D1 on 23 Oct 2026
 * (`wrangler d1 insights`, 24 h): each one walked a whole tenant or seven
 * days of every event kind. Migration 20261023124403_d1_hot_query_indexes
 * adds the index each plan names here.
 */
function fixture() {
	const sqlite = createMigratedSqlite();
	const statements: string[] = [];
	const prepare = sqlite.prepare.bind(sqlite);
	sqlite.prepare = ((query: string) => {
		statements.push(query);
		return prepare(query);
	}) as typeof sqlite.prepare;
	const d1 = createD1Facade(sqlite);
	return {
		sqlite,
		db: createDbClient(d1),
		query: createDbQueryClient(d1),
		lastPlan: () => queryPlan(sqlite, statements.at(-1)!),
	};
}

function queryPlan(sqlite: DatabaseSync, statement: string): string {
	return (
		sqlite.prepare(`EXPLAIN QUERY PLAN ${statement}`).all() as Array<{
			detail: string;
		}>
	)
		.map((row) => row.detail)
		.join("\n");
}

describe("hot production query plans", () => {
	it("reads pending filing lessons through the surface-and-kind index", async () => {
		const { query, lastPlan } = fixture();
		await pendingFilingLessons(query, {
			organizationId: "org-1",
			userId: "user-1",
		});
		expect(lastPlan()).toContain(
			"USING INDEX idx_learning_event_surface_kind_occurred (organization_id=? AND surface=? AND event_kind=?)",
		);
	});

	it("pages an owner's learning events without rescanning the scope per row", async () => {
		const { db, lastPlan } = fixture();
		await listOwnerLearningInteractionsPage(db, {
			organizationId: "org-1",
			ownerUserId: "user-1",
			surfaces: ["deck", "home"],
			before: null,
			limit: 20,
		});
		const plan = lastPlan();
		expect(plan).toContain(
			"USING INDEX idx_learning_event_scope_occurred (organization_id=? AND scope_kind=? AND scope_id=?)",
		);
		expect(plan).toContain(
			"SEARCH correction USING INDEX idx_learning_event_corrections (organization_id=? AND scope_kind=? AND scope_id=? AND actor_id=?)",
		);
	});

	it("reads one Work Item's approval proposals through the item index", async () => {
		const { query, lastPlan } = fixture();
		await listWorkApprovalInbox(query, {
			orgId: "org-1",
			workItemId: "work-1",
			observedAt: "2026-10-23T12:00:00.000Z",
			limit: 100,
		});
		expect(lastPlan()).toContain(
			"USING INDEX idx_work_approval_item_created (org_id=? AND work_item_id=?)",
		);
	});

	it("reads personal card-style rules through the visibility-and-policy index", async () => {
		const { query, lastPlan } = fixture();
		await listPersonalCardStyleRules(query, "org-1", "user-1");
		expect(lastPlan()).toContain(
			"USING INDEX idx_memory_facts_visibility_policy_updated (organization_id=? AND visibility=? AND review_status=? AND use_policy=?)",
		);
	});

	it("lists a tenant's newest kernel runs from the updated-at index without a sort", async () => {
		const { db, lastPlan } = fixture();
		await listRecentKernelRunsForOrganization(db, {
			organizationId: "org-1",
			limit: 200,
		});
		const plan = lastPlan();
		expect(plan).toContain(
			"USING INDEX idx_kernel_runtime_runs_org_updated (organization_id=?)",
		);
		expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
	});

	it("seeks the orphan sweep's run.started window on the global kind index", async () => {
		const { db, lastPlan } = fixture();
		await findOrphanRuns(db, { now: new Date("2026-10-23T12:00:00.000Z") });
		expect(lastPlan()).toContain(
			"SEARCH tedi_runtime_events USING INDEX idx_tedi_runtime_events_global_kind_created (kind=? AND created_at>? AND created_at<?)",
		);
	});
});
