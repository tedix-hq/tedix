/**
 * ToolSchemaSyncWorkflow
 *
 * Durable write path for regenerating app_tools input/output schemas from
 * source contracts. Intended to be triggered by Tedix admin MCP tools.
 *
 * Running the whole projection inside a single `step.do` walks every oRPC
 * contract in one allocation and exhausts the Worker memory limit for an
 * unscoped run. It runs as:
 *
 *   1. one cheap planning step that freezes the ordered work list (and, for a
 *      projection, the globally collision-resolved tool id map),
 *   2. one durable step per bounded batch, and
 *   3. a single subscriber notification + aggregate cache purge, reached only
 *      after every batch has succeeded.
 *
 * Resume: `step.do` results are engine-persisted under their step name, so a
 * failed batch is retried on its own and every completed batch replays from
 * cache instead of re-running. That covers the failure this workflow actually
 * hit (a mid-run memory kill and its retries) as well as a Durable Object reset
 * from a deploy landing mid-instance.
 */

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import type { ToolSchemaSyncInput } from "@tedix/api-contract/contracts/tool-schema-sync";
import { createDbClient } from "@tedix/db/client";
import {
	emptyBatchAggregate,
	mergeSyncBatchReport,
	remainingWriteBudget,
	splitIntoSyncBatches,
	syncBatchStepName,
	toBatchReport,
	TOOL_SCHEMA_SYNC_BATCH_SIZE,
	type ToolSchemaSyncBatchAggregate,
	type ToolSchemaSyncBatchReport,
} from "./tool-schema-sync-batching";

interface FrozenPlan {
	appId: string;
	/** Endpoint paths (projection) or stored tool ids (schema mode). */
	keys: string[];
	/** Projection only: endpointPath -> collision-resolved tool id. */
	toolIds?: Record<string, string>;
}

export class ToolSchemaSyncWorkflow extends WorkflowEntrypoint<
	CloudflareEnv,
	ToolSchemaSyncInput
