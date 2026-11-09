import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "./client";
import { createDbQueryClient } from "./query-client";
import {
	findOrphanRuns,
	listRecentKernelRunsForOrganization,
} from "./queries/cognitive-runtime";
import {
	claimAgentSessionEvent,
	listPendingAgentSessionEvents,
} from "./queries/agent-session-requests";
import { listOwnerLearningInteractionsPage } from "./queries/learning-feedback";
import { pendingFilingLessons } from "./queries/request-filings";
import { listRationaleRecords } from "./queries/rationale-records";
import { listWorkActivity } from "./queries/work-items/activity";
import { listWorkApprovalInbox } from "./queries/work-items/approvals";
import { listPersonalCardStyleRules } from "./queries/work-items/card-style-rules";
import { listWorkItemsPage } from "./queries/work-items/crud";
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
		lastPlan: (table?: string) =>
			queryPlan(
				sqlite,
				table
					? statements.findLast((statement) =>
							statement.includes(`"${table}"`),
						)!
					: statements.at(-1)!,
			),
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
	it("reads the rationale total by organization key without scanning rationale rows", async () => {
		const { db, lastPlan } = fixture();
		await listRationaleRecords(db, { orgId: "org-1" });
		expect(lastPlan("rationale_org_counts")).toContain(
			"SEARCH rationale_org_counts USING INDEX sqlite_autoindex_rationale_org_counts_1 (org_id=?)",
		);
	});

	it("counts a project's Work through a covering project-and-disposition index", async () => {
		const { query, lastPlan } = fixture();
		await listWorkItemsPage(query, {
			orgId: "org-1",
			projectId: "project-1",
			disposition: "accepted",
		});
		expect(lastPlan()).toContain(
			"SEARCH work_items USING COVERING INDEX idx_work_items_org_project_disposition (org_id=? AND project_id=? AND disposition=?)",
		);
	});

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

	it.each(["first", "cursor", "forward"])(
		"seeks the project Work feed's %s page without sorting or scanning",
		async (page) => {
			const { db, lastPlan } = fixture();
			await listWorkActivity(db, {
				orgId: "org-1",
				projectId: "project-1",
				limit: 50,
				...(page === "cursor"
					? { cursor: { at: "2026-11-09T18:00:00.000Z", id: "event-1" } }
					: page === "forward"
						? { afterSequence: 100 }
						: {}),
			});
			const plan = lastPlan();
			const index = page === "forward" ? "sequence" : "occurred";
			const range =
				page === "forward"
					? " AND sequence>?"
					: page === "cursor"
						? " AND (occurred_at,id)<(?,?)"
						: "";
			expect(plan).toContain(
				`SEARCH work_events USING INDEX idx_work_events_project_${index} (org_id=? AND project_id=?${range})`,
			);
			expect(plan).not.toMatch(/SCAN (?:work_events|work_items)/);
			expect(plan).not.toContain("TEMP B-TREE");
		},
	);

	it.each(["list", "claim"])(
		"%s checks earlier session events through the covering index",
		async (operation) => {
			const { query, lastPlan } = fixture();
			const params = {
				organizationId: "org-1",
				userId: "user-1",
				limit: 20,
				id: "event-1",
				now: "2026-11-09T18:00:00.000Z",
			};
			if (operation === "list")
				await listPendingAgentSessionEvents(query, params);
			else await claimAgentSessionEvent(query, params);
			const plan = lastPlan("agent_session_events");
			expect(plan).toContain(
				"SEARCH agent_session_events USING INTEGER PRIMARY KEY (rowid=?)",
			);
			expect(plan).toContain(
				"SEARCH earlier_session_event USING COVERING INDEX idx_agent_session_events_pending_heads (organization_id=? AND user_id=? AND status=? AND harness=? AND session_key=? AND source_at<?)",
			);
			if (operation === "list")
				expect(plan).toContain(
					"USING COVERING INDEX idx_agent_session_events_pending_heads (organization_id=? AND user_id=? AND status=? AND harness=? AND session_key>?)",
				);
			expect(plan).not.toMatch(
				/SCAN (?:agent_session_events|earlier_session_event)/,
			);
		},
	);
});
