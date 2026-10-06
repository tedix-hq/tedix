import "@orpc/openapi/extensions/route";
/**
 * Tedi App Assignments Contract
 * oRPC contract for managing tedi-to-app assignments
 *
 * Used by: apps/os (admin UI for linking tedis to apps)
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { SuccessResponseSchema } from "../schemas/common";
import {
	AppFgaRelationsSchema,
	AssignmentIdParamSchema,
	CreateTediAppAssignmentInputSchema,
	ListAssignmentsByAppInputSchema,
	ListAssignmentsByTediInputSchema,
	PreviewManagedAssignmentsByTediInputSchema,
	ReconcileManagedAssignmentsByTediInputSchema,
	RepairTediMcpAccessBatchInputSchema,
	RunTediMcpAccessHealthWorkflowInputSchema,
	RunTediMcpAccessHealthWorkflowResultSchema,
	TediAppAssignmentManagedPreviewSchema,
	TediAppAssignmentManagedReconcileResultSchema,
	TediAppAssignmentMutationResultSchema,
	TediAppAssignmentSchema,
	TediFgaRelationsSchema,
	TediMcpAccessBatchResultSchema,
	TediMcpAccessHealthSchema,
	TediMcpAccessValidationSchema,
	UpdateTediAppAssignmentRoleInputSchema,
	ValidateTediMcpAccessBatchInputSchema,
	ValidateTediMcpAccessInputSchema,
} from "../schemas/tedi-app-assignments";

export const tediAppAssignmentsContract = oc
	.route({ tags: ["tedi-app-assignments"], prefix: "/tedi-app-assignments" })
	.router({
		/**
		 * List all tedi assignments for an app
		 */
		listByApp: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/by-app/{appId}",
				summary: "List tedi assignments for an app",
				description:
					"List digital workers assigned to an organization-owned app.",
			})
			.input(ListAssignmentsByAppInputSchema)
			.output(z.object({ data: z.array(TediAppAssignmentSchema) })),

		/**
		 * List all app assignments for a tedi
		 */
		listByTedi: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/by-tedi/{tediId}",
				summary: "List app assignments for a tedi",
				description:
					"List app assignments for an organization-owned digital worker.",
			})
			.input(ListAssignmentsByTediInputSchema)
			.output(z.object({ data: z.array(TediAppAssignmentSchema) })),

		/**
		 * Read the raw FGA relations held on an app.
		 *
		 * `listByApp` above answers "which of my tedis are assigned?" — it
		 * batch-checks a candidate list and can only ever return principals it
		 * already knew about. This answers the different question "what does the
		 * authorization plane actually say about this app?", including grants
		 * held by principals no candidate list contains. It fails loudly rather
		 * than reporting an empty relation set when Descope cannot be queried.
		 */
		listFgaRelationsByApp: oc
			.route({
				method: "GET",
				path: "/fga-relations/by-app/{appId}",
				tags: ["internal"],
				summary: "List FGA relations held on an app",
			})
			.input(ListAssignmentsByAppInputSchema)
			.output(AppFgaRelationsSchema),

		/**
		 * Read the raw FGA relations a tedi holds.
		 */
		listFgaRelationsByTedi: oc
			.route({
				method: "GET",
				path: "/fga-relations/by-tedi/{tediId}",
				tags: ["internal"],
				summary: "List FGA relations held by a tedi",
			})
			.input(ListAssignmentsByTediInputSchema)
			.output(TediFgaRelationsSchema),

		/**
		 * Preview config-driven managed assignments for a tedi.
		 */
		previewManagedByTedi: oc
			.route({
				method: "GET",
				path: "/managed/by-tedi/{tediId}",
				tags: ["internal"],
				summary: "Preview managed app assignments for a tedi",
			})
			.input(PreviewManagedAssignmentsByTediInputSchema)
			.output(TediAppAssignmentManagedPreviewSchema),

		/**
		 * Materialize config-driven managed assignments into FGA.
		 */
		reconcileManagedByTedi: oc
			.route({
				method: "POST",
				path: "/managed/reconcile",
				tags: ["internal"],
				summary: "Reconcile managed app assignments for a tedi",
			})
			.input(ReconcileManagedAssignmentsByTediInputSchema)
			.output(TediAppAssignmentManagedReconcileResultSchema),

		/**
		 * Validate a tedi's MCP app access without repairing it.
		 */
		validateMcpAccess: oc
			.route({
				method: "POST",
				path: "/mcp-access/validate",
				tags: ["internal"],
				summary: "Validate a tedi's MCP app access without repair",
			})
			.input(ValidateTediMcpAccessInputSchema)
			.output(TediMcpAccessValidationSchema),

		/**
		 * Validate all matching tedi MCP app assignments without repairing them.
		 */
		validateMcpAccessBatch: oc
			.route({
				method: "POST",
				path: "/mcp-access/validate-batch",
				tags: ["internal"],
				summary: "Validate matching tedi MCP app assignments without repair",
			})
			.input(ValidateTediMcpAccessBatchInputSchema)
			.output(TediMcpAccessBatchResultSchema),

		/**
		 * Validate matching tedi MCP app assignments and repair invalid rows.
		 */
		repairMcpAccessBatch: oc
			.route({
				method: "POST",
				path: "/mcp-access/repair-batch",
				tags: ["internal"],
				summary: "Validate and repair invalid tedi MCP app assignments",
			})
			.input(RepairTediMcpAccessBatchInputSchema)
			.output(TediMcpAccessBatchResultSchema),

		/**
		 * Compact fleet health summary for tedi MCP app access.
		 */
		mcpAccessHealth: oc
			.route({
				method: "POST",
				path: "/mcp-access/health",
				tags: ["internal"],
				summary: "Get compact tedi MCP access health",
			})
			.input(ValidateTediMcpAccessBatchInputSchema)
			.output(TediMcpAccessHealthSchema),

		/**
		 * Start the durable MCP access-health workflow.
		 */
		runMcpAccessHealthWorkflow: oc
			.route({
				method: "POST",
				path: "/mcp-access/health/workflow",
				summary: "Run durable tedi MCP access health workflow",
			})
			.input(RunTediMcpAccessHealthWorkflowInputSchema)
			.output(RunTediMcpAccessHealthWorkflowResultSchema),

		/**
		 * Create a new tedi-app assignment
		 */
		create: oc
			.route({
				tags: ["REST"],
				method: "POST",
				path: "" as `/${string}`,
				summary: "Assign a tedi to an app",
				description:
					"Assign an organization-owned digital worker to an organization-owned app. The response carries `aihClientSync`: the FGA grant always succeeds, but the Descope AIH client sync can be `skipped` when the app has no MCP resource, and the caller must read that field rather than assume MCP access now works.",
				successStatus: 201,
			})
			.input(CreateTediAppAssignmentInputSchema)
			.output(TediAppAssignmentMutationResultSchema),

		/**
		 * Delete an assignment
		 */
		delete: oc
			.route({
				tags: ["REST"],
				method: "DELETE",
				path: "/{assignmentId}",
				summary: "Remove a tedi-app assignment",
				description:
					"Remove an app assignment inside the caller's organization.",
			})
			.input(AssignmentIdParamSchema)
			.output(SuccessResponseSchema),

		/**
		 * Update the role of an assignment
		 */
		updateRole: oc
			.route({
				tags: ["REST"],
				method: "PATCH",
				path: "/{assignmentId}",
				summary: "Update assignment role",
				description:
					"Update the role of a tedi-app assignment inside the caller's organization. The response carries `aihClientSync`: re-scoping the Descope AIH client can be `skipped` when the app has no MCP resource, so the caller must read that field rather than assume the new role's scopes took effect.",
			})
			.input(
				AssignmentIdParamSchema.extend(
					UpdateTediAppAssignmentRoleInputSchema.shape,
				),
			)
			.output(TediAppAssignmentMutationResultSchema),
	});

export type TediAppAssignmentsContract = typeof tediAppAssignmentsContract;
