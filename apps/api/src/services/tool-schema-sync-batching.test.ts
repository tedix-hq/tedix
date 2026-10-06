/**
 * Batching safety for `runToolSchemaSync`.
 *
 * These cover the properties a batched sync depends on and that nothing else
 * asserts: batch composition is deterministic, tool ids are resolved across the
 * whole surface rather than per batch, re-processing a batch converges, and a
 * batch can never delete a row merely because that row belongs to another
 * batch.
 */

import type { DbClient } from "@tedix/db/client";
import type { AppTool } from "@tedix/db/schema";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import {
	splitIntoSyncBatches,
	TOOL_SCHEMA_SYNC_BATCH_SIZE,
} from "../workflows/tool-schema-sync-batching";
import {
	planToolSchemaSyncProjection,
	planToolSchemaSyncRows,
	runToolSchemaSync,
	WORK_HIERARCHY_KIND_OVERRIDES,
	WORK_HIERARCHY_TOOL_ID_OVERRIDES,
} from "./tool-schema-sync";

const TEDIX_ADMIN_APP_ID = "5eed0020-0000-4000-8000-000000000020";

function makeRpcTool(
	overrides: Partial<AppTool> & {
		toolId: string;
		endpoint: string;
	},
): AppTool {
	return {
		...overrides,
		id: overrides.id ?? `tool-${overrides.toolId}`,
		appId: overrides.appId ?? TEDIX_ADMIN_APP_ID,
		toolId: overrides.toolId,
		title: overrides.title ?? overrides.toolId,
		toolTypeId: "rpc",
		inputSchema:
			overrides.inputSchema ??
			({
				type: "object",
				properties: {},
				additionalProperties: false,
			} as AppTool["inputSchema"]),
		outputSchema: overrides.outputSchema ?? null,
		config: {
			transport: "rpc",
			endpoint: overrides.endpoint,
		},
	} as AppTool;
}

/**
 * Minimal store-backed double. Unlike the fake in `tool-schema-sync.test.ts`
 * this one resolves updates and deletes by row identity rather than by call
 * order, because these tests re-run the same sync and assert convergence.
 */
function makeDb(rows: AppTool[]) {
	const store = [...rows];
	const updates: Array<{ id: string; patch: Partial<AppTool> }> = [];
	const inserts: AppTool[] = [];
	const deletes: string[] = [];
	let deleteTarget: string | null = null;

	const db = {
		select: () => ({
			from: () => ({
				where: () => ({
					orderBy: async () => [...store],
				}),
			}),
		}),
		query: {
			apps: {
				findFirst: async () => ({ id: TEDIX_ADMIN_APP_ID, slug: "tedix" }),
			},
			appTools: {
				findFirst: async ({
					where,
				}: {
					where: { id?: string; appId?: string; toolId?: string };
				}) => {
					if (where.id) return store.find((row) => row.id === where.id);
					if (where.appId && where.toolId) {
						return store.find(
							(row) => row.appId === where.appId && row.toolId === where.toolId,
						);
					}
					return undefined;
				},
			},
		},
		insert: () => ({
			values: async (value: AppTool) => {
				inserts.push(value);
				store.push(value);
			},
		}),
		delete: () => ({
			where: async () => {
				if (!deleteTarget) return;
				const index = store.findIndex((row) => row.id === deleteTarget);
				if (index >= 0) {
					deletes.push(deleteTarget);
					store.splice(index, 1);
				}
				deleteTarget = null;
			},
		}),
		update: () => ({
			set: (patch: Partial<AppTool>) => ({
				where: async () => {
					const endpoint = (patch.config as Record<string, unknown> | undefined)
						?.endpoint;
					const index = store.findIndex((candidate) => {
						if (patch.id && candidate.id === patch.id) return true;
						const config = candidate.config as Record<string, unknown> | null;
						return endpoint !== undefined && config?.endpoint === endpoint;
					});
					if (index < 0) return;
					const row = store[index] as AppTool;
					updates.push({ id: row.id, patch });
					store[index] = { ...row, ...patch } as AppTool;
				},
			}),
		}),
	};

	/** `deleteTool` resolves by id; the double needs the id up front. */
	const markDelete = (id: string) => {
		deleteTarget = id;
	};

	return {
		db: db as unknown as DbClient,
		markDelete,
		store,
		updates,
		inserts,
		deletes,
	};
}

