import * as z from "zod";
import { AgentReplyDeliveryGateResultSchema } from "./agent-turn-triage";
import { BoundedJsonObjectSchema } from "./bounded-json";
import {
	CredentialWorkActorTypeSchema,
	WorkFactoryProjectionCursorSchema,
} from "./work-items";

export const WorkInteractionKindSchema = z.enum([
	"question",
	"input",
	"handoff",
	"coordination",
]);
export const WorkInteractionStateSchema = z.enum([
	"open",
	"resolved",
	"cancelled",
	"expired",
]);
export const WorkInteractionResponseKindSchema = z.enum([
	"answer",
	"input_provided",
	"handoff_accepted",
	"handoff_declined",
	"coordination_update",
]);
export const WorkInteractionTargetTypeSchema = z.enum([
	"user",
	"tedi",
	"external_agent",
]);

export const WorkInteractionUrgencySchema = z.enum(["now", "later"]);

export const WorkInteractionCursorSchema = WorkFactoryProjectionCursorSchema;

export const DelegateWorkInteractionInputSchema = z.strictObject({
	requestId: z.uuid(),
	expectedRequestVersion: z.number().int().positive(),
	tediId: z.uuid(),
});

const metadataSchema = BoundedJsonObjectSchema;

export const WorkInteractionRequestSchema = z.strictObject({
	id: z.uuid(),
	orgId: z.uuid(),
	workItemId: z
		.uuid()
		.nullable()
		.describe(
			"Set only when the interaction is scoped directly to a Work Item.",
		),
	caseId: z
		.uuid()
		.nullable()
		.describe(
			"Set only when the interaction is scoped directly to a Work case.",
		),
	projectId: z
		.uuid()
		.nullable()
		.describe("Set only when the interaction is scoped directly to a project."),
	kind: WorkInteractionKindSchema,
	subject: z.string().trim().min(1).max(300),
	prompt: z.string().trim().min(1).max(20_000),
	requestedFromType: WorkInteractionTargetTypeSchema,
	requestedFromId: z
		.string()
		.trim()
		.min(1)
		.max(300)
		.describe("Identifies the concrete principal requested to respond."),
	creatorType: CredentialWorkActorTypeSchema,
	creatorId: z.string().trim().min(1).max(300),
	creatorSessionId: z
		.string()
		.max(300)
		.nullable()
		.describe(
			"Present only when the creator is an external agent with an immutable session.",
		),
	state: WorkInteractionStateSchema,
	requestedAt: z.iso.datetime(),
	dueAt: z.iso
		.datetime()
		.nullable()
		.describe(
			"Nullable when the requester has not assigned a preferred response date.",
		),
	expiresAt: z.iso
		.datetime()
		.nullable()
		.describe("Nullable when the request has no automatic expiry deadline."),
	resolvedAt: z.iso
		.datetime()
		.nullable()
		.describe(
			"Null until a response resolves or a cancellation closes the request.",
		),
	version: z.number().int().positive(),
	metadata: metadataSchema,
});

export const WorkInteractionResponseSchema = z.strictObject({
	id: z.uuid(),
	requestId: z.uuid(),
	responseKind: WorkInteractionResponseKindSchema,
	body: z.string().trim().min(1).max(20_000),
	artifactRef: z
		.string()
		.trim()
		.min(1)
		.max(2_000)
		.nullable()
		.describe(
			"Nullable when the response is self-contained and has no linked artifact.",
		),
	artifactVersion: z
		.string()
		.trim()
		.min(1)
		.max(300)
		.nullable()
		.describe(
			"Nullable with artifactRef; otherwise pins the referenced artifact version.",
		),
	artifactDigest: z
		.string()
		.trim()
		.min(1)
		.max(300)
		.nullable()
		.describe("Optional integrity digest for the referenced artifact version."),
	resolvesRequest: z.boolean(),
	respondedByType: CredentialWorkActorTypeSchema,
	respondedById: z.string().trim().min(1).max(300),
	respondedBySessionId: z
		.string()
		.max(300)
		.nullable()
		.describe(
			"Present only when the responder is an external agent with an immutable session.",
		),
	respondedAt: z.iso.datetime(),
	metadata: metadataSchema,
});

