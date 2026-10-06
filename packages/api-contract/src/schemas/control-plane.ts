/**
 * Control Plane Zod Schemas
 * Validation schemas for runtime profiles, policy packs, and workspace template sets.
 */

import * as z from "zod";
import { JsonValueSchema } from "./common";

// =============================================================================
// ENUM SCHEMAS
// =============================================================================

export const ControlPlaneScopeSchema = z.enum(["system", "organization"]);
export type ControlPlaneScope = z.infer<typeof ControlPlaneScopeSchema>;

export const ControlPlaneStatusSchema = z.enum(["draft", "active", "archived"]);
export type ControlPlaneStatus = z.infer<typeof ControlPlaneStatusSchema>;

export const PolicyPackTargetSchema = z.enum(["tedi", "app", "shared"]);
export type PolicyPackTarget = z.infer<typeof PolicyPackTargetSchema>;

export const EvolutionStrategySchema = z.enum([
	"balanced",
	"harden",
	"repair-only",
]);
export type EvolutionStrategy = z.infer<typeof EvolutionStrategySchema>;

// =============================================================================
// OBJECT SCHEMAS
// =============================================================================

export const RuntimeProfileSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable(),
	name: z.string(),
	slug: z.string(),
	description: z.string().nullable(),
	scope: ControlPlaneScopeSchema,
	status: ControlPlaneStatusSchema,
	version: z.number(),
	supersedesRevisionId: z
		.string()
		.nullable()
		.describe("Prior immutable revision id, or null for the initial revision."),
	rollbackOfRevisionId: z
		.string()
		.nullable()
		.describe(
			"Historical revision copied by a rollback publication, otherwise null.",
		),
	changeSummary: z
		.string()
		.nullable()
		.describe(
			"Publication reason when supplied; migrated legacy revisions may have a cutover summary.",
		),
	publishedAt: z
		.string()
		.nullable()
		.describe(
			"Publication timestamp; nullable only for pre-cutover compatibility.",
		),
	publishedBy: z
		.string()
		.nullable()
		.describe(
			"Stable publisher principal id when available; nullable for migrated or internal writes.",
		),
	config: z.record(z.string(), JsonValueSchema),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
});
export type RuntimeProfile = z.infer<typeof RuntimeProfileSchema>;

export const PolicyPackSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable(),
	name: z.string(),
	slug: z.string(),
	description: z.string().nullable(),
	scope: ControlPlaneScopeSchema,
	target: PolicyPackTargetSchema,
	status: ControlPlaneStatusSchema,
	version: z.number(),
	supersedesRevisionId: z
		.string()
		.nullable()
		.describe("Prior immutable revision id, or null for the initial revision."),
	rollbackOfRevisionId: z
		.string()
		.nullable()
		.describe(
			"Historical revision copied by a rollback publication, otherwise null.",
		),
	changeSummary: z
		.string()
		.nullable()
		.describe(
			"Publication reason when supplied; migrated legacy revisions may have a cutover summary.",
		),
	publishedAt: z
		.string()
		.nullable()
		.describe(
			"Publication timestamp; nullable only for pre-cutover compatibility.",
		),
	publishedBy: z
		.string()
		.nullable()
		.describe(
			"Stable publisher principal id when available; nullable for migrated or internal writes.",
		),
	definition: z.record(z.string(), JsonValueSchema),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
});
export type PolicyPack = z.infer<typeof PolicyPackSchema>;

export const WorkspaceTemplateSetSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable(),
	name: z.string(),
	slug: z.string(),
	description: z.string().nullable(),
	scope: ControlPlaneScopeSchema,
	status: ControlPlaneStatusSchema,
	version: z.number(),
	supersedesRevisionId: z
		.string()
		.nullable()
		.describe("Prior immutable revision id, or null for the initial revision."),
	rollbackOfRevisionId: z
		.string()
		.nullable()
		.describe(
			"Historical revision copied by a rollback publication, otherwise null.",
		),
	changeSummary: z
		.string()
		.nullable()
		.describe(
			"Publication reason when supplied; migrated legacy revisions may have a cutover summary.",
		),
	publishedAt: z
		.string()
		.nullable()
		.describe(
			"Publication timestamp; nullable only for pre-cutover compatibility.",
		),
	publishedBy: z
		.string()
		.nullable()
		.describe(
			"Stable publisher principal id when available; nullable for migrated or internal writes.",
		),
	templates: z.record(z.string(), JsonValueSchema),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
});
export type WorkspaceTemplateSet = z.infer<typeof WorkspaceTemplateSetSchema>;

export const ControlPlaneDiffEntrySchema = z.object({
	path: z.string(),
	kind: z.enum(["added", "removed", "changed"]),
	before: JsonValueSchema.optional().describe(
		"Previous JSON value; absent when the path was added.",
	),
	after: JsonValueSchema.optional().describe(
		"New JSON value; absent when the path was removed.",
	),
});
export type ControlPlaneDiffEntry = z.infer<typeof ControlPlaneDiffEntrySchema>;

export const TediControlPlaneBindingHistorySchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	tediId: z.string(),
	kind: z.enum(["runtime_profile", "policy_pack", "workspace_template_set"]),
	previousRevisionId: z
		.string()
		.nullable()
		.describe(
			"Prior fixed pin, or null when binding from an unconfigured legacy state.",
		),
	revisionId: z.string(),
	changedBy: z
		.string()
		.nullable()
		.describe("Stable initiating principal id when available."),
	changeReason: z
		.string()
		.nullable()
		.describe("Operator or workflow reason when supplied."),
	effectiveAt: z.string(),
});
export type TediControlPlaneBindingHistory = z.infer<
	typeof TediControlPlaneBindingHistorySchema
>;

export const EffectiveAppConfigSchema = z.object({
	appId: z.string(),
	activeConfigVersionId: z.string().nullable(),
	activeConfigVersionNumber: z.number().nullable(),
	source: z.enum(["live_app", "active_version"]),
	config: z.record(z.string(), JsonValueSchema),
});
export type EffectiveAppConfig = z.infer<typeof EffectiveAppConfigSchema>;

// =============================================================================
// DESCOPE RBAC DRIFT
// =============================================================================

/**
 * Divergence between the LIVE Descope role/permission state and the canonical
 * model in `@tedix/auth/rbac`.
 *
 * Descope mints the role and permission claims every API guard authorizes
 * against, and the provisioning sync that keeps the two aligned is run by hand.
 * Until this existed, a Console edit or a failed sync was invisible until a
 * guard denied someone.
 *
 * Read-only and additive by construction: the underlying planner never removes
 * a permission from a role, so everything reported here is something Descope is
 * MISSING relative to the model — never something it should lose.
 */
export const DescopeRbacDriftSchema = z.object({
	checkedAt: z.string(),
	inSync: z.boolean(),
	/** Permissions the model defines that Descope does not have at all. */
	missingPermissions: z.array(z.string()),
	/**
	 * Permissions Descope has but with no description, which the sync would
	 * fill in. Cosmetic — listed separately so it never reads as real drift.
	 */
	undescribedPermissions: z.array(z.string()),
	/**
	 * Permissions Descope defines that NOTHING can evaluate — absent from the
	 * Tedix model and not used by Descope itself. Informational, never a
	 * failure: no sync can resolve them, because only Descope can hold them.
	 * Excluded from `inSync` for that reason.
	 */
	unusablePermissions: z.array(z.string()),
	/** Roles the model defines that Descope does not have at all. */
	missingRoles: z.array(z.string()),
	/** Roles that exist but are missing grants the model gives them. */
	rolesMissingPermissions: z.array(
		z.object({
			role: z.string(),
			missingPermissions: z.array(z.string()),
		}),
	),
});
export type DescopeRbacDrift = z.infer<typeof DescopeRbacDriftSchema>;