describe("projection plan determinism", () => {
	// Warm the expensive fixture once, outside any assertion body. `planToolSchemaSyncProjection` walks the router to build its plan.
	// Paying that inside whichever `it()` runs first puts it under vitest's 5s
	// default, so under CPU contention — a shared CI runner, or a busy laptop —
	// the test times out and reports as a failure of the assertion rather than
	// of the fixture.
	beforeAll(async () => {
		planToolSchemaSyncProjection({}, TEDIX_ADMIN_APP_ID);
	}, 120_000);

	it("returns byte-identical work lists on repeated planning", () => {
		const first = planToolSchemaSyncProjection({}, TEDIX_ADMIN_APP_ID);
		const second = planToolSchemaSyncProjection({}, TEDIX_ADMIN_APP_ID);
		expect(second.endpoints).toEqual(first.endpoints);
		expect(second.toolIds).toEqual(first.toolIds);
	});

	it("orders endpoints by codepoint so batch N is the same set on every run", () => {
		const { endpoints } = planToolSchemaSyncProjection({}, TEDIX_ADMIN_APP_ID);
		const sorted = [...endpoints].sort((left, right) =>
			left < right ? -1 : left > right ? 1 : 0,
		);
		expect(endpoints).toEqual(sorted);
		expect(new Set(endpoints).size).toBe(endpoints.length);
	});

	it("splits the plan into batches that cover the surface exactly once", () => {
		const { endpoints } = planToolSchemaSyncProjection({}, TEDIX_ADMIN_APP_ID);
		const batches = splitIntoSyncBatches(
			endpoints,
			TOOL_SCHEMA_SYNC_BATCH_SIZE,
		);
		expect(batches.flat()).toEqual(endpoints);
		expect(
			batches.every(
				(batch) =>
					batch.length > 0 && batch.length <= TOOL_SCHEMA_SYNC_BATCH_SIZE,
			),
		).toBe(true);
	});

	it("plans the same endpoint set the unscoped sync projects", async () => {
		const plan = planToolSchemaSyncProjection({}, TEDIX_ADMIN_APP_ID);
		const { db } = makeDb([]);
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: false,
		});
		expect(result.total).toBe(plan.endpoints.length);
		expect(result.items.map((item) => item.endpoint).sort()).toEqual(
			[...plan.endpoints].sort(),
		);
	});
});

describe("tenant projection", () => {
	it("does not require the platform admin app when the target app is explicit", async () => {
		// A fresh local database (run-local onboarding) has no `tedix` app.
		const { db } = makeDb([]);
		(
			db as unknown as {
				query: { apps: { findFirst: () => Promise<undefined> } };
			}
		).query.apps.findFirst = async () => undefined;
		const result = await runToolSchemaSync(db, {
			appId: "tenant-gateway-app",
			mode: "projection",
			router: "osWorkspaces",
			apply: false,
		});
		expect(result.total).toBeGreaterThan(0);
		expect(result.failed).toBe(0);
	});
});