export const CreateWorkInteractionInputSchema = z
	.strictObject({
		workItemId: z
			.uuid()
			.optional()
			.describe(
				"Supply for Work Item context; exactly one context identifier is required.",
			),
		caseId: z
			.uuid()
			.optional()
			.describe(
				"Supply for Work case context; exactly one context identifier is required.",
			),
		projectId: z
			.uuid()
			.optional()
			.describe(
				"Supply for project context; exactly one context identifier is required.",
			),
		kind: WorkInteractionKindSchema,
		subject: WorkInteractionRequestSchema.shape.subject,
		prompt: WorkInteractionRequestSchema.shape.prompt,
		requestedFrom: z
			.strictObject({
				type: WorkInteractionTargetTypeSchema,
				id: z.string().trim().min(1).max(300),
			})
			.describe("Concrete principal requested to respond."),
		dueAt: z.iso
			.datetime()
			.optional()
			.describe("Optional preferred response date visible to recipients."),
		expiresAt: z.iso
			.datetime()
			.optional()
			.describe(
				"Optional hard expiry after which the open request is no longer actionable.",
			),
		metadata: metadataSchema.default({}),
	})
	.superRefine((value, context) => {
		const contextCount = [
			value.workItemId,
			value.caseId,
			value.projectId,
		].filter((candidate) => candidate !== undefined).length;
		if (contextCount !== 1) {
			context.addIssue({
				code: "custom",
				message: "Exactly one of workItemId, caseId, or projectId is required",
				path: ["workItemId"],
			});
		}
	});

export const RespondToWorkInteractionInputSchema = z
	.strictObject({
		requestId: z.uuid(),
		expectedRequestVersion: z.number().int().positive(),
		responseKind: WorkInteractionResponseKindSchema,
		body: WorkInteractionResponseSchema.shape.body,
		artifactRef: z
			.string()
			.trim()
			.min(1)
			.max(2_000)
			.optional()
			.describe(
				"Optional artifact reference; requires artifactVersion when supplied.",
			),
		artifactVersion: z
			.string()
			.trim()
			.min(1)
			.max(300)
			.optional()
			.describe(
				"Optional artifact version; requires artifactRef when supplied.",
			),
		artifactDigest: z
			.string()
			.trim()
			.min(1)
			.max(300)
			.optional()
			.describe(
				"Optional integrity digest; valid only with an artifact reference and version.",
			),
		resolvesRequest: z.boolean().default(true),
		metadata: metadataSchema
			.default({})
			.describe(
				"Bounded response metadata. An answer that started from the request's latestDraft cites it as {draftId, draftOutcome: accepted|edited|replaced, editRatio: 0..1}; draft acceptance is measured from these keys.",
			),
	})
	.superRefine((value, context) => {
		if (
			(value.artifactRef === undefined) !==
			(value.artifactVersion === undefined)
		) {
			context.addIssue({
				code: "custom",
				message: "artifactRef and artifactVersion must be supplied together",
				path: ["artifactRef"],
			});
		}
		if (value.artifactDigest !== undefined && value.artifactRef === undefined) {
			context.addIssue({
				code: "custom",
				message: "artifactDigest requires artifactRef and artifactVersion",
				path: ["artifactDigest"],
			});
		}
	});

export const CancelWorkInteractionInputSchema = z.strictObject({
	requestId: z.uuid(),
	expectedRequestVersion: z.number().int().positive(),
});

export const GetWorkInteractionInputSchema = z.strictObject({
	requestId: z.uuid(),
	responseCursor: WorkInteractionCursorSchema.optional().describe(
		"Opaque response-ledger cursor; omit to start with the newest bounded page.",
	),
	responseLimit: z.number().int().min(1).max(100).default(50),
});

/**
 * A tedi-drafted reply proposal for an open, non-urgent decision-capture
 * question. A draft never answers the question: the target user answers
 * through `respond_to_work_interaction` and, when the answer started from a
 * draft, cites it in response metadata as {@link WorkInteractionDraftAnswerMetadataSchema}.
 */
export const WorkInteractionReplyDraftSchema = z.strictObject({
	id: z.uuid(),
	body: z.string().min(1).max(6_000),
	rationale: z
		.string()
		.min(1)
		.max(2_000)
		.describe("Why the drafting tedi proposed this reply"),
	drafterId: z.string().describe("The drafting tedi's id"),
	drafterName: z
		.string()
		.nullable()
		.describe(
			"The drafting tedi's display name; null when it cannot be resolved",
		),
	createdAt: z.string(),
	turnType: z
		.string()
		.nullable()
		.describe("The drafter's turn-type label; acceptance is measured per type"),
	delivery: z
		.enum(["review", "auto"])
		.describe(
			"`review`: waits for the user to accept, edit, or replace it; `auto`: the server judged it safe to send without review",
		),
	gate: AgentReplyDeliveryGateResultSchema.nullable()
		.optional()
		.describe(
			"Audit of the Clef delivery gate behind `delivery`; null when the gate was not reached",
		),
});
export type WorkInteractionReplyDraft = z.infer<
	typeof WorkInteractionReplyDraftSchema
>;

