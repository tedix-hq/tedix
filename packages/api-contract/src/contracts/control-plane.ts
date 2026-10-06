import "@orpc/openapi/extensions/route";
/**
 * Control Plane Contract
 * oRPC contract for runtime profiles, policy packs, and workspace template sets
 *
 * Used by: apps/os (unified control plane), tedi Workers
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { TediCronSyncResponseSchema } from "../schemas/tedi";
import { baseErrors } from "../errors";
import {
	ControlPlaneDiffEntrySchema,
	ControlPlaneScopeSchema,
	ControlPlaneStatusSchema,
	DescopeRbacDriftSchema,
	EffectiveAppConfigSchema,
	PolicyPackSchema,
	PolicyPackTargetSchema,
	RuntimeProfileSchema,
	TediControlPlaneBindingHistorySchema,
	WorkspaceTemplateSetSchema,
} from "../schemas/control-plane";

export const PlatformCronFreshnessStateSchema = z.enum([
	"healthy",
	"running",
	"failed",
	"stale",
	"missing",
	"disabled",
]);

export const PlatformCronHealthSchema = z.object({
	id: z.string(),
	cron: z.string(),
	enabled: z.boolean(),
	optOutReason: z.string().nullable(),
	state: PlatformCronFreshnessStateSchema,
	attention: z.boolean(),
	nextExpectedAt: z.string().nullable(),
	freshnessGraceMinutes: z.number(),
	latest: z
		.object({
			id: z.string(),
			status: z.enum(["running", "success", "failure"]),
			scheduledAt: z.string(),
			startedAt: z.string(),
			finishedAt: z.string().nullable(),
			durationMs: z.number().nullable(),
			affectedRowCounts: z.record(z.string(), z.number()),
			error: z.string().nullable(),
		})
		.nullable(),
	lastSuccessAt: z.string().nullable(),
	lastFailureAt: z.string().nullable(),
	evidenceUrl: z.url(),
});

export const PlatformCronHealthResponseSchema = z.object({
	generatedAt: z.string(),
	attentionCount: z.number(),
	schedules: z.array(PlatformCronHealthSchema),
});

export type {
	ControlPlaneDiffEntry,
	ControlPlaneScope,
	ControlPlaneStatus,
	EffectiveAppConfig,
	EvolutionStrategy,
	PolicyPack,
	PolicyPackTarget,
	RuntimeProfile,
	TediControlPlaneBindingHistory,
	WorkspaceTemplateSet,
} from "../schemas/control-plane";
export {
	ControlPlaneDiffEntrySchema,
	ControlPlaneScopeSchema,
	ControlPlaneStatusSchema,
	EffectiveAppConfigSchema,
	EvolutionStrategySchema,
	PolicyPackSchema,
	PolicyPackTargetSchema,
	RuntimeProfileSchema,
	TediControlPlaneBindingHistorySchema,
	WorkspaceTemplateSetSchema,
} from "../schemas/control-plane";

const RevisionPublicationMetadataSchema = z.object({
	expectedVersion: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			"Expected current family-head version for compare-and-swap publication.",
		),
	changeSummary: z
		.string()
		.min(1)
		.max(500)
		.optional()
		.describe("Human-readable reason retained with the immutable revision."),
});

const RevisionDiffOutputSchema = z.object({
	fromRevisionId: z.string(),
	toRevisionId: z.string(),
	changes: z.array(ControlPlaneDiffEntrySchema),
});

const RevisionRollbackInputSchema = RevisionPublicationMetadataSchema.extend({
	id: z.string().describe("Current immutable revision id bound to the tedi."),
	targetRevisionId: z
		.string()
		.describe(
			"Older immutable revision whose content should be restored as a new head revision.",
		),
	tediId: z
		.string()
		.describe(
			"Single tedi whose fixed pin should move to the new rollback revision.",
		),
});

// =============================================================================
// CONTRACT
// =============================================================================

export const controlPlaneContract = oc
	.route({ tags: ["control-plane"], prefix: "/control-plane" })
	.errors(baseErrors)
	.router({
		listPlatformCronHealth: oc
			.route({
				method: "GET",
				path: "/platform-crons/health",
				summary: "List current platform cron health",
				description:
					"Current freshness and latest durable evidence for API Worker maintenance schedules. Historical failures remain visible but do not create attention after a healthy fire.",
			})
			.output(PlatformCronHealthResponseSchema),

		getDescopeRbacDrift: oc
			.route({
				method: "GET",
				path: "/descope-rbac/drift",
				summary: "Report drift between Descope RBAC and the canonical model",
				description:
					"Compares the LIVE Descope role and permission state against the canonical model in @tedix/auth/rbac and reports what differs. Read-only: it never provisions. Descope mints the role and permission claims the API authorizes against, so silent divergence here is invisible until a guard denies someone.",
			})
			.output(DescopeRbacDriftSchema),

		// =====================================================================
		// RUNTIME PROFILES
		// =====================================================================

		listRuntimeProfiles: oc
			.route({
				method: "GET",
				path: "/runtime-profiles",
				summary: "List runtime profiles",
				description:
					"List runtime profiles for the current organization, optionally including system-level profiles.",
			})
			.input(
				z.object({
					organizationId: z.string().optional(),
					includeSystem: z.boolean().optional(),
				}),
			)
			.output(z.object({ data: z.array(RuntimeProfileSchema) })),

		getRuntimeProfile: oc
			.route({
				method: "GET",
				path: "/runtime-profiles/{id}",
				summary: "Get runtime profile",
			})
			.input(z.object({ id: z.string() }))
			.output(RuntimeProfileSchema),

		createRuntimeProfile: oc
			.route({
				method: "POST",
				path: "/runtime-profiles",
				summary: "Create runtime profile",
				successStatus: 201,
			})
			.input(
				z.object({
					name: z.string().min(1),
					slug: z.string().min(1),
					description: z.string().optional(),
					scope: ControlPlaneScopeSchema.optional(),
					config: z.record(z.string(), z.unknown()),
					organizationId: z.string().optional(),
				}),
			)
			.output(RuntimeProfileSchema),

		listRuntimeProfileRevisions: oc
			.route({
				method: "GET",
				path: "/runtime-profiles/{id}/revisions",
				summary: "List immutable runtime profile revisions",
			})
			.input(z.object({ id: z.string() }))
			.output(z.object({ data: z.array(RuntimeProfileSchema) })),

		publishRuntimeProfileRevision: oc
			.route({
				method: "POST",
				path: "/runtime-profiles/{id}/revisions",
				summary: "Publish a new immutable runtime profile revision",
				successStatus: 201,
			})
			.input(
				RevisionPublicationMetadataSchema.extend({
					id: z.string(),
					name: z
						.string()
						.min(1)
						.optional()
						.describe("Replacement name; omitted to inherit the current head."),
					description: z
						.string()
						.nullable()
						.optional()
						.describe(
							"Replacement description; omitted to inherit and null to clear.",
						),
					config: z
						.record(z.string(), z.unknown())
						.optional()
						.describe(
							"Replacement runtime config; omitted to inherit the current head.",
						),
					status: ControlPlaneStatusSchema.optional().describe(
						"Replacement lifecycle status; omitted to inherit the current head.",
					),
				}),
			)
			.output(RuntimeProfileSchema),

		diffRuntimeProfileRevisions: oc
			.route({
				method: "GET",
				path: "/runtime-profiles/{id}/diff/{otherId}",
				summary: "Diff two runtime profile revisions",
			})
			.input(z.object({ id: z.string(), otherId: z.string() }))
			.output(RevisionDiffOutputSchema),

		rollbackRuntimeProfileRevision: oc
			.route({
				method: "POST",
				path: "/runtime-profiles/{id}/rollback",
				summary:
					"Restore an older runtime profile revision and rebind one tedi",
			})
			.input(RevisionRollbackInputSchema)
			.output(RuntimeProfileSchema),

		deleteRuntimeProfile: oc
			.route({
				method: "DELETE",
				path: "/runtime-profiles/{id}",
				summary: "Delete runtime profile",
			})
			.input(z.object({ id: z.string() }))
			.output(z.object({ success: z.literal(true) })),

		// =====================================================================
		// POLICY PACKS
		// =====================================================================

		listPolicyPacks: oc
			.route({
				method: "GET",
				path: "/policy-packs",
				summary: "List policy packs",
				description:
					"List policy packs for the current organization, optionally filtering by target and including system-level packs.",
			})
			.input(
				z.object({
					organizationId: z.string().optional(),
					includeSystem: z.boolean().optional(),
					target: PolicyPackTargetSchema.optional(),
				}),
			)
			.output(z.object({ data: z.array(PolicyPackSchema) })),

		getPolicyPack: oc
			.route({
				method: "GET",
				path: "/policy-packs/{id}",
				summary: "Get policy pack",
			})
			.input(z.object({ id: z.string() }))
			.output(PolicyPackSchema),

		createPolicyPack: oc
			.route({
				method: "POST",
				path: "/policy-packs",
				summary: "Create policy pack",
				successStatus: 201,
			})
			.input(
				z.object({
					name: z.string().min(1),
					slug: z.string().min(1),
					description: z.string().optional(),
					scope: ControlPlaneScopeSchema.optional(),
					target: PolicyPackTargetSchema.optional(),
					definition: z.record(z.string(), z.unknown()),
					organizationId: z.string().optional(),
				}),
			)
			.output(PolicyPackSchema),

		activatePolicyPackRevision: oc
			.route({
				method: "POST",
				path: "/policy-packs/{id}/activate",
				summary: "Activate an existing policy revision for one tedi",
			})
			.input(
				z
					.object({
						id: z.uuid(),
						organizationId: z.uuid(),
						tediId: z.uuid(),
						expectedRevisionId: z
							.uuid()
							.nullable()
							.describe(
								"Expected current policy pin for the audited compare-and-swap; null requires an unbound tedi. An already-applied target resumes reconciliation.",
							),
						changeReason: z.string().min(1).max(500),
					})
					.strict(),
			)
			.output(
				z.object({
					bindingApplied: z.literal(true),
					revisionId: z.uuid(),
					currentRevisionId: z
						.string()
						.nullable()
						.describe(
							"Policy pin observed after reconciliation; null means no pin was observed or readback failed. Check reconciled and error before treating activation as verified.",
						),
					configInvalidated: z.boolean(),
					reconciled: z.boolean(),
					cronSync: TediCronSyncResponseSchema.nullable().describe(
						"Runtime cron reconciliation receipt; null when the runtime call could not return a receipt. A durable binding may still have been applied.",
					),
					error: z
						.string()
						.nullable()
						.describe(
							"Sanitized reconciliation or readback failure after binding application; null only when the requested pin and runtime reconciliation were verified.",
						),
				}),
			),

		listPolicyPackRevisions: oc
			.route({
				method: "GET",
				path: "/policy-packs/{id}/revisions",
				summary: "List immutable policy pack revisions",
			})
			.input(z.object({ id: z.string() }))
			.output(z.object({ data: z.array(PolicyPackSchema) })),

		publishPolicyPackRevision: oc
			.route({
				method: "POST",
				path: "/policy-packs/{id}/revisions",
				summary: "Publish a new immutable policy pack revision",
				successStatus: 201,
			})
			.input(
				RevisionPublicationMetadataSchema.extend({
					id: z.string(),
					name: z
						.string()
						.min(1)
						.optional()
						.describe("Replacement name; omitted to inherit the current head."),
					description: z
						.string()
						.nullable()
						.optional()
						.describe(
							"Replacement description; omitted to inherit and null to clear.",
						),
					definition: z
						.record(z.string(), z.unknown())
						.optional()
						.describe(
							"Replacement policy definition; omitted to inherit the current head.",
						),
					status: ControlPlaneStatusSchema.optional().describe(
						"Replacement lifecycle status; omitted to inherit the current head.",
					),
				}),
			)
			.output(PolicyPackSchema),

		diffPolicyPackRevisions: oc
			.route({
				method: "GET",
				path: "/policy-packs/{id}/diff/{otherId}",
				summary: "Diff two policy pack revisions",
			})
			.input(z.object({ id: z.string(), otherId: z.string() }))
			.output(RevisionDiffOutputSchema),

		rollbackPolicyPackRevision: oc
			.route({
				method: "POST",
				path: "/policy-packs/{id}/rollback",
				summary: "Restore an older policy pack revision and rebind one tedi",
			})
			.input(RevisionRollbackInputSchema)
			.output(PolicyPackSchema),

		deletePolicyPack: oc
			.route({
				method: "DELETE",
				path: "/policy-packs/{id}",
				summary: "Delete policy pack",
			})
			.input(z.object({ id: z.string() }))
			.output(z.object({ success: z.literal(true) })),

		// =====================================================================
		// WORKSPACE TEMPLATE SETS
		// =====================================================================

		listWorkspaceTemplateSets: oc
			.route({
				method: "GET",
				path: "/workspace-templates",
				summary: "List workspace template sets",
				description:
					"List workspace template sets for the current organization, optionally including system-level sets.",
			})
			.input(
				z.object({
					organizationId: z.string().optional(),
					includeSystem: z.boolean().optional(),
				}),
			)
			.output(z.object({ data: z.array(WorkspaceTemplateSetSchema) })),

		getWorkspaceTemplateSet: oc
			.route({
				method: "GET",
				path: "/workspace-templates/{id}",
				summary: "Get workspace template set",
			})
			.input(z.object({ id: z.string() }))
			.output(WorkspaceTemplateSetSchema),

		createWorkspaceTemplateSet: oc
			.route({
				method: "POST",
				path: "/workspace-templates",
				summary: "Create workspace template set",
				successStatus: 201,
			})
			.input(
				z.object({
					name: z.string().min(1),
					slug: z.string().min(1),
					description: z.string().optional(),
					scope: ControlPlaneScopeSchema.optional(),
					templates: z.record(z.string(), z.unknown()),
					organizationId: z.string().optional(),
				}),
			)
			.output(WorkspaceTemplateSetSchema),

		listWorkspaceTemplateSetRevisions: oc
			.route({
				method: "GET",
				path: "/workspace-templates/{id}/revisions",
				summary: "List immutable workspace template set revisions",
			})
			.input(z.object({ id: z.string() }))
			.output(z.object({ data: z.array(WorkspaceTemplateSetSchema) })),

		publishWorkspaceTemplateSetRevision: oc
			.route({
				method: "POST",
				path: "/workspace-templates/{id}/revisions",
				summary: "Publish a new immutable workspace template set revision",
				successStatus: 201,
			})
			.input(
				RevisionPublicationMetadataSchema.extend({
					id: z.string(),
					name: z
						.string()
						.min(1)
						.optional()
						.describe("Replacement name; omitted to inherit the current head."),
					description: z
						.string()
						.nullable()
						.optional()
						.describe(
							"Replacement description; omitted to inherit and null to clear.",
						),
					templates: z
						.record(z.string(), z.unknown())
						.optional()
						.describe(
							"Replacement workspace templates; omitted to inherit the current head.",
						),
					status: ControlPlaneStatusSchema.optional().describe(
						"Replacement lifecycle status; omitted to inherit the current head.",
					),
				}),
			)
			.output(WorkspaceTemplateSetSchema),

		diffWorkspaceTemplateSetRevisions: oc
			.route({
				method: "GET",
				path: "/workspace-templates/{id}/diff/{otherId}",
				summary: "Diff two workspace template set revisions",
			})
			.input(z.object({ id: z.string(), otherId: z.string() }))
			.output(RevisionDiffOutputSchema),

		rollbackWorkspaceTemplateSetRevision: oc
			.route({
				method: "POST",
				path: "/workspace-templates/{id}/rollback",
				summary:
					"Restore an older workspace template set revision and rebind one tedi",
			})
			.input(RevisionRollbackInputSchema)
			.output(WorkspaceTemplateSetSchema),

		deleteWorkspaceTemplateSet: oc
			.route({
				method: "DELETE",
				path: "/workspace-templates/{id}",
				summary: "Delete workspace template set",
			})
			.input(z.object({ id: z.string() }))
			.output(z.object({ success: z.literal(true) })),

		// =====================================================================
		// EFFECTIVE CONFIG RESOLUTION
		// =====================================================================
		listTediControlPlaneBindingHistory: oc
			.route({
				method: "GET",
				path: "/tedis/{tediId}/binding-history",
				summary: "List immutable control-plane pin history for one tedi",
			})
			.input(z.object({ tediId: z.string() }))
			.output(
				z.object({ data: z.array(TediControlPlaneBindingHistorySchema) }),
			),

		getEffectiveAppConfig: oc
			.route({
				method: "GET",
				path: "/apps/{appId}/effective-config",
				summary: "Get effective app config",
				description:
					"Resolves the effective configuration for an app by merging live app config with active config version overrides.",
			})
			.input(z.object({ appId: z.string() }))
			.output(EffectiveAppConfigSchema),
	});

export type ControlPlaneContract = typeof controlPlaneContract;
