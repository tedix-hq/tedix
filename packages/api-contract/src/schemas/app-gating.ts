/**
 * App Gating Schemas
 * Zod schemas for app metadata gating system
 *
 * These schemas define the requirements/provides/gating model
 * that determines which apps and tools are available to an org.
 */

import * as z from "zod";
import { JsonValueSchema } from "./common";

// =============================================================================
// PLAN TIER
// =============================================================================

export const PlanTierSchema = z.enum(["free", "starter", "pro", "enterprise"]);
export type PlanTier = z.infer<typeof PlanTierSchema>;

/**
 * Plan tier hierarchy for comparison.
 * Maps provider-neutral runtime profile keys to the legacy gating tiers.
 */
export const PLAN_HIERARCHY: Record<PlanTier, number> = {
	free: 0,
	starter: 1,
	pro: 2,
	enterprise: 3,
};

// =============================================================================
// REQUIREMENTS
// =============================================================================

export const AppRequirementsSchema = z.object({
	/** OAuth connector providers needed (e.g. 'gmail', 'notion', 'github') */
	connectors: z.array(z.string()).optional(),
	/** Per-connector minimum OAuth scopes */
	scopes: z.record(z.string(), z.array(z.string())).optional(),
	/** Minimum plan tier */
	plan: PlanTierSchema.optional(),
	/** Named runtime entitlement grants required by this app or tool. */
	entitlements: z.array(z.string().min(1)).optional(),
	/** Platform features needed (vectorize, queues, workflows, ai-gateway) */
	features: z.array(z.string()).optional(),
	/** Other MCP tools that must be available (cross-app dependencies) */
	tools: z.array(z.string()).optional(),
});
export type AppRequirements = z.infer<typeof AppRequirementsSchema>;

// =============================================================================
// PROVIDES
// =============================================================================

export const GatingToolDefinitionSchema = z.object({
	name: z.string(),
	description: z.string(),
	inputSchema: z.record(z.string(), JsonValueSchema),
	/** Per-tool additional requirements beyond the app-level ones */
	requires: AppRequirementsSchema.optional(),
});
export type GatingToolDefinition = z.infer<typeof GatingToolDefinitionSchema>;

export const WidgetLayoutPositionSchema = z.object({
	id: z.string(),
	type: z.enum(["card", "list", "chart", "form", "table"]),
	tool: z.string(),
	config: z.record(z.string(), JsonValueSchema),
});

export const PromptTemplateSchema = z.object({
	name: z.string(),
	template: z.string(),
	variables: z.array(z.string()),
});

export const AppProvidesSchema = z.object({
	tools: z.array(GatingToolDefinitionSchema),
	widgets: z.array(WidgetLayoutPositionSchema).optional(),
	prompts: z.array(PromptTemplateSchema).optional(),
	triggers: z.array(z.string()).optional(),
});
export type AppProvides = z.infer<typeof AppProvidesSchema>;

// =============================================================================
// GATING CONFIG
// =============================================================================

export const GatingConfigSchema = z.object({
	/** strict = all requirements or nothing; degraded = partial functionality */
	mode: z.enum(["strict", "degraded"]),
	/** Tools available without full requirements (only in degraded mode) */
	degradedTools: z.array(z.string()).optional(),
});
export type GatingConfig = z.infer<typeof GatingConfigSchema>;

// =============================================================================
// DISPLAY
// =============================================================================

export const AppDisplaySchema = z.object({
	emoji: z.string().optional(),
	category: z.string(),
	tags: z.array(z.string()),
	screenshots: z.array(z.string()).optional(),
	homepage: z.string().optional(),
});
export type AppDisplay = z.infer<typeof AppDisplaySchema>;

// =============================================================================
// APP GATING METADATA (the full "tedix" envelope)
// =============================================================================

export const AppGatingMetadataSchema = z.object({
	tedix: z.object({
		requires: AppRequirementsSchema,
		provides: AppProvidesSchema,
		gating: GatingConfigSchema,
		display: AppDisplaySchema,
	}),
});
export type AppGatingMetadata = z.infer<typeof AppGatingMetadataSchema>;

// =============================================================================
// RESOLUTION
// =============================================================================

export const ResolutionSchema = z.object({
	action: z.enum(["connect", "upgrade", "install", "enable"]),
	label: z.string(),
	href: z.string(),
});
export type Resolution = z.infer<typeof ResolutionSchema>;

// =============================================================================
// REQUIREMENT MISSING
// =============================================================================

export const RequirementMissingSchema = z.object({
	type: z.enum([
		"connector",
		"scope",
		"plan",
		"entitlement",
		"feature",
		"tool",
	]),
	key: z.string(),
	detail: z.string().optional(),
	resolution: ResolutionSchema.optional(),
});
export type RequirementMissing = z.infer<typeof RequirementMissingSchema>;

// =============================================================================
// UNAVAILABLE TOOL
// =============================================================================

export const UnavailableToolSchema = z.object({
	name: z.string(),
	reason: z.string(),
	missing: z.array(RequirementMissingSchema),
});
export type UnavailableTool = z.infer<typeof UnavailableToolSchema>;

// =============================================================================
// ELIGIBILITY RESULT
// =============================================================================

export const EligibilityResultSchema = z.object({
	eligible: z.boolean(),
	degraded: z.boolean(),
	missing: z.array(RequirementMissingSchema),
	availableTools: z.array(z.string()),
	unavailableTools: z.array(UnavailableToolSchema),
});
export type EligibilityResult = z.infer<typeof EligibilityResultSchema>;

// =============================================================================
// RUNTIME TOOL INFO
// =============================================================================

export const RuntimeToolInfoSchema = z.object({
	name: z.string(),
	description: z.string(),
	inputSchema: z.record(z.string(), JsonValueSchema),
	available: z.boolean(),
	unavailableReason: z.string().optional(),
});
export type RuntimeToolInfo = z.infer<typeof RuntimeToolInfoSchema>;

// =============================================================================
// ORG STATE (for gating engine input)
// =============================================================================

export const ConnectorStateSchema = z.object({
	provider: z.string(),
	active: z.boolean(),
	scopes: z.array(z.string()),
	tokenExpiresAt: z.number().optional(),
});
export type ConnectorState = z.infer<typeof ConnectorStateSchema>;

export const OrgStateSchema = z.object({
	orgId: z.string(),
	plan: PlanTierSchema,
	entitlements: z.array(z.string()),
	connectors: z.array(ConnectorStateSchema),
	features: z.array(z.string()),
	installedTools: z.array(z.string()),
});
export type OrgState = z.infer<typeof OrgStateSchema>;

// =============================================================================
// ELIGIBILITY BADGE (for marketplace listing)
// =============================================================================

export const EligibilityBadgeSchema = z.enum([
	"ready",
	"setup_needed",
	"plan_upgrade",
]);
export type EligibilityBadge = z.infer<typeof EligibilityBadgeSchema>;
