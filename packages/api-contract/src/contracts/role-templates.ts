import "@orpc/openapi/extensions/route";
/**
 * Role Templates Contract (reusable role primitive)
 *
 * A config-driven role template provisions the four ingredients a tedi's role
 * (CMO / CTO / …) is otherwise hand-assembled from — persona (SOUL), standing
 * objectives, app-assignment tags, and capability profile — as one unit.
 *
 * D1 table: role_templates (packages/db/src/schema/role-templates.ts). Projected
 * MCP tool ids are verb-first snake_case (create_role_template,
 * list_role_templates, apply_role_template) via ROLE_TEMPLATE_TOOL_ID_OVERRIDES
 * in apps/api/src/services/tool-schema-sync.ts.
 *
 * apply_role_template provisions onto an EXISTING tedi by reusing the canonical
 * writers (updateTedi + createObjective). It does NOT run managed app-assignment
 * reconcile — setting `tedis.tags` is the trigger, and reconcile runs separately.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	JsonValueSchema,
	PaginationMetaSchema,
	PaginationSchema,
} from "../schemas/common";
import { TediCareerStageSchema } from "../schemas/earned-delegation";
import { GateConfigSchema } from "./tedi-objectives";

// =============================================================================
// SCHEMAS
// =============================================================================

export const RoleCapabilityProfileSchema = z.enum([
	"standard",
	"content_admin",
	"org_admin",
	"platform_admin",
]);
export type RoleCapabilityProfileInput = z.infer<
	typeof RoleCapabilityProfileSchema
>;

const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);

export const RoleTemplateStandingObjectiveSchema = z.object({
	title: z.string().min(1).max(200),
	approach: z.string().max(2000).optional(),
	successCriteria: z.string().max(2000).optional(),
	riskLevel: RiskLevelSchema.optional(),
	gateConfig: GateConfigSchema.optional(),
});

export const RoleTemplateSchema = z.object({
	id: z.string(),
	orgId: z.string().nullable(),
	key: z.string(),
	name: z.string(),
	description: z.string().nullable(),
	persona: z.string(),
	standingObjectives: z.array(RoleTemplateStandingObjectiveSchema),
	tags: z.array(z.string()),
	capabilityProfile: RoleCapabilityProfileSchema,
	cronTemplateNames: z.array(z.string()),
	metadata: z.record(z.string(), JsonValueSchema).nullable(),
	createdAt: z.string(),
	updatedAt: z.string().nullable(),
	archivedAt: z.string().nullable(),
});
export type RoleTemplate = z.infer<typeof RoleTemplateSchema>;

const ApplyRoleTemplateSummarySchema = z.object({
	templateId: z.string(),
	templateKey: z.string(),
	tediId: z.string(),
	personaSet: z.boolean(),
	requestedCapabilityProfile: RoleCapabilityProfileSchema,
	capabilityProfileChange: z.literal(
		"not_applied_role_does_not_grant_authority",
	),
	careerStage: TediCareerStageSchema,
	tagsAdded: z.array(z.string()),
	tagsAfter: z.array(z.string()),
	objectivesCreated: z.array(z.string()),
	objectivesUpdated: z.array(z.string()),
	objectivesSkipped: z.array(z.string()),
	/** Managed app-assignment reconcile (FGA) runs separately; setting tags is the trigger. */
	assignmentReconcile: z.literal("not_run_setting_tags_is_the_trigger"),
});

/**
 * Optional explicit org target. Ignored whenever the caller's auth context
 * already carries an organization scope (user JWT, API key, forwarded MCP
 * context) — only service-binding callers without org context need it.
 */
const OrganizationIdInputSchema = z.uuid().optional();

// =============================================================================
// CONTRACT
// =============================================================================

export const roleTemplatesContract = oc
	.route({ tags: ["role-templates"], prefix: "/role-templates" })
	.errors(baseErrors)
	.router({
		create: oc
			.route({
				method: "POST",
				path: "" as `/${string}`,
				summary: "Create role template",
				description:
					"Create an org-scoped reusable role template that provisions { persona + standing objectives + app-assignment tags + capability profile } as one unit. `key` is unique per org. Platform-wide blueprints (e.g. the seeded `cmo`) are managed via the seed helper, not this tool.",
				successStatus: 201,
			})
			.input(
				z.object({
					organizationId: OrganizationIdInputSchema,
					key: z
						.string()
						.min(1)
						.max(40)
						.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
					name: z.string().min(1).max(200),
					description: z.string().max(5000).optional(),
					persona: z.string().min(1).max(5000),
					standingObjectives: z
						.array(RoleTemplateStandingObjectiveSchema)
						.max(50)
						.optional(),
					tags: z.array(z.string().min(1).max(80)).max(50).optional(),
					capabilityProfile: RoleCapabilityProfileSchema.optional(),
					cronTemplateNames: z
						.array(z.string().min(1).max(120))
						.max(50)
						.optional(),
					metadata: z.record(z.string(), z.unknown()).optional(),
				}),
			)
			.output(RoleTemplateSchema),

		list: oc
			.route({
				method: "GET",
				path: "" as `/${string}`,
				summary: "List role templates",
				description:
					"List this organization's role templates plus platform-wide (org-null) blueprints. Archived templates are excluded unless includeArchived is set.",
			})
			.input(
				z
					.object({
						organizationId: OrganizationIdInputSchema,
						includeArchived: z.boolean().optional(),
					})
					.extend(PaginationSchema.shape)
					.optional(),
			)
			.output(
				z.object({
					data: z.array(RoleTemplateSchema),
					pagination: PaginationMetaSchema,
				}),
			),

		apply: oc
			.route({
				method: "POST",
				path: "/apply",
				summary: "Apply role template to a tedi",
				description:
					"Provision a descriptive role track onto an EXISTING tedi: set persona, union app-assignment tags, initialize the career stage at shadow, and reconcile supervised standing objectives. The template's requested capability profile is reported for review but never applied; role does not grant authority.",
			})
			.input(
				z.object({
					organizationId: OrganizationIdInputSchema,
					tediId: z.uuid(),
					templateKey: z.string().min(1).max(40),
				}),
			)
			.output(ApplyRoleTemplateSummarySchema),
	});

export type RoleTemplatesContract = typeof roleTemplatesContract;
