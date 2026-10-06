import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";

export const MemoryEntityTypeSchema = z.enum([
	"person",
	"organization",
	"product",
	"service",
	"tool",
	"api",
	"repository",
	"document",
	"domain",
	"location",
	"event",
	"concept",
	"other",
]);

export const MemoryEntityActorTypeSchema = z.enum([
	"user",
	"tedi",
	"service",
	"api_key",
	"external_agent",
	"system",
]);

const JsonRecordSchema = z.record(z.string(), z.unknown());
const TimestampSchema = z.string().min(1);

export const MemoryEntitySchema = z.object({
	id: z.uuid(),
	organizationId: z.uuid(),
	entityType: MemoryEntityTypeSchema,
	displayName: z.string(),
	normalizedName: z.string(),
	status: z.enum(["active", "merged", "deprecated"]),
	mergedIntoEntityId: z.uuid().nullable(),
	version: z.number().int().nonnegative(),
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
});

export const MemoryEntityMentionSchema = z.object({
	id: z.uuid(),
	organizationId: z.uuid(),
	occurrenceKey: z.string(),
	sourceFactId: z.uuid().nullable(),
	sourceUri: z.string().nullable(),
	sourceContentHash: z.string().nullable(),
	sourceSessionId: z.string().nullable(),
	sourceRunId: z.string().nullable(),
	surfaceForm: z.string(),
	normalizedForm: z.string(),
	proposedType: MemoryEntityTypeSchema,
	charStart: z.number().int().nonnegative().nullable(),
	charEnd: z.number().int().positive().nullable(),
	extractor: z.string(),
	extractorVersion: z.string(),
	modelId: z.string().nullable(),
	harnessVersionId: z.string().nullable(),
	confidence: z.number().min(0).max(1),
	evidence: JsonRecordSchema,
	createdAt: TimestampSchema,
});

export const MemoryEntityResolutionHeadSchema = z.object({
	mentionId: z.uuid(),
	organizationId: z.uuid(),
	version: z.number().int().nonnegative(),
	currentResolutionId: z.uuid().nullable(),
	currentEntityId: z.uuid().nullable(),
	lastDecisionId: z.uuid().nullable(),
	updatedAt: TimestampSchema,
});

export const MemoryEntityResolutionSchema = z.object({
	id: z.uuid(),
	organizationId: z.uuid(),
	mentionId: z.uuid(),
	entityId: z.uuid().nullable(),
	decisionId: z.uuid(),
	resolutionKind: z.enum(["linked", "unresolved"]),
	status: z.enum(["active", "revoked"]),
	confidence: z.number().min(0).max(1),
	validFrom: TimestampSchema,
	validTo: TimestampSchema.nullable(),
	createdAt: TimestampSchema,
});

const ResolutionInverseSchema = z.object({
	entityId: z.uuid().nullable(),
	resolutionId: z.uuid().nullable(),
	confidence: z.number().min(0).max(1).nullable(),
});

export const MemoryEntityResolutionDecisionSchema = z.object({
	id: z.uuid(),
	organizationId: z.uuid(),
	clientProposalKey: z.string(),
	operation: z.enum([
		"link_mention",
		"reassign_mention",
		"link_alias",
		"merge_entities",
		"split_entity",
		"rollback",
	]),
	mentionId: z.uuid().nullable(),
	aliasId: z.uuid().nullable(),
	sourceEntityId: z.uuid().nullable(),
	targetEntityId: z.uuid().nullable(),
	status: z.enum(["proposed", "accepted", "rejected"]),
	confidence: z.number().min(0).max(1),
	rationale: z.string(),
	evidence: JsonRecordSchema,
	proposedByType: MemoryEntityActorTypeSchema,
	proposedById: z.string(),
	reviewedByType: MemoryEntityActorTypeSchema.nullable(),
	reviewedById: z.string().nullable(),
	reviewRationale: z.string().nullable(),
	sourceRunId: z.string().nullable(),
	expectedMentionVersion: z.number().int().nonnegative(),
	expectedHeadDecisionId: z.uuid().nullable(),
	expectedEntityVersion: z.number().int().nonnegative().nullable(),
	version: z.number().int().nonnegative(),
	supersedesDecisionId: z.uuid().nullable(),
	rollbackOfDecisionId: z.uuid().nullable(),
	inverse: ResolutionInverseSchema,
	proposedAt: TimestampSchema,
	reviewedAt: TimestampSchema.nullable(),
	appliedAt: TimestampSchema.nullable(),
});

export const MemoryEntityMentionStateSchema = z.object({
	mention: MemoryEntityMentionSchema,
	head: MemoryEntityResolutionHeadSchema,
	currentResolution: MemoryEntityResolutionSchema.nullable(),
	history: z.array(MemoryEntityResolutionDecisionSchema),
});

const EntityCandidateSchema = z.object({
	entity: MemoryEntitySchema,
	matchedBy: z.enum(["canonical", "alias"]),
	aliasId: z.uuid().nullable(),
});

const ProposalInputSchema = z.object({
	decisionId: z.uuid(),
	clientProposalKey: z.string().trim().min(1).max(240),
	mentionId: z.uuid(),
	targetEntityId: z.uuid(),
	confidence: z.number().min(0).max(1),
	rationale: z.string().trim().min(1).max(8_000),
	evidence: JsonRecordSchema.optional(),
	sourceRunId: z.string().trim().min(1).max(240).optional(),
});

