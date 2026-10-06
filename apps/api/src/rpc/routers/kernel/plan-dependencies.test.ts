import type { SelectedKernelModel } from "./llm";
import { DatabaseSync } from "node:sqlite";
import { createDbClient, type DbClient } from "@tedix/db/client";
import { createWorkItem } from "@tedix/db/queries/work-items/crud";
import { workItems } from "@tedix/db/schema/work-items";
import { eq } from "drizzle-orm";
import {
	addWorkItemRelation,
	findWorkItemsBlockedBy,
	queryWorkItemBlockers,
} from "@tedix/db/queries/work-items/relations";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vite-plus/test";
import {
	type PlanDependencyEdge,
	type PlanPlannerTarget,
	planTediAssignments,
} from "./plan-planner";

/**
 * STEP 3 end-to-end: REAL inferred dependencies (planTediAssignments over a mock
 * LLM) → work_item_relations (the documented approval-time mapping) → the Phase-1
 * blocker query/gate, all against a REAL in-memory SQLite via the production
 * createDbClient path (no fake D1). This is the seam the kernel-runtime fake-D1
 * harness cannot exercise (it does not model work_item_relations).
 *
 * Covers:
 *   (a) an inferred edge creates a `blocks` relation queryWorkItemBlockers reads
 *       as a real blocker, in the BLOCKER → DEPENDENT direction;
 *   (b) CYCLE SAFETY — an inferred 2-cycle is pruned to one edge so neither item
 *       deadlocks (the surviving blocker clears once it completes);
 *   (c) FAIL-SOFT — a failed/empty inference yields zero relations and every
 *       assignment is dispatchable (the gate defers nobody);
 *   (d) end to end with the blocker gate — a dependent whose blocker is non-terminal is
 *       DEFERRED by the gate, and completing the blocker surfaces it unblocked.
 */

const REAL_DDL = `
CREATE TABLE work_items (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	title TEXT NOT NULL,
	description TEXT,
	disposition TEXT NOT NULL DEFAULT 'proposed',
	work_kind TEXT NOT NULL DEFAULT 'other',
	risk_level TEXT NOT NULL DEFAULT 'medium',
	acceptance_contract TEXT,
	required_capabilities TEXT NOT NULL DEFAULT '[]',
	required_authorities TEXT NOT NULL DEFAULT '[]',
	admission_spec_revision TEXT NOT NULL DEFAULT 'initial',
	resource_scopes TEXT NOT NULL DEFAULT '[]',
	budget_limit_micros INTEGER,
	priority TEXT NOT NULL DEFAULT 'medium',
	accountable_owner_type TEXT,
	accountable_owner_id TEXT,
	steward_type TEXT,
	steward_id TEXT,
	reviewer_type TEXT,
	reviewer_id TEXT,
	reviewer_lease_expires_at TEXT,
	objective_id TEXT,
	work_class TEXT,
	purpose_exception_expires_at TEXT,
	project_id TEXT,
	parent_work_item_id TEXT,
	source_session_key TEXT,
	source_intent_id TEXT,
	due_date TEXT,
	deadline TEXT,
	start_at TEXT,
	duration_days INTEGER,
	provenance TEXT NOT NULL DEFAULT '{}',
	metadata TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL,
	updated_at TEXT,
	accepted_at TEXT,
	completed_at TEXT,
	cancelled_at TEXT,
	version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX uniq_work_items_org_source_intent
	ON work_items (org_id, source_intent_id);
CREATE TABLE work_item_relations (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	from_work_item_id TEXT NOT NULL,
	to_work_item_id TEXT NOT NULL,
	relation_type TEXT NOT NULL,
	metadata TEXT,
	created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uniq_work_item_relation
	ON work_item_relations (from_work_item_id, to_work_item_id, relation_type);
`;