describe("plan-wide tool id resolution", () => {
	it("projects the authorization ids used by the CLI with explicit confirmation", () => {
		const { toolIds } = planToolSchemaSyncProjection({}, TEDIX_ADMIN_APP_ID);
		expect(toolIds["workItems/authorizeOwnedChannel"]).toBe(
			"authorize_owned_channel",
		);
		expect(toolIds["workItems/revokeOwnedChannel"]).toBe(
			"revoke_owned_channel",
		);
		expect(
			WORK_HIERARCHY_KIND_OVERRIDES["workItems/authorizeOwnedChannel"],
		).toBe("destructive");
		expect(WORK_HIERARCHY_KIND_OVERRIDES["workItems/revokeOwnedChannel"]).toBe(
			"destructive",
		);
	});

	it("pins the work-factory projection to exact verb-first ids and mutation kinds", () => {
		const expected = {
			"workItems/createCase": ["create_work_case", "write"],
			"workItems/addCaseDependency": ["add_work_case_dependency", "write"],
			"projects/createMilestone": ["create_project_milestone", "write"],
			"projects/recordHealthJudgment": [
				"record_project_health_judgment",
				"write",
			],
			"workApprovals/propose": ["propose_work_approval", "write"],
			"workApprovals/decide": ["decide_work_approval", "write"],
			"workApprovals/listInbox": ["list_work_approvals", "read"],
			"workApprovals/listAudit": ["list_work_approval_audit", "read"],
			"workInteractions/respond": ["respond_work_interaction", "write"],
			"workInteractions/cancel": ["cancel_work_interaction", "destructive"],
			"workInteractions/listInbox": ["list_work_interactions", "read"],
			"workInteractions/listOutbox": ["list_work_interaction_outbox", "read"],
			"workInteractions/listAudit": ["list_work_interaction_audit", "read"],
			"workFleet/getControlTower": ["get_work_fleet_control_tower", "read"],
			"workScheduler/listReady": ["list_ready_work", "read"],
			"workScheduler/planClusters": ["plan_work_execution_clusters", "read"],
		} as const;
		for (const [endpoint, [toolId, kind]] of Object.entries(expected)) {
			expect(WORK_HIERARCHY_TOOL_ID_OVERRIDES[endpoint]).toBe(toolId);
			expect(WORK_HIERARCHY_KIND_OVERRIDES[endpoint]).toBe(kind);
			expect(toolId).toMatch(
				/^(create|add|record|propose|decide|respond|cancel|get|list|plan)_/,
			);
		}
	});

	it("assigns every endpoint on the whole surface a unique tool id", () => {
		const { endpoints, toolIds } = planToolSchemaSyncProjection(
			{},
			TEDIX_ADMIN_APP_ID,
		);
		const resolved = endpoints.map((endpoint) => toolIds[endpoint]);
		expect(resolved.every(Boolean)).toBe(true);
		expect(new Set(resolved).size).toBe(resolved.length);
	});

	it("disambiguates ids that only collide when the whole surface is visible", () => {
		// Multiple routers expose `getStatus`. Resolved across the full plan they
		// get distinct ids; resolved over one router's slice they all generate the
		// bare `get_status`, and `upsertTool` matches on (app_id, tool_id) — so a
		// per-batch id map would let each batch overwrite the previous batch's row.
		const plan = planToolSchemaSyncProjection({}, TEDIX_ADMIN_APP_ID);
		const colliding = plan.endpoints.filter((endpoint) =>
			endpoint.endsWith("/getStatus"),
		);
		expect(colliding.length).toBeGreaterThan(1);
		const globallyResolved = colliding.map(
			(endpoint) => plan.toolIds[endpoint],
		);
		expect(new Set(globallyResolved).size).toBe(colliding.length);

		const perRouter = colliding.map((endpoint) => {
			const router = endpoint.split("/")[0] as string;
			return planToolSchemaSyncProjection({ router }, TEDIX_ADMIN_APP_ID)
				.toolIds[endpoint];
		});
		expect(new Set(perRouter).size).toBe(1);
		expect(perRouter[0]).not.toBe(globallyResolved[0]);
	});

	it("keeps the per-batch slice identical to the plan-wide assignment", () => {
		const plan = planToolSchemaSyncProjection({}, TEDIX_ADMIN_APP_ID);
		const batches = splitIntoSyncBatches(
			plan.endpoints,
			TOOL_SCHEMA_SYNC_BATCH_SIZE,
		);
		const sliced = new Map<string, string>();
		for (const batch of batches) {
			for (const endpoint of batch) {
				const resolved = plan.toolIds[endpoint];
				expect(resolved).toBeDefined();
				sliced.set(endpoint, resolved as string);
			}
		}
		expect(new Set(sliced.values()).size).toBe(sliced.size);
		expect(Object.fromEntries(sliced)).toEqual(plan.toolIds);
	});
});