/**
 * Answer metadata convention for a response that started from a reply draft.
 * Clients write these keys into `respond_to_work_interaction.metadata`; draft
 * acceptance (`get_agent_reply_draft_acceptance`) is measured from them.
 */
export const WorkInteractionDraftAnswerMetadataSchema = z.object({
	draftId: z.uuid().describe("The `latestDraft.id` the answer started from"),
	draftOutcome: z
		.enum(["accepted", "edited", "replaced"])
		.describe(
			"`accepted`: sent unchanged; `edited`: sent after edits; `replaced`: the draft was discarded and the user wrote their own answer",
		),
	editRatio: z
		.number()
		.min(0)
		.max(1)
		.describe(
			"Normalized edit distance between draft and sent body: 0 unchanged, 1 fully rewritten",
		),
});
export type WorkInteractionDraftAnswerMetadata = z.infer<
	typeof WorkInteractionDraftAnswerMetadataSchema
>;

export const GetWorkInteractionResultSchema = z.strictObject({
	request: WorkInteractionRequestSchema,
	effectiveState: WorkInteractionStateSchema,
	canRespond: z.boolean(),
	canCancel: z.boolean(),
	latestDraft: WorkInteractionReplyDraftSchema.nullable()
		.optional()
		.describe(
			"Newest tedi-drafted reply proposal, or null when none exists. A `review` draft is never sent automatically: answer with respond_to_work_interaction and cite it in metadata {draftId, draftOutcome: accepted|edited|replaced, editRatio}. An `auto` draft may be sent without review.",
		),
	responses: z.strictObject({
		data: z.array(WorkInteractionResponseSchema),
		nextCursor: WorkInteractionCursorSchema.nullable().describe(
			"Null when the interaction has no further response page.",
		),
		hasMore: z.boolean(),
	}),
});

export const WorkInteractionInboxRowSchema = z.strictObject({
	request: WorkInteractionRequestSchema,
	effectiveState: WorkInteractionStateSchema,
	canRespond: z.boolean(),
	canCancel: z.boolean(),
	workItem: z
		.strictObject({
			id: z.uuid(),
			title: z.string(),
			projectId: z
				.uuid()
				.nullable()
				.describe("Nullable for Work Items that are not filed in a project."),
		})
		.nullable()
		.describe(
			"Null when the interaction is case- or project-scoped rather than Work Item-scoped.",
		),
	responseCount: z.number().int().nonnegative(),
});

export const ListWorkInteractionInboxInputSchema = z.strictObject({
	states: z
		.array(WorkInteractionStateSchema)
		.min(1)
		.max(4)
		.optional()
		.describe(
			"Optional state filter; omission includes every effective interaction state.",
		),
	kinds: z
		.array(WorkInteractionKindSchema)
		.min(1)
		.max(4)
		.optional()
		.describe(
			"Optional interaction-kind filter; omission includes every kind.",
		),
	workItemId: z
		.uuid()
		.optional()
		.describe("Optional Work Item filter for a scoped interaction inbox."),
	projectId: z
		.uuid()
		.optional()
		.describe("Optional project filter for a scoped interaction inbox."),
	urgency: WorkInteractionUrgencySchema.optional().describe(
		'Optional triage filter: "now" lists interactions triaged as needing a human now; "later" lists every other interaction, including untriaged ones. Omission includes both.',
	),
	cursor: WorkInteractionCursorSchema.optional().describe(
		"Opaque inbox continuation cursor; omit to read the newest page.",
	),
	limit: z.number().int().min(1).max(100).default(50),
});

export const ListWorkInteractionInboxResultSchema = z.strictObject({
	data: z.array(WorkInteractionInboxRowSchema),
	nextCursor: WorkInteractionCursorSchema.nullable().describe(
		"Null when the bounded interaction inbox has no further page.",
	),
	hasMore: z.boolean(),
	observedAt: z.iso.datetime(),
});

export const ListWorkInteractionCliInboxInputSchema =
	ListWorkInteractionInboxInputSchema.extend({
		states: z.array(z.literal("open")).length(1).default(["open"]),
		limit: z.number().int().min(1).max(5).default(5),
	});
export const WorkInteractionCliRequestSchema =
	WorkInteractionRequestSchema.omit({ metadata: true }).extend({
		prompt: z.string().max(800),
		promptComplete: z.boolean(),
	});
export const ListWorkInteractionCliInboxResultSchema =
	ListWorkInteractionInboxResultSchema.extend({
		data: z
			.array(
				WorkInteractionInboxRowSchema.extend({
					request: WorkInteractionCliRequestSchema,
					workItem: WorkInteractionInboxRowSchema.shape.workItem
						.unwrap()
						.extend({ title: z.string().max(500) })
						.nullable(),
				}),
			)
			.max(5),
	});