function d1Facade(db: DatabaseSync): D1Database {
	const wrap = (sql: string) => {
		const stmt = db.prepare(sql);
		let bound: Array<null | number | bigint | string | Uint8Array> = [];
		const ps = {
			bind: (...vals: unknown[]) => {
				bound = vals as Array<null | number | bigint | string | Uint8Array>;
				return ps;
			},
			all: async () => ({
				results: stmt.all(...bound),
				success: true,
				meta: {},
			}),
			run: async () => {
				const r = stmt.run(...bound);
				return {
					success: true,
					meta: {
						changes: Number(r.changes),
						last_row_id: Number(r.lastInsertRowid),
						duration: 0,
					},
				};
			},
			first: async (col?: string) => {
				const row = stmt.get(...bound) as Record<string, unknown> | undefined;
				return col ? (row?.[col] ?? null) : (row ?? null);
			},
			raw: async () =>
				(stmt.all(...bound) as Array<Record<string, unknown>>).map((r) =>
					Object.values(r),
				),
		};
		return ps;
	};
	return {
		prepare: wrap,
		batch: async (stmts: Array<{ all: () => Promise<unknown> }>) =>
			Promise.all(stmts.map((s) => s.all())),
		exec: async (sql: string) => {
			db.exec(sql);
			return { count: 0, duration: 0 };
		},
		dump: async () => new ArrayBuffer(0),
	} as unknown as D1Database;
}

function realDb(): DbClient {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(REAL_DDL);
	return createDbClient(d1Facade(sqlite));
}

const ORG = "org-1";
const NOW = "2026-06-25T00:00:00.000Z";

const TARGETS: PlanPlannerTarget[] = [
	{ id: "tedi-cto", label: "CTO", slug: "cto" },
	{ id: "tedi-cpo", label: "CPO", slug: "cpo" },
];

function objectModel(object: unknown): SelectedKernelModel {
	return {
		model: new MockLanguageModelV3({
			doGenerate: async () => ({
				finishReason: "stop",
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				warnings: [],
				content: [{ type: "text", text: JSON.stringify(object) }],
			}),
		}),
		pricingIdentity: null,
		attempts: [],
		forOperation() {
			return { ...this, attempts: [] };
		},
	};
}

const throwingModel: SelectedKernelModel = {
	model: new MockLanguageModelV3({
		doGenerate: async () => {
			throw new Error("boom");
		},
	}),
	pricingIdentity: null,
	attempts: [],
	forOperation() {
		return { ...this, attempts: [] };
	},
};

/** Mirror of the kernel-runtime dispatch gate terminal predicate. */
function isTerminalBlockerStatus(status: string): boolean {
	return status === "completed" || status === "cancelled";
}

/** Phase-1 gate: a dispatch is DEFERRED when any blocker is still non-terminal. */
async function gateDefers(db: DbClient, workItemId: string): Promise<boolean> {
	const blockers = await queryWorkItemBlockers(db, workItemId);
	return blockers.some((b) => !isTerminalBlockerStatus(b.disposition));
}

/**
 * Create one Work Item per planned owner. ownerTediId → workItemId is 1:1 (each
 * owner maps to exactly one assignment), matching how approvePlanAssignments
 * mints a Work Item per selected assignment.
 */
async function seedOwnerWorkItems(
	db: DbClient,
	owners: Array<{ id: string; label: string; status: string }>,
): Promise<Map<string, string>> {
	const ownerWorkItemId = new Map<string, string>();
	for (const owner of owners) {
		const id = `wi-${owner.id}`;
		await createWorkItem(db, {
			id,
			orgId: ORG,
			title: owner.label,
			workClass: "maintenance",
			// Fixture-clock-relative (NOW+7d): validated against createdAt, never
			// the wall clock — see work-items-selection.test.ts T_BASE note.
			purposeExceptionExpiresAt: new Date(
				Date.parse(NOW) + 7 * 24 * 60 * 60 * 1000,
			).toISOString(),
			sourceIntentId: id,
			createdAt: NOW,
		});
		await db
			.update(workItems)
			.set({ disposition: owner.status === "done" ? "completed" : "accepted" })
			.where(eq(workItems.id, id));
		ownerWorkItemId.set(owner.id, id);
	}
	return ownerWorkItemId;
}

/**
 * The approval-time wiring documented on HomePlanSchema.dependencies
 * (packages/api-contract kernel-runtime schema): each inferred edge
 * {fromOwner=blocker → toOwner=dependent} maps DIRECTLY (no flip) to a
 * work_item_relations row {relationType:"blocks", fromWorkItemId=blocker,
 * toWorkItemId=dependent}, which queryWorkItemBlockers reads as "blocker blocks
 * dependent". Returns the number of relations written.
 */
