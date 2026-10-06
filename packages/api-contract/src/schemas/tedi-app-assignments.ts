/**
 * Tedi App Assignment Schemas
 * Zod schemas for tedi-app assignment API contracts
 */

import * as z from "zod";

// =============================================================================
// CORE SCHEMAS
// =============================================================================

export const TediAppAssignmentRoleSchema = z.enum(["operator", "observer"]);
export type TediAppAssignmentRole = z.infer<typeof TediAppAssignmentRoleSchema>;

export const TediAppAssignmentSchema = z.object({
	id: z.string(), // FGA synthetic ID: fga:{tediId}:{appId}
	organizationId: z.uuid(),
	appId: z.uuid(),
	tediId: z.uuid(),
	role: TediAppAssignmentRoleSchema,
	assignedBy: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export type TediAppAssignment = z.infer<typeof TediAppAssignmentSchema>;

export const ManagedTediAppAssignmentSchema = z.object({
	appId: z.uuid(),
	appSlug: z.string(),
	appName: z.string(),
	role: TediAppAssignmentRoleSchema,
	reason: z.string(),
});

export type ManagedTediAppAssignment = z.infer<
	typeof ManagedTediAppAssignmentSchema
>;

export const TediAppAssignmentManagedPreviewSchema = z.object({
	tediId: z.uuid(),
	current: z.array(TediAppAssignmentSchema),
	desired: z.array(ManagedTediAppAssignmentSchema),
	missing: z.array(ManagedTediAppAssignmentSchema),
	extra: z.array(TediAppAssignmentSchema),
	unchanged: z.array(ManagedTediAppAssignmentSchema),
});

export type TediAppAssignmentManagedPreview = z.infer<
	typeof TediAppAssignmentManagedPreviewSchema
>;

/**
 * Outcome of the Descope AIH client sync that accompanies an assignment write.
 *
 * `status` is a closed union rather than a boolean because the four outcomes
 * are operationally different and a boolean collapses them: `created` and
 * `updated` both rotate credentials and invalidate the MCP edge scope cache,
 * `deleted` tears the client down, and `skipped` means NO Descope client work
 * happened at all — either the app carries no `mcpConfig.descopeResourceId`,
 * or there was no matching client to delete. `reason` carries which.
 */
export const TediAppAssignmentAihClientSyncResultSchema = z.object({
	status: z.enum(["created", "updated", "deleted", "skipped"]),
	appId: z.uuid(),
	appSlug: z.string(),
	tediId: z.uuid(),
	mcpServerId: z.string().optional(),
	clientId: z.string().optional(),
	scopes: z.array(z.string()),
	secretNames: z
		.object({
			clientIdName: z.string(),
			clientSecretName: z.string(),
		})
		.optional(),
	reason: z.string().optional(),
});

export type TediAppAssignmentAihClientSyncResult = z.infer<
	typeof TediAppAssignmentAihClientSyncResultSchema
>;

export const TediAppAssignmentManagedReconcileResultSchema =
	TediAppAssignmentManagedPreviewSchema.extend({
		dryRun: z.boolean(),
		pruneExtra: z.boolean(),
		added: z.array(ManagedTediAppAssignmentSchema),
		removed: z.array(TediAppAssignmentSchema),
		/**
		 * Every AIH client sync/delete the reconcile actually attempted, in
		 * execution order (prune deletes first, then the desired-assignment
		 * syncs). Empty on `dryRun` — nothing was attempted. Required, because a
		 * reconcile that granted FGA but skipped every AIH client is NOT a clean
		 * success and the caller must be able to see that without reading logs.
		 */
		aihClientSyncs: z.array(TediAppAssignmentAihClientSyncResultSchema),
	});

export type TediAppAssignmentManagedReconcileResult = z.infer<
	typeof TediAppAssignmentManagedReconcileResultSchema
>;

/**
 * `create` / `updateRole` response: the assignment plus the AIH client sync
 * outcome for it.
 *
 * The FGA grant and the AIH client sync are two independent effects, and the
 * second legitimately no-ops for an app with no `mcpConfig.descopeResourceId`.
 * Returning the bare assignment reported that no-op as a clean success with
 * the real outcome only in a `console.log`, so `aihClientSync` is REQUIRED —
 * an optional field reproduces the defect by being silently absent.
 *
 * Required is safe against the split-deploy hazard that
 * `wire-backward-compatibility.test.ts` guards: `apps/api` is both the only
 * producer and the only runtime validator of this schema. `apps/mcp` proxies
 * these endpoints by URL without importing this schema, and OS uses
 * a type-only `RouterContractClient`, so no independently-deployed Worker ever
 * parses an older response against this shape.
 *
 * Deliberately a separate schema from `TediAppAssignmentSchema`: the list
 * endpoints and the `current`/`extra`/`removed` arrays read assignments they
 * did not just sync and cannot populate this field.
 */
export const TediAppAssignmentMutationResultSchema =
	TediAppAssignmentSchema.extend({
		aihClientSync: TediAppAssignmentAihClientSyncResultSchema,
	});

export type TediAppAssignmentMutationResult = z.infer<
	typeof TediAppAssignmentMutationResultSchema
>;

export const TediMcpAccessValidationSchema = z.object({
	status: z.enum(["valid", "invalid", "skipped"]),
	ok: z.boolean(),
	appId: z.uuid(),
	appSlug: z.string(),
	tediId: z.uuid(),
	role: TediAppAssignmentRoleSchema,
	mcpServerId: z.string().optional(),
	clientId: z.string().optional(),
	clientName: z.string(),
	expectedScopes: z.array(z.string()),
	clientScopes: z.array(z.string()),
	missingScopes: z.array(z.string()),
	extraScopes: z.array(z.string()),
	secrets: z.object({
		appClientId: z.boolean(),
		appClientSecret: z.boolean(),
		resourceClientId: z.boolean(),
		resourceClientSecret: z.boolean(),
	}),
	identity: z.object({
		source: z.literal("descope_management_api"),
		subjectId: z.string(),
		subjectIdMatches: z.boolean(),
		expectedLoginId: z.string(),
		loginIdPresent: z.boolean(),
		entityTypeMatches: z.boolean(),
		tediIdMatches: z.boolean(),
		verified: z.boolean(),
		checkedAt: z.string(),
	}),
	evidenceRefs: z.array(z.string()),
	reason: z.string().optional(),
});

export type TediMcpAccessValidation = z.infer<
	typeof TediMcpAccessValidationSchema
>;

export const TediMcpAccessBatchItemSchema = z.object({
	assignment: TediAppAssignmentSchema,
	validation: TediMcpAccessValidationSchema,
	repair: TediAppAssignmentAihClientSyncResultSchema.optional(),
	afterValidation: TediMcpAccessValidationSchema.optional(),
	error: z.string().optional(),
});

export type TediMcpAccessBatchItem = z.infer<
	typeof TediMcpAccessBatchItemSchema
>;

export const TediMcpAccessBatchResultSchema = z.object({
	repairInvalid: z.boolean(),
	dryRun: z.boolean(),
	filters: z.object({
		tediId: z.uuid().optional(),
		appId: z.uuid().optional(),
		appSlug: z.string().optional(),
	}),
	totalAssignments: z.number(),
	valid: z.number(),
	invalid: z.number(),
	skipped: z.number(),
	repaired: z.number(),
	failed: z.number(),
	items: z.array(TediMcpAccessBatchItemSchema),
});

export type TediMcpAccessBatchResult = z.infer<
	typeof TediMcpAccessBatchResultSchema
>;

export const TediMcpAccessHealthSchema = TediMcpAccessBatchResultSchema.extend({
	healthy: z.boolean(),
	checkedAt: z.string(),
});

export type TediMcpAccessHealth = z.infer<typeof TediMcpAccessHealthSchema>;

// =============================================================================
// FGA RELATION READS
// =============================================================================

/**
 * `relation` is a plain string here, NOT `TediAppAssignmentRoleSchema`.
 *
 * These endpoints are a raw read of the Descope authorization plane, and their
 * whole value is showing what is actually stored. The FGA schema can carry a
 * relation Tedix does not model (a future relation, or one left by a hand-edit
 * in the Descope console); parsing such a row against the closed
 * `operator | observer` enum would turn "there is a grant you do not
 * recognize" — precisely the finding worth surfacing — into a 500 that hides
 * it. `namespace` is carried for the same reason: it is `app` for everything
 * Tedix writes, and a row that says otherwise is a fact, not a parse error.
 */
export const AppFgaRelationSchema = z.object({
	namespace: z.string(),
	relation: z.string(),
	target: z
		.string()
		.nullable()
		.describe(
			"Raw Descope target (a user ID) holding the relation. Null ONLY for a target-SET relation, which Tedix never writes — so null is itself a finding, not a missing value. Always echoed, even when it resolves to no tedi: the app is org-owned, so this is the organization reading its own resource's ACL, and an unrecognized principal holding operator on your app is the finding this endpoint exists to expose.",
		),
	tediId: z
		.uuid()
		.nullable()
		.describe(
			"The tedi in the caller's organization this target resolves to. Null means the target is NOT one of your tedis — a human user, a stale grant, or a principal from elsewhere — which is authority you did not grant through this API, not an absent field.",
		),
	tediSlug: z
		.string()
		.nullable()
		.describe(
			"Slug of the resolved tedi. Null exactly when `tediId` is null, for the same reason.",
		),
	tediRetired: z
		.boolean()
		.nullable()
		.describe(
			"Whether the resolved tedi is retired; null when the target resolves to no tedi. A retired tedi still holding a relation is live authority nobody operates, so resolution deliberately includes retired tedis and flags them here rather than letting them collapse into `unresolvedTargetCount`.",
		),
});

export type AppFgaRelation = z.infer<typeof AppFgaRelationSchema>;

export const AppFgaRelationsSchema = z.object({
	appId: z.uuid(),
	appSlug: z.string(),
	checkedAt: z.string(),
	relations: z.array(AppFgaRelationSchema),
	/**
	 * Relations whose target is not a tedi of this organization (including
	 * retired ones) — a human user, a stale grant, or a principal from
	 * somewhere else. Reported as a count so a caller can alert on it without
	 * re-deriving it from `relations`.
	 */
	unresolvedTargetCount: z.number().int(),
});

export type AppFgaRelations = z.infer<typeof AppFgaRelationsSchema>;

export const TediFgaRelationSchema = z.object({
	namespace: z.string(),
	relation: z.string(),
	appId: z.uuid(),
	appSlug: z.string(),
});

export type TediFgaRelation = z.infer<typeof TediFgaRelationSchema>;

export const TediFgaRelationsSchema = z.object({
	tediId: z.uuid(),
	descopeUserId: z.string(),
	checkedAt: z.string(),
	/** Only relations on apps this organization owns. */
	relations: z.array(TediFgaRelationSchema),
	/**
	 * Relations this tedi holds on a resource that is NOT an app of the
	 * caller's organization, reported as a count and never by identifier.
	 *
	 * The asymmetry with `AppFgaRelationSchema.target` is deliberate and runs
	 * along the tenancy boundary: an organization may read the full ACL of a
	 * resource it owns, but the resource IDs on this side belong to other
	 * tenants, so echoing them would make an org-scoped read a cross-tenant
	 * identifier leak. A non-zero count is still the drift signal — one of your
	 * tedis holds authority outside your organization — and it is actionable
	 * through platform support without the identifier.
	 */
	unresolvedRelationCount: z.number().int(),
});

export type TediFgaRelations = z.infer<typeof TediFgaRelationsSchema>;

// =============================================================================
// INPUT SCHEMAS
// =============================================================================

export const CreateTediAppAssignmentInputSchema = z.object({
	appId: z.uuid("App ID must be a valid UUID"),
	tediId: z.uuid("Tedi ID must be a valid UUID"),
	role: TediAppAssignmentRoleSchema.optional().default("operator"),
});

export type CreateTediAppAssignmentInput = z.infer<
	typeof CreateTediAppAssignmentInputSchema
>;

export const UpdateTediAppAssignmentRoleInputSchema = z.object({
	role: TediAppAssignmentRoleSchema,
});

export type UpdateTediAppAssignmentRoleInput = z.infer<
	typeof UpdateTediAppAssignmentRoleInputSchema
>;

export const AssignmentIdParamSchema = z.object({
	assignmentId: z.string().min(1, "Assignment ID is required"), // FGA: fga:{tediId}:{appId}
});

export type AssignmentIdParam = z.infer<typeof AssignmentIdParamSchema>;

export const ListAssignmentsByAppInputSchema = z.object({
	appId: z.uuid("App ID must be a valid UUID"),
});

export const ListAssignmentsByTediInputSchema = z.object({
	tediId: z.uuid("Tedi ID must be a valid UUID"),
});

export const PreviewManagedAssignmentsByTediInputSchema = z.object({
	tediId: z.uuid("Tedi ID must be a valid UUID"),
});

export type PreviewManagedAssignmentsByTediInput = z.infer<
	typeof PreviewManagedAssignmentsByTediInputSchema
>;

export const ReconcileManagedAssignmentsByTediInputSchema = z.object({
	tediId: z.uuid("Tedi ID must be a valid UUID"),
	dryRun: z.boolean().optional().default(false),
	pruneExtra: z.boolean().optional().default(false),
});

export type ReconcileManagedAssignmentsByTediInput = z.infer<
	typeof ReconcileManagedAssignmentsByTediInputSchema
>;

export const ValidateTediMcpAccessInputSchema = z.object({
	tediId: z.uuid("Tedi ID must be a valid UUID"),
	appId: z.uuid("App ID must be a valid UUID").optional(),
	appSlug: z.string().min(1, "App slug is required").optional(),
});

export type ValidateTediMcpAccessInput = z.infer<
	typeof ValidateTediMcpAccessInputSchema
>;

export const ValidateTediMcpAccessBatchInputSchema = z.object({
	tediId: z.uuid("Tedi ID must be a valid UUID").optional(),
	appId: z.uuid("App ID must be a valid UUID").optional(),
	appSlug: z.string().min(1, "App slug is required").optional(),
	includeValid: z.boolean().optional().default(true),
	includeSkipped: z.boolean().optional().default(true),
	includeNonAih: z.boolean().optional().default(false),
});

export type ValidateTediMcpAccessBatchInput = z.infer<
	typeof ValidateTediMcpAccessBatchInputSchema
>;

export const RepairTediMcpAccessBatchInputSchema =
	ValidateTediMcpAccessBatchInputSchema.extend({
		dryRun: z.boolean().optional().default(false),
		includeValid: z.boolean().optional().default(false),
	});

export type RepairTediMcpAccessBatchInput = z.infer<
	typeof RepairTediMcpAccessBatchInputSchema
>;

export const RunTediMcpAccessHealthWorkflowInputSchema =
	RepairTediMcpAccessBatchInputSchema.extend({
		organizationIds: z.array(z.uuid()).optional(),
		limit: z.number().int().min(1).max(100).optional(),
		repairInvalid: z.boolean().optional().default(false),
	});

export type RunTediMcpAccessHealthWorkflowInput = z.infer<
	typeof RunTediMcpAccessHealthWorkflowInputSchema
>;

export const RunTediMcpAccessHealthWorkflowResultSchema = z.object({
	workflowId: z.string(),
	status: z.literal("queued"),
	repairInvalid: z.boolean(),
	dryRun: z.boolean(),
});

export type RunTediMcpAccessHealthWorkflowResult = z.infer<
	typeof RunTediMcpAccessHealthWorkflowResultSchema
>;