describe("batch isolation: a batch never deletes another batch's rows", () => {
	it("projection mode deletes nothing, even with rows for endpoints outside the batch", async () => {
		const plan = planToolSchemaSyncProjection({}, TEDIX_ADMIN_APP_ID);
		const batch = plan.endpoints.slice(0, 3);
		const outside = plan.endpoints.slice(3, 40);
		const { db, store, deletes } = makeDb([
			...batch.map((endpoint) =>
				makeRpcTool({
					toolId: plan.toolIds[endpoint] as string,
					endpoint,
				}),
			),
			...outside.map((endpoint) =>
				makeRpcTool({
					toolId: plan.toolIds[endpoint] as string,
					endpoint,
				}),
			),
			// A row with no contract at all: still not this batch's business.
			makeRpcTool({ toolId: "orphan_tool", endpoint: "ghostRouter/vanished" }),
		]);
		const before = store.length;

		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: batch,
			toolIdOverrides: Object.fromEntries(
				batch.map((endpoint) => [endpoint, plan.toolIds[endpoint] as string]),
			),
		});

		expect(result.deleted).toBe(0);
		expect(deletes).toEqual([]);
		expect(store).toHaveLength(before);
		expect(
			result.items.filter(
				(item) => item.status === "deleted" || item.status === "wouldDelete",
			),
		).toEqual([]);
		// And nothing outside the batch was even considered.
		expect(result.total).toBe(batch.length);
		expect(result.items.map((item) => item.endpoint).sort()).toEqual(
			[...batch].sort(),
		);
	});

	it("schema mode prunes only within its own batch, never across batches", async () => {
		const plan = planToolSchemaSyncProjection({}, TEDIX_ADMIN_APP_ID);
		const live = plan.endpoints[0] as string;
		const { db, markDelete, store, deletes } = makeDb([
			makeRpcTool({ toolId: "in_batch_live", endpoint: live }),
			makeRpcTool({ toolId: "in_batch_stale", endpoint: "ghostRouter/gone" }),
			makeRpcTool({
				toolId: "other_batch_stale",
				endpoint: "ghostRouter/alsoGone",
			}),
		]);
		markDelete("tool-in_batch_stale");

		const result = await runToolSchemaSync(db, {
			mode: "schema",
			apply: true,
			pruneStale: true,
			toolIds: ["in_batch_live", "in_batch_stale"],
		});

		expect(result.deleted).toBe(1);
		expect(deletes).toEqual(["tool-in_batch_stale"]);
		// The equally stale row that belongs to another batch survives: pruning is
		// row-local, never a diff of "everything this run did not visit".
		expect(store.map((row) => row.toolId)).toContain("other_batch_stale");
	});

	it("a full batched schema-mode pass still prunes every stale row", async () => {
		const plan = planToolSchemaSyncProjection({}, TEDIX_ADMIN_APP_ID);
		const live = plan.endpoints[0] as string;
		const rows = [
			makeRpcTool({ toolId: "a_live", endpoint: live }),
			makeRpcTool({ toolId: "b_stale", endpoint: "ghostRouter/gone" }),
			makeRpcTool({ toolId: "c_stale", endpoint: "ghostRouter/alsoGone" }),
		];
		const { db, markDelete, store, deletes } = makeDb(rows);
		const rowPlan = await planToolSchemaSyncRows(db, {});
		expect(rowPlan.toolIds).toEqual(["a_live", "b_stale", "c_stale"]);

		for (const batch of splitIntoSyncBatches(rowPlan.toolIds, 1)) {
			const target = store.find((row) => row.toolId === batch[0]);
			if (target) markDelete(target.id);
			await runToolSchemaSync(db, {
				mode: "schema",
				apply: true,
				pruneStale: true,
				toolIds: batch,
			});
		}

		expect(deletes.sort()).toEqual(["tool-b_stale", "tool-c_stale"]);
		expect(store.map((row) => row.toolId)).toEqual(["a_live"]);
	});
});

describe("batch idempotency", () => {
	it("re-processing an applied batch converges instead of writing again", async () => {
		const plan = planToolSchemaSyncProjection({}, TEDIX_ADMIN_APP_ID);
		const batch = plan.endpoints.slice(0, 6);
		const overrides = Object.fromEntries(
			batch.map((endpoint) => [endpoint, plan.toolIds[endpoint] as string]),
		);
		const { db, store, updates, inserts } = makeDb([]);

		const first = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: batch,
			toolIdOverrides: overrides,
		});
		expect(first.created).toBe(batch.length);
		expect(first.inSync).toBe(0);
		const rowsAfterFirst = store.length;
		const insertsAfterFirst = inserts.length;
		const updatesAfterFirst = updates.length;

		const second = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: batch,
			toolIdOverrides: overrides,
		});

		expect(second.inSync).toBe(batch.length);
		expect(second.created).toBe(0);
		expect(second.updated).toBe(0);
		expect(second.planned).toBe(0);
		expect(store).toHaveLength(rowsAfterFirst);
		expect(inserts).toHaveLength(insertsAfterFirst);
		expect(updates).toHaveLength(updatesAfterFirst);
	});

	it("running a batch that another batch already applied does not duplicate rows", async () => {
		const plan = planToolSchemaSyncProjection({}, TEDIX_ADMIN_APP_ID);
		const overlap = plan.endpoints.slice(0, 4);
		const overrides = Object.fromEntries(
			plan.endpoints
				.slice(0, 8)
				.map((endpoint) => [endpoint, plan.toolIds[endpoint] as string]),
		);
		const { db, store } = makeDb([]);

		await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: plan.endpoints.slice(0, 8),
			toolIdOverrides: overrides,
		});
		await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: overlap,
			toolIdOverrides: overrides,
		});

		expect(store).toHaveLength(8);
		expect(new Set(store.map((row) => row.toolId)).size).toBe(8);
	});
});

describe("shared write budget", () => {
	it("treats a spent budget as plan-nothing rather than unlimited", async () => {
		const plan = planToolSchemaSyncProjection({}, TEDIX_ADMIN_APP_ID);
		const batch = plan.endpoints.slice(0, 4);
		const { db, store } = makeDb([]);

		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: batch,
			limit: 0,
		});

		expect(result.planned).toBe(0);
		expect(result.created).toBe(0);
		expect(result.skipped).toBe(batch.length);
		expect(store).toHaveLength(0);
	});
});
