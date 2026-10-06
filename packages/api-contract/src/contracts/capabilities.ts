import "@orpc/openapi/extensions/route";
/**
 * Business Capability Map Contract
 *
 * Value-stream-derived capabilities (WHAT the org does to deliver value) with
 * a max-depth-3 tree, pace layers, maturity scores, and one generic link
 * surface mapping skills/apps/tedis/objectives onto capabilities.
 *
 * Flywheel remodel P5 #2 (LeanIX precondition + Porter value-stream
 * refinement + Wilmes relevance filter). D1 tables: org_capabilities,
 * capability_links (packages/db/src/schema/capabilities.ts). Projected MCP
 * tool ids are verb-first snake_case (create_capability, list_capabilities,
 * get_capability_coverage, link_capability, ...) via
 * CAPABILITY_TOOL_ID_OVERRIDES in apps/api/src/services/tool-schema-sync.ts.
 *
 * Used by: Tedix OS Activity capability coverage, tedis via the aggregate MCP surface,
 * the retired seed-capability-map script.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import { PaginationMetaSchema, PaginationSchema } from "../schemas/common";

// =============================================================================
// SCHEMAS
// =============================================================================

export const CapabilityPaceLayerSchema = z.enum([
	"innovation",
	"differentiation",
	"record",
]);
export type CapabilityPaceLayerInput = z.infer<
	typeof CapabilityPaceLayerSchema
>;

const CapabilityStatusSchema = z.enum(["active", "archived"]);

export const CapabilityLinkKindSchema = z.enum([
	"skill",
	"app",
	"tedi",
	"external_agent",
	"objective",
]);
export type CapabilityLinkKindInput = z.infer<typeof CapabilityLinkKindSchema>;

export const CapabilitySchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	parentId: z.string().nullable(),
	name: z.string(),
	slug: z.string(),
	description: z.string().nullable(),
	valueStream: z.string().nullable(),
	paceLayer: CapabilityPaceLayerSchema,
	maturityScore: z.number().nullable(),
	status: CapabilityStatusSchema,
	createdAt: z.string(),
	updatedAt: z.string().nullable(),
	archivedAt: z.string().nullable(),
});

export type Capability = z.infer<typeof CapabilitySchema>;

export const CapabilityLinkSchema = z.object({
	id: z.string(),
	capabilityId: z.string(),
	organizationId: z.string(),
	entityKind: CapabilityLinkKindSchema,
	entityId: z.string(),
	createdAt: z.string(),
});

export type CapabilityLinkOutput = z.infer<typeof CapabilityLinkSchema>;

// Tree depth is a hard invariant (≤3), so the node schema is expressed as
// three finite levels instead of z.lazy() recursion — keeps the projected
// JSON schema converter-friendly for MCP tool output schemas.
const CapabilityTreeLevel3Schema = CapabilitySchema.extend({
	children: z
		.array(CapabilitySchema)
		.max(0)
		.describe("Always empty — tree depth is capped at 3"),
});
const CapabilityTreeLevel2Schema = CapabilitySchema.extend({
	children: z.array(CapabilityTreeLevel3Schema),
});
export const CapabilityTreeNodeSchema = CapabilitySchema.extend({
	children: z.array(CapabilityTreeLevel2Schema),
});

const CapabilityCoverageEntrySchema = z.object({
	capabilityId: z.string(),
	name: z.string(),
	slug: z.string(),
	parentId: z.string().nullable(),
	depth: z.number(),
	paceLayer: CapabilityPaceLayerSchema,
	valueStream: z.string().nullable(),
	maturityScore: z.number().nullable(),
	linkedSkillCount: z.number(),
	skillLifecycleMix: z.record(z.string(), z.number()),
	skillPaceLayerMix: z.record(z.string(), z.number()),
	linkedTediCount: z.number(),
	linkedObjectiveCount: z.number(),
	linkedAppCount: z.number(),
});

const UnmappedSkillSchema = z.object({
	id: z.string(),
	title: z.string(),
	slug: z.string().nullable(),
	lifecycleState: z.string().nullable(),
	paceLayer: z.string().nullable(),
	appId: z.string().nullable(),
});

const UnmappedObjectiveSchema = z.object({
	id: z.string(),
	tediId: z.string(),
	title: z.string(),
	type: z.string(),
	status: z.string(),
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

export const capabilitiesContract = oc
	.route({ tags: ["capabilities"], prefix: "/capabilities" })
	.errors(baseErrors)
	.router({
		create: oc
			.route({
				method: "POST",
				path: "" as `/${string}`,
				summary: "Create capability",
				successStatus: 201,
			})
			.input(
				z.object({
					organizationId: OrganizationIdInputSchema,
					parentId: z.uuid().optional(),
					name: z.string().min(1).max(200),
					slug: z
						.string()
						.regex(/^[a-z0-9][a-z0-9-]*$/)
						.max(80)
						.optional(),
					description: z.string().max(5000).optional(),
					valueStream: z
						.string()
						.max(500)
						.optional()
						.describe("Which tenant value stream this capability serves"),
					paceLayer: CapabilityPaceLayerSchema,
					maturityScore: z.number().min(0).max(1).optional(),
				}),
			)
			.output(CapabilitySchema),

		update: oc
			.route({
				method: "PATCH",
				path: "/{id}",
				summary: "Update capability",
			})
			.input(
				z.object({
					id: z.uuid(),
					name: z.string().min(1).max(200).optional(),
					slug: z
						.string()
						.regex(/^[a-z0-9][a-z0-9-]*$/)
						.max(80)
						.optional(),
					description: z.string().max(5000).nullable().optional(),
					valueStream: z.string().max(500).nullable().optional(),
					paceLayer: CapabilityPaceLayerSchema.optional(),
					maturityScore: z.number().min(0).max(1).nullable().optional(),
					parentId: z.uuid().nullable().optional(),
				}),
			)
			.output(CapabilitySchema),

		archive: oc
			.route({
				method: "POST",
				path: "/{id}/archive",
				summary: "Archive capability subtree",
			})
			.input(z.object({ id: z.uuid() }))
			.output(
				z.object({
					archivedIds: z.array(z.string()),
					archivedCount: z.number(),
				}),
			),

		list: oc
			.route({
				method: "GET",
				path: "" as `/${string}`,
				summary: "List capabilities",
			})
			.input(
				z
					.object({
						organizationId: OrganizationIdInputSchema,
						status: CapabilityStatusSchema.optional(),
						paceLayer: CapabilityPaceLayerSchema.optional(),
						parentId: z.uuid().nullable().optional(),
					})
					.extend(PaginationSchema.shape)
					.optional(),
			)
			.output(
				z.object({
					data: z.array(CapabilitySchema),
					pagination: PaginationMetaSchema,
				}),
			),

		tree: oc
			.route({
				method: "GET",
				path: "/tree",
				summary: "Get capability tree",
			})
			.input(
				z
					.object({
						organizationId: OrganizationIdInputSchema,
						includeArchived: z.boolean().optional(),
					})
					.optional(),
			)
			.output(z.object({ roots: z.array(CapabilityTreeNodeSchema) })),

		coverage: oc
			.route({
				method: "GET",
				path: "/coverage",
				summary: "Get capability coverage",
			})
			.input(z.object({ organizationId: OrganizationIdInputSchema }).optional())
			.output(
				z.object({
					capabilities: z.array(CapabilityCoverageEntrySchema),
					totals: z.object({
						capabilityCount: z.number(),
						mappedSkillCount: z.number(),
						mappedTediCount: z.number(),
						mappedObjectiveCount: z.number(),
						mappedAppCount: z.number(),
					}),
				}),
			),

		unmapped: oc
			.route({
				method: "GET",
				path: "/unmapped",
				summary: "List unmapped capability entities",
			})
			.input(
				z
					.object({
						organizationId: OrganizationIdInputSchema,
						includeAppScopedSkills: z.boolean().optional(),
						limit: z.number().min(1).max(500).optional(),
					})
					.optional(),
			)
			.output(
				z.object({
					skills: z.array(UnmappedSkillSchema),
					objectives: z.array(UnmappedObjectiveSchema),
					totals: z.object({
						unmappedSkillCount: z.number(),
						unmappedObjectiveCount: z.number(),
						skillTotal: z.number(),
						objectiveTotal: z.number(),
					}),
				}),
			),

		link: oc
			.route({
				method: "POST",
				path: "/{id}/links",
				summary: "Link capability",
			})
			.input(
				z.object({
					id: z.uuid().describe("Capability ID"),
					entityKind: CapabilityLinkKindSchema,
					entityId: z.string().min(1),
				}),
			)
			.output(z.object({ link: CapabilityLinkSchema, created: z.boolean() })),

		unlink: oc
			.route({
				method: "POST",
				path: "/{id}/unlink",
				summary: "Unlink capability",
			})
			.input(
				z.object({
					id: z.uuid().describe("Capability ID"),
					entityKind: CapabilityLinkKindSchema,
					entityId: z.string().min(1),
				}),
			)
			.output(z.object({ removed: z.boolean() })),
	});

export type CapabilitiesContract = typeof capabilitiesContract;
