import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import {
	CardTextSchema,
	KeptCardHunkSchema,
	CardFeedbackAnchorSchema,
} from "../schemas/card-revisions";
import { baseErrors } from "../errors";
import { CARD_SECRET_MESSAGE, containsCardSecret } from "../utils/card-secrets";
import {
	OutboundActionSchema,
	OutboundDraftSchema,
	OutboundPolicySchema,
	OutboundRecordSchema,
	OutboundReviewSchema,
} from "../schemas/outbound";

const identity = z.strictObject({ workItemId: z.uuid() });
const revision = identity.extend({
	expectedVersion: z.number().int().positive(),
});

export const outboundContract = oc.errors(baseErrors).router({
	accounts: oc
		.route({ tags: ["internal"] })
		.input(z.strictObject({}))
		.output(z.array(z.strictObject({ id: z.uuid(), label: z.string() }))),
	get: oc.input(identity).output(OutboundRecordSchema),
	checkOutcome: oc
		.route({ tags: ["internal"] })
		.input(identity)
		.output(
			z.object({
				status: z.enum(["unknown", "waiting", "replied"]),
				receipt: z.string().nullable(),
			}),
		),
	list: oc
		.input(
			z.strictObject({
				projectId: z.uuid().optional(),
				limit: z.number().int().min(1).max(100).default(50),
			}),
		)
		.output(z.array(OutboundRecordSchema)),
	policy: oc.input(z.strictObject({})).output(OutboundPolicySchema),
	configure: oc.input(OutboundPolicySchema).output(OutboundPolicySchema),
	submit: oc
		.input(
			revision.extend({
				ownerUserId: z.string().min(1),
				draft: OutboundDraftSchema,
				interactionId: z.uuid().optional(),
			}),
		)
		.output(OutboundRecordSchema),
	review: oc
		.input(revision.extend({ review: OutboundReviewSchema }))
		.output(OutboundRecordSchema),
	requestReview: oc.input(revision).output(OutboundRecordSchema),
	act: oc
		.route({ tags: ["internal"] })
		.input(
			revision
				.extend({
					action: OutboundActionSchema,
					elapsedMs: z.number().int().min(0).max(86400000).optional(),
					draft: OutboundDraftSchema.optional(),
					body: z.string().trim().min(1).max(40_000).optional(),
					summary: CardTextSchema.max(1000).optional(),
					chips: z.array(CardTextSchema.max(80)).max(3).optional(),
					anchors: z.array(CardFeedbackAnchorSchema).max(20).optional(),
					keptHunks: z.array(KeptCardHunkSchema).max(100).optional(),
					restoreRevision: z.number().int().positive().optional(),
					feedback: z.string().trim().min(1).max(8_000).optional(),
					connectionInstanceId: z.uuid().optional(),
				})
				.refine(
					(value) =>
						!containsCardSecret([value.body, value.feedback, value.draft]),
					CARD_SECRET_MESSAGE,
				),
		)
		.output(OutboundRecordSchema),
	importSentStyle: oc
		.route({ tags: ["internal"] })
		.input(z.strictObject({ connectionInstanceId: z.uuid() }))
		.output(z.strictObject({ imported: z.number() })),
	profile: oc
		.route({ tags: ["internal"] })
		.input(z.strictObject({}))
		.output(
			z.strictObject({
				approvals: z.array(
					z.strictObject({
						id: z.string(),
						action: z.string(),
						before: z.string(),
						after: z.string(),
						feedback: z.string().nullable(),
						at: z.string(),
					}),
				),
				decisionCount: z.number().int().nonnegative(),
				preferences: z.array(z.string()),
				lessons: z.array(z.string()),
				sentExamples: z.number(),
				sentStyleHints: z.array(z.string()),
			}),
		),
});
