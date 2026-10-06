import "@orpc/openapi/extensions/route";
/**
 * Tedi Rationale Records Contract
 * oRPC contract for the tedi decision journal
 *
 * Used by: Tedix OS Activity timeline, tedi Workers (via service binding),
 * MCP tools (write_rationale, get_rationale_chain)
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import {
	RATIONALE_CATEGORIES,
	RATIONALE_OUTCOME_STATUSES,
	RATIONALE_TERMINAL_STATUSES,
} from "../constants/enums";
import { baseErrors } from "../errors";
import { PaginationMetaSchema, PaginationSchema } from "../schemas/common";
import {
	BlameChainEntrySchema,
	RationaleProofRefSchema,
	RationaleRecordSchema,
	RationaleToolCallRefsSchema,
} from "../schemas/rationale-records";

// =============================================================================
// CONTRACT
// =============================================================================

export const rationaleRecordsContract = oc
	.route({ tags: ["rationale-records"], prefix: "/rationale-records" })
	.errors(baseErrors)
	.router({
		/**
		 * Create a rationale record (internal — called by tedi via service binding)
		 * POST /rationale-records
		 */
		create: oc
			.route({
				method: "POST",
				path: "" as `/${string}`,
				summary: "Create rationale record",
				description:
					"Record a tedi decision with reasoning, confidence, and evidence references. " +
					"REQUIRES at least one execution link — runId, workItemId, or toolCallRefs — " +
					"so every decision episode is span-checkable against the runtime event ledger. " +
					"Unlinked writes are rejected with BAD_REQUEST.",
				tags: ["rationale-records", "internal"],
				successStatus: 201,
			})
			.input(
				z.object({
					tediId: z.uuid(),
					orgId: z.uuid(),
					idempotencyKey: z
						.string()
						.min(1)
						.max(256)
						.optional()
						.describe(
							"Stable semantic decision key; exact retries return the original record",
						),
					action: z.string().min(1).max(500),
					rationale: z.string().min(1).max(5000),
					category: z.enum(RATIONALE_CATEGORIES).default("custom"),
					confidence: z.number().min(0).max(1).default(0.5),
					evidence: z.record(z.string(), z.unknown()).default({}),
					approvalRequestId: z.uuid().optional(),
					objectiveId: z.uuid().optional(),
					runId: z
						.string()
						.min(1)
						.max(256)
						.optional()
						.describe(
							"Execution link: the runtime run this decision belongs to",
						),
					workItemId: z
						.uuid()
						.optional()
						.describe("Execution link: the Work Item this decision serves"),
					toolCallRefs: RationaleToolCallRefsSchema.optional().describe(
						"Execution link: tool-call identifiers/spans from the runtime event ledger",
					),
					outcomeStatus: z
						.enum(RATIONALE_TERMINAL_STATUSES)
						.optional()
						.describe(
							"If provided, auto-completes the record (write + close in one step)",
						),
					outcome: z
						.string()
						.max(5000)
						.optional()
						.describe(
							"Outcome description (used when outcomeStatus is provided)",
						),
					proofRef: RationaleProofRefSchema.optional().describe(
						"Span-checkable proof for a write+close `success` outcome. When omitted, the record's own execution link is used as the proof span.",
					),
				}),
			)
			.output(RationaleRecordSchema),

		/**
		 * List rationale records (user auth — Tedix OS Activity timeline)
		 * GET /rationale-records
		 */
		list: oc
			.route({
				method: "GET",
				path: "" as `/${string}`,
				summary: "List rationale records",
				description:
					"List rationale records for the current organization with optional filters. Powers Tedix OS Activity explainability.",
			})
			.input(
				z
					.object({
						tediId: z.uuid().optional(),
						category: z.enum(RATIONALE_CATEGORIES).optional(),
						outcomeStatus: z.enum(RATIONALE_OUTCOME_STATUSES).optional(),
					})
					.extend(PaginationSchema.shape)
					.optional(),
			)
			.output(
				z.object({
					data: z.array(RationaleRecordSchema),
					pagination: PaginationMetaSchema,
				}),
			),

		/**
		 * Get a single rationale record by ID
		 * GET /rationale-records/{id}
		 */
		getById: oc
			.route({
				method: "GET",
				path: "/{id}",
				summary: "Get rationale record",
			})
			.input(z.object({ id: z.uuid() }))
			.output(RationaleRecordSchema),

		/**
		 * Get the rationale chain — recent decisions for a tedi
		 * GET /rationale-records/chain/{tediId}
		 */
		chain: oc
			.route({
				method: "GET",
				path: "/chain/{tediId}",
				summary: "Get rationale chain",
				description:
					"Get the recent decision chain for a tedi, showing patterns and reasoning evolution.",
			})
			.input(
				z.object({
					tediId: z.uuid(),
					limit: z.number().min(1).max(100).default(20),
				}),
			)
			.output(
				z.object({
					data: z.array(RationaleRecordSchema),
				}),
			),

		/**
		 * Complete a rationale record with outcome
		 * POST /rationale-records/{id}/complete
		 */
		complete: oc
			.route({
				method: "POST",
				path: "/{id}/complete",
				summary: "Complete rationale record",
				description:
					"Record the outcome of an action. Called after execution completes. " +
					"A `success` claim REQUIRES a span-checkable proofRef (run, tool_call, artifact, or work_item); " +
					"a proof-less `success` is stored as `unverified`, never `success`. " +
					"On failure, optionally include a blameChain to trace which component was most responsible.",
				tags: ["rationale-records", "internal"],
			})
			.input(
				z.object({
					id: z.uuid(),
					outcome: z.string().min(1).max(5000),
					outcomeStatus: z.enum(RATIONALE_TERMINAL_STATUSES),
					proofRef: RationaleProofRefSchema.optional().describe(
						"Span-checkable proof for a `success` outcome claim. Required for `success` — without it the record completes as `unverified`.",
					),
					blameChain: z
						.array(BlameChainEntrySchema)
						.optional()
						.describe(
							"Symbolic blame attribution — which components contributed to the outcome (especially useful for failures)",
						),
				}),
			)
			.output(RationaleRecordSchema),

		/** Delete a rationale record */
		delete: oc
			.route({
				method: "DELETE",
				path: "/{id}",
				summary: "Delete rationale record",
				description:
					"Permanently delete a rationale record. Used for cleaning up test/demo data.",
				tags: ["rationale-records"],
			})
			.input(z.object({ id: z.uuid() }))
			.output(z.object({ success: z.boolean(), deletedId: z.string() })),
	});

export type RationaleRecordsContract = typeof rationaleRecordsContract;
