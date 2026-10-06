import "@orpc/openapi/extensions/route";
/**
 * Tedi Growth Snapshots Contract
 * oRPC contract for weekly cognitive metric snapshots
 *
 * Used by: OS Growth Timeline trend chart, tedi Workers (via service binding),
 * MCP tools (cron-driven snapshot creation)
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import { PaginationMetaSchema, PaginationSchema } from "../schemas/common";

// =============================================================================
// SCHEMAS
// =============================================================================

export const GrowthSnapshotMetricsSchema = z.object({
	facts: z.number(),
	avgConfidence: z.number(),
	skills: z.number(),
	avgRevision: z.number(),
	muscles: z.number(),
	avgUsage: z.number(),
	domains: z.number(),
	autonomyRate: z.number(),
	expertiseLevels: z.record(z.string(), z.string()),
});
export type GrowthSnapshotMetrics = z.infer<typeof GrowthSnapshotMetricsSchema>;

export const GrowthSnapshotSchema = z.object({
	id: z.string(),
	tediId: z.string(),
	orgId: z.string(),
	snapshotDate: z.string(), // YYYY-MM-DD
	metrics: GrowthSnapshotMetricsSchema,
	createdAt: z.string().nullable(),
});
export type GrowthSnapshot = z.infer<typeof GrowthSnapshotSchema>;

// =============================================================================
// CONTRACT
// =============================================================================

export const growthSnapshotsContract = oc
	.route({ tags: ["growth"], prefix: "/growth-snapshots" })
	.errors(baseErrors)
	.router({
		/**
		 * List growth snapshots for a tedi
		 * GET /growth-snapshots
		 */
		list: oc
			.route({
				method: "GET",
				path: "" as `/${string}`,
				summary: "List growth snapshots",
				description:
					"List cognitive metric snapshots for a tedi, ordered by date descending. Powers the Growth Timeline trend chart.",
				tags: ["growth"],
			})
			.input(
				z
					.object({
						tediId: z.uuid(),
					})
					.extend(PaginationSchema.shape),
			)
			.output(
				z.object({
					data: z.array(GrowthSnapshotSchema),
					pagination: PaginationMetaSchema,
				}),
			),

		/**
		 * Get the most recent growth snapshot for a tedi
		 * GET /growth-snapshots/latest
		 */
		latest: oc
			.route({
				method: "GET",
				path: "/latest",
				summary: "Get latest growth snapshot",
				description:
					"Get the most recent cognitive metric snapshot for a tedi. Used for headline deltas.",
				tags: ["growth"],
			})
			.input(z.object({ tediId: z.uuid() }))
			.output(GrowthSnapshotSchema.nullable()),

		/**
		 * Create a growth snapshot (internal — called by cron/service binding)
		 * POST /growth-snapshots
		 */
		create: oc
			.route({
				method: "POST",
				path: "" as `/${string}`,
				summary: "Create growth snapshot",
				description:
					"Record a cognitive metric snapshot for a tedi. Upserts on (tediId, snapshotDate).",
				tags: ["growth", "internal"],
				successStatus: 201,
			})
			.input(
				z.object({
					tediId: z.uuid(),
					orgId: z.uuid(),
					snapshotDate: z.string(),
					metrics: GrowthSnapshotMetricsSchema,
				}),
			)
			.output(GrowthSnapshotSchema),
	});

export type GrowthSnapshotsContract = typeof growthSnapshotsContract;