export const RecordMemoryEntityMentionInputSchema = z
	.object({
		mentionId: z.uuid(),
		occurrenceKey: z.string().trim().min(1).max(500),
		sourceFactId: z.uuid().optional(),
		sourceUri: z.string().trim().min(1).max(4_000).optional(),
		sourceContentHash: z.string().trim().min(1).max(256).optional(),
		sourceSessionId: z.string().trim().min(1).max(240).optional(),
		sourceRunId: z.string().trim().min(1).max(240).optional(),
		surfaceForm: z.string().min(1).max(1_000),
		normalizedForm: z.string().trim().min(1).max(1_000).optional(),
		proposedType: MemoryEntityTypeSchema,
		charStart: z.number().int().nonnegative().optional(),
		charEnd: z.number().int().positive().optional(),
		extractor: z.string().trim().min(1).max(200),
		extractorVersion: z.string().trim().min(1).max(200),
		modelId: z.string().trim().min(1).max(240).optional(),
		harnessVersionId: z.string().trim().min(1).max(240).optional(),
		confidence: z.number().min(0).max(1),
		evidence: JsonRecordSchema.optional(),
	})
	.refine(
		(input) =>
			(input.charStart === undefined && input.charEnd === undefined) ||
			(input.charStart !== undefined &&
				input.charEnd !== undefined &&
				input.charEnd > input.charStart),
		{
			message:
				"charStart and charEnd must be supplied together and charEnd must be greater",
			path: ["charEnd"],
		},
	);

export const ReviewMemoryEntityResolutionInputSchema = z
	.object({
		decisionId: z.uuid(),
		expectedDecisionVersion: z.number().int().nonnegative(),
		outcome: z.enum(["accept", "reject"]),
		reviewRationale: z.string().trim().min(1).max(8_000),
		resolutionId: z.uuid().optional(),
	})
	.refine(
		(input) => input.outcome === "reject" || input.resolutionId !== undefined,
		{
			message: "resolutionId is required when accepting",
			path: ["resolutionId"],
		},
	);

export const memoryEntitiesContract = oc
	.route({ tags: ["memory-entities"], prefix: "/memory/entities" })
	.errors(baseErrors)
	.router({
		createEntity: oc
			.route({
				method: "POST",
				path: "" as `/${string}`,
				summary: "Create a canonical governed memory entity",
				description:
					"Owner/admin or an explicitly admin-scoped accountable tedi only. D1 is canonical; projection is queued durably.",
				successStatus: 201,
			})
			.input(
				z.object({
					entityId: z.uuid().optional(),
					entityType: MemoryEntityTypeSchema,
					displayName: z.string().trim().min(1).max(500),
					normalizedName: z.string().trim().min(1).max(500).optional(),
				}),
			)
			.output(MemoryEntitySchema),

		recordMention: oc
			.route({
				method: "POST",
				path: "/mentions",
				summary: "Record immutable entity-mention evidence",
				description:
					"Idempotent by occurrence key and mention id. A mention is evidence, never an automatic canonical link.",
				successStatus: 201,
			})
			.input(RecordMemoryEntityMentionInputSchema)
			.output(MemoryEntityMentionSchema),

		listCandidates: oc
			.route({
				method: "GET",
				path: "/candidates",
				summary: "List exact canonical-name and confirmed-alias candidates",
				description:
					"Deterministic exact normalization only; semantic candidates do not bypass governed review.",
			})
			.input(
				z.object({
					surface: z.string().trim().min(1).max(1_000),
					entityType: MemoryEntityTypeSchema.optional(),
					limit: z.number().int().min(1).max(100).default(25),
				}),
			)
			.output(z.object({ candidates: z.array(EntityCandidateSchema) })),

		proposeResolution: oc
			.route({
				method: "POST",
				path: "/resolutions/proposals",
				summary: "Propose a mention link or reassignment",
				description:
					"Records evidence only. A different governance principal must accept it before canonical state changes.",
				successStatus: 201,
			})
			.input(ProposalInputSchema)
			.output(MemoryEntityResolutionDecisionSchema),

		proposeResolutionRollback: oc
			.route({
				method: "POST",
				path: "/resolutions/rollback-proposals",
				summary: "Propose append-only rollback of the current resolution",
				successStatus: 201,
			})
			.input(
				z.object({
					decisionId: z.uuid(),
					clientProposalKey: z.string().trim().min(1).max(240),
					rollbackOfDecisionId: z.uuid(),
					rationale: z.string().trim().min(1).max(8_000),
					evidence: JsonRecordSchema.optional(),
					sourceRunId: z.string().trim().min(1).max(240).optional(),
				}),
			)
			.output(MemoryEntityResolutionDecisionSchema),

		reviewResolution: oc
			.route({
				method: "POST",
				path: "/resolutions/{decisionId}/review",
				summary: "Independently accept or reject a resolution proposal",
				description:
					"Owner/admin or an explicitly admin-scoped accountable tedi only. Proposer and reviewer must differ.",
			})
			.input(ReviewMemoryEntityResolutionInputSchema)
			.output(
				z.object({
					decision: MemoryEntityResolutionDecisionSchema,
					resolution: MemoryEntityResolutionSchema.nullable(),
					idempotent: z.boolean(),
				}),
			),

		getMentionResolution: oc
			.route({
				method: "GET",
				path: "/mentions/{mentionId}/resolution",
				summary: "Get a mention, current resolution, and decision history",
			})
			.input(
				z.object({
					mentionId: z.uuid(),
					historyLimit: z.number().int().min(1).max(200).default(100),
				}),
			)
			.output(MemoryEntityMentionStateSchema),
	});

export type MemoryEntitiesContract = typeof memoryEntitiesContract;