async function wireInferredDependencies(
	db: DbClient,
	edges: PlanDependencyEdge[],
	ownerWorkItemId: Map<string, string>,
): Promise<number> {
	let created = 0;
	for (const [i, edge] of edges.entries()) {
		const from = ownerWorkItemId.get(edge.fromOwner);
		const to = ownerWorkItemId.get(edge.toOwner);
		if (!from || !to) continue;
		await addWorkItemRelation(db, {
			id: `rel-${i}`,
			orgId: ORG,
			fromWorkItemId: from,
			toWorkItemId: to,
			relationType: "blocks",
			createdAt: NOW,
		});
		created += 1;
	}
	return created;
}

describe("inferred plan dependencies → work_item_relations → Phase-1 gate", () => {
	it("(a) an inferred edge creates a blocks relation queryWorkItemBlockers reads as a real blocker", async () => {
		const db = realDb();
		const result = await planTediAssignments({
			content: "CTO provisions the database before CPO runs the migration",
			targets: TARGETS,
			model: objectModel({
				assignments: [
					{ ownerId: "tedi-cto", objective: "Provision the database." },
					{ ownerId: "tedi-cpo", objective: "Run the migration." },
				],
				dependencies: [
					{
						fromOwner: "tedi-cto",
						toOwner: "tedi-cpo",
						reason: "the database must exist before the migration runs",
					},
				],
			}),
		});
		expect(result.objectives).not.toBeNull();
		expect(result.dependencies).toHaveLength(1);

		const ownerWorkItemId = await seedOwnerWorkItems(db, [
			{ id: "tedi-cto", label: "CTO", status: "in_progress" },
			{ id: "tedi-cpo", label: "CPO", status: "accepted" },
		]);
		const created = await wireInferredDependencies(
			db,
			result.dependencies,
			ownerWorkItemId,
		);
		expect(created).toBe(1);

		// Direction: CTO (blocker) blocks CPO (dependent).
		const blockers = await queryWorkItemBlockers(db, "wi-tedi-cpo");
		expect(blockers.map((b) => b.id)).toEqual(["wi-tedi-cto"]);
		expect(blockers[0]!.disposition).toBe("accepted");
		// Inverse read: CTO's dependents include CPO.
		const dependents = await findWorkItemsBlockedBy(db, "wi-tedi-cto");
		expect(dependents.map((d) => d.id)).toEqual(["wi-tedi-cpo"]);
		// The blocker itself has no blocker.
		expect(await queryWorkItemBlockers(db, "wi-tedi-cto")).toEqual([]);
	});

	it("(b) CYCLE SAFETY: an inferred 2-cycle is broken so neither item deadlocks", async () => {
		const db = realDb();
		const result = await planTediAssignments({
			content: "x",
			targets: TARGETS,
			model: objectModel({
				assignments: [
					{ ownerId: "tedi-cto", objective: "A." },
					{ ownerId: "tedi-cpo", objective: "B." },
				],
				dependencies: [
					{ fromOwner: "tedi-cto", toOwner: "tedi-cpo", reason: "forward" },
					{ fromOwner: "tedi-cpo", toOwner: "tedi-cto", reason: "back edge" },
				],
			}),
		});
		// Pruned to a DAG: exactly one edge survives.
		expect(result.dependencies).toHaveLength(1);

		const ownerWorkItemId = await seedOwnerWorkItems(db, [
			{ id: "tedi-cto", label: "CTO", status: "in_progress" },
			{ id: "tedi-cpo", label: "CPO", status: "in_progress" },
		]);
		const created = await wireInferredDependencies(
			db,
			result.dependencies,
			ownerWorkItemId,
		);
		expect(created).toBe(1);

		const ctoBlockers = await queryWorkItemBlockers(db, "wi-tedi-cto");
		const cpoBlockers = await queryWorkItemBlockers(db, "wi-tedi-cpo");
		// At most ONE side has a blocker — no mutual block, so no deadlock.
		expect(ctoBlockers.length === 0 || cpoBlockers.length === 0).toBe(true);
		// The surviving edge keeps input order (forward cto→cpo): CTO runs, CPO waits.
		expect(ctoBlockers).toEqual([]);
		expect(cpoBlockers.map((b) => b.id)).toEqual(["wi-tedi-cto"]);

		// The unblocked side completing clears the other → progress is always possible.
		await db
			.update(workItems)
			.set({ disposition: "completed" })
			.where(eq(workItems.id, "wi-tedi-cto"));
		const cleared = (await queryWorkItemBlockers(db, "wi-tedi-cpo")).every(
			(b) => isTerminalBlockerStatus(b.disposition),
		);
		expect(cleared).toBe(true);
	});

	it("(c) FAIL-SOFT: a failed inference yields no relations and every assignment dispatches", async () => {
		const db = realDb();
		const result = await planTediAssignments({
			content: "x",
			targets: TARGETS,
			model: throwingModel,
		});
		expect(result.objectives).toBeNull();
		expect(result.dependencies).toEqual([]);

		const ownerWorkItemId = await seedOwnerWorkItems(db, [
			{ id: "tedi-cto", label: "CTO", status: "accepted" },
			{ id: "tedi-cpo", label: "CPO", status: "accepted" },
		]);
		const created = await wireInferredDependencies(
			db,
			result.dependencies,
			ownerWorkItemId,
		);
		expect(created).toBe(0);

		// No relations → no blockers → the gate defers nobody → both dispatch.
		expect(await gateDefers(db, "wi-tedi-cto")).toBe(false);
		expect(await gateDefers(db, "wi-tedi-cpo")).toBe(false);
	});

	it("(c) FAIL-SOFT: an empty inference (no edges) also leaves every assignment dispatchable", async () => {
		const db = realDb();
		const result = await planTediAssignments({
			content: "two unrelated asks",
			targets: TARGETS,
			model: objectModel({
				assignments: [
					{ ownerId: "tedi-cto", objective: "A." },
					{ ownerId: "tedi-cpo", objective: "B." },
				],
				dependencies: [],
			}),
		});
		expect(result.objectives).not.toBeNull();
		expect(result.dependencies).toEqual([]);

		const ownerWorkItemId = await seedOwnerWorkItems(db, [
			{ id: "tedi-cto", label: "CTO", status: "accepted" },
			{ id: "tedi-cpo", label: "CPO", status: "accepted" },
		]);
		expect(
			await wireInferredDependencies(db, result.dependencies, ownerWorkItemId),
		).toBe(0);
		expect(await gateDefers(db, "wi-tedi-cto")).toBe(false);
		expect(await gateDefers(db, "wi-tedi-cpo")).toBe(false);
	});

	it("(d) END-TO-END: a dependent is DEFERRED while its blocker is non-terminal, then surfaces unblocked", async () => {
		const db = realDb();
		const result = await planTediAssignments({
			content: "CTO provisions the database before CPO runs the migration",
			targets: TARGETS,
			model: objectModel({
				assignments: [
					{ ownerId: "tedi-cto", objective: "Provision the database." },
					{ ownerId: "tedi-cpo", objective: "Run the migration." },
				],
				dependencies: [
					{
						fromOwner: "tedi-cto",
						toOwner: "tedi-cpo",
						reason: "DB before migration",
					},
				],
			}),
		});
		const ownerWorkItemId = await seedOwnerWorkItems(db, [
			{ id: "tedi-cto", label: "CTO", status: "in_progress" },
			{ id: "tedi-cpo", label: "CPO", status: "accepted" },
		]);
		await wireInferredDependencies(db, result.dependencies, ownerWorkItemId);

		// Blocker (CTO) is in_progress → the dependent (CPO) is deferred by the gate,
		// while the blocker itself is dispatchable.
		expect(await gateDefers(db, "wi-tedi-cpo")).toBe(true);
		expect(await gateDefers(db, "wi-tedi-cto")).toBe(false);

		// Complete the blocker → the unblock watcher surfaces the dependent and the
		// gate now clears it for dispatch.
		await db
			.update(workItems)
			.set({ disposition: "completed" })
			.where(eq(workItems.id, "wi-tedi-cto"));
		const surfaced = await findWorkItemsBlockedBy(db, "wi-tedi-cto");
		expect(surfaced.map((d) => d.id)).toEqual(["wi-tedi-cpo"]);
		expect(await gateDefers(db, "wi-tedi-cpo")).toBe(false);
	});
});