> {
	async run(event: WorkflowEvent<ToolSchemaSyncInput>, step: WorkflowStep) {
		const db = createDbClient(this.env.DB);
		const payload: ToolSchemaSyncInput = {
			...event.payload,
			apply: event.payload.apply ?? true,
		};
		const mode = payload.mode ?? "schema";
		const source = payload.source ?? "rpc";
		const target = payload.target ?? "both";
		const apply = payload.apply ?? true;

		// Freezing the plan in a cached step is what makes the batch boundaries
		// deterministic for the life of the instance: a deploy that lands
		// mid-instance and adds a contract cannot shift which endpoints belong to
		// batch N, because every later batch slices this cached list.
		const planJson = await step.do(
			"plan tool schema sync",
			{ retries: { limit: 3, delay: "5 seconds" }, timeout: "2 minutes" },
			async () => {
				// The sync service intentionally walks every oRPC contract. Loading it
				// only for this workflow keeps that schema graph out of Worker startup.
				const {
					planToolSchemaSyncProjection,
					planToolSchemaSyncRows,
					resolveTedixAdminAppId,
				} = await import("../services/tool-schema-sync");
				if (mode === "projection") {
					const plan = planToolSchemaSyncProjection(
						payload,
						await resolveTedixAdminAppId(db),
					);
					return JSON.stringify({
						appId: plan.appId,
						keys: plan.endpoints,
						toolIds: plan.toolIds,
					} satisfies FrozenPlan);
				}
				const plan = await planToolSchemaSyncRows(db, payload);
				return JSON.stringify({
					appId: plan.appId,
					keys: plan.toolIds,
				} satisfies FrozenPlan);
			},
		);
		const plan = JSON.parse(planJson) as FrozenPlan;
		const batches = splitIntoSyncBatches(
			plan.keys,
			TOOL_SCHEMA_SYNC_BATCH_SIZE,
		);

		let aggregate: ToolSchemaSyncBatchAggregate = emptyBatchAggregate({
			appId: plan.appId,
			mode,
			source,
			target,
			apply,
			batchCount: batches.length,
			batchSize: TOOL_SCHEMA_SYNC_BATCH_SIZE,
		});

		for (let index = 0; index < batches.length; index++) {
			const batch = batches[index];
			if (!batch) continue;
			const limit = remainingWriteBudget(payload.limit, aggregate.planned);
			const reportJson = await step.do(
				syncBatchStepName(index, batch),
				{
					retries: {
						limit: 3,
						delay: "10 seconds",
						backoff: "exponential",
					},
					timeout: "5 minutes",
				},
				async () => {
					const { runToolSchemaSync } =
						await import("../services/tool-schema-sync");
					const options: ToolSchemaSyncInput =
						mode === "projection"
							? {
									...payload,
									appId: plan.appId,
									mode,
									endpoints: batch,
									// The frozen slice of the plan-wide id map. Never let a
									// batch re-resolve its own ids: collisions are only visible
									// across the whole surface, and `upsertTool` matches on
									// (app_id, tool_id), so two batches that independently
									// generated the same bare id would clobber each other's row
									// without tripping the residual-collision guard.
									toolIdOverrides: pickToolIds(plan.toolIds, batch),
									limit,
								}
							: {
									...payload,
									appId: plan.appId,
									mode,
									toolIds: batch,
									limit,
								};
					// Deliberately no `env`: the tools/list_changed broadcast fires once,
					// after every batch succeeds, not once per batch.
					const result = await runToolSchemaSync(db, options);
					return JSON.stringify(toBatchReport(result));
				},
			);
			aggregate = mergeSyncBatchReport(
				aggregate,
				JSON.parse(reportJson) as ToolSchemaSyncBatchReport,
			);
		}

		const changed = aggregate.created + aggregate.updated + aggregate.deleted;

		// Everything below is reachable only after every batch step returned, AND
		// only when every endpoint in every batch actually projected.
		//
		// A batch that THROWS errors the instance, so it never reaches here. But a
		// batch can also return `failed: N` without throwing — a per-endpoint
		// write failure is reported, not raised. Gating only on `changed > 0`
		// therefore announced and purged a surface that was known to be
		// incomplete: the gateway's aggregate cache would be replaced with a
		// half-projected copy, which is strictly worse than continuing to serve
		// the stale one. `stripUnknownTopLevelKeys` validates against that cached
		// schema, so a half-published projection makes the gateway reject its own
		// successful responses.
		//
		// The run still reports the failures; it just refuses to publish them.
		if (apply && changed > 0 && aggregate.failed === 0) {
			await step.do(
				"publish tool list changed",
				{ retries: { limit: 2, delay: "5 seconds" }, timeout: "30 seconds" },
				async () => {
					const { publishToolSchemaSyncEvents } =
						await import("../services/tool-schema-sync");
					await publishToolSchemaSyncEvents(this.env, {
						appId: aggregate.appId,
						mode: aggregate.mode,
						source: aggregate.source,
						target: aggregate.target,
						apply: aggregate.apply,
						total: aggregate.total,
						planned: aggregate.planned,
						created: aggregate.created,
						updated: aggregate.updated,
						deleted: aggregate.deleted,
						inSync: aggregate.inSync,
						skipped: aggregate.skipped,
						failed: aggregate.failed,
						items: aggregate.items,
					});
					return { published: true };
				},
			);

			// A synced schema is not live until the gateway's durable aggregate cache
			// stops serving the old copy — stripUnknownTopLevelKeys validates against
			// the cached schema, so without this purge a newly added input stays
			// silently stripped until the layers happen to turn over (can exceed an
			// hour). Best-effort: the deploy-rolled cache key is
			// the backstop, and a failed purge only means the old bounded TTLs apply.
			if (this.env.MCP_SERVICE) {
				await step.do(
					"purge aggregate tool cache",
					{ retries: { limit: 2, delay: "5 seconds" }, timeout: "30 seconds" },
					async () => {
						const response = await this.env.MCP_SERVICE.fetch(
							new Request("https://internal/__internal/purge-aggregate-cache", {
								method: "POST",
								headers: {
									"Content-Type": "application/json",
									"X-Service-Binding": "true",
								},
								body: JSON.stringify({ reason: "tool-schema-sync" }),
							}),
						);
						const body = (await response.json().catch(() => null)) as {
							ok?: boolean;
							r2Deleted?: number;
						} | null;
						return { status: response.status, ...body };
					},
				);
			}
		}

		return aggregate;
	}
}

function pickToolIds(
	toolIds: Record<string, string> | undefined,
	batch: string[],
): Record<string, string> | undefined {
	if (!toolIds) return undefined;
	const slice: Record<string, string> = {};
	for (const key of batch) {
		const resolved = toolIds[key];
		if (resolved) slice[key] = resolved;
	}
	return slice;
}
