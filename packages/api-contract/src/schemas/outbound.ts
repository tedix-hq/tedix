import * as z from "zod";

export const OUTBOUND_SCHEMA = "tedix.outbound.v1";
export const OutboundSentExamplesSchema = z.object({
	samples: z
		.array(z.object({ id: z.string(), body: z.string().max(5_000) }))
		.max(10),
});

/** Only aggregate style measurements leave the personal sent-mail store. */
export function summarizeOutboundStyle(samples: { body: string }[]): string[] {
	if (!samples.length) return [];
	const average = (counts: number[]) =>
		Math.round(counts.reduce((sum, count) => sum + count, 0) / counts.length);
	return [
		`Observed across ${samples.length} sent emails: about ${average(samples.map((sample) => sample.body.trim().split(/\s+/).length))} words per email.`,
		`About ${average(samples.map((sample) => sample.body.split(/\n\s*\n/).filter((paragraph) => paragraph.trim()).length))} paragraphs per email.`,
		`${samples.filter((sample) => sample.body.includes("!")).length} of ${samples.length} examples use an exclamation mark.`,
	];
}

const text = z.string().trim().min(1);
export const OutboundDraftSchema = z.strictObject({
	channel: text.max(80),
	topic: text.max(100),
	recipient: text.max(500),
	subject: z.string().max(500).default(""),
	/** Markdown is the portable rich-text projection; raw HTML is never executed. */
	body: text.max(40_000),
	reasoning: text.max(8_000),
	sources: z
		.array(
			z.strictObject({
				uri: text.max(2_000),
				fact: text.max(2_000),
			}),
		)
		.max(40),
	risks: z.array(text.max(1_000)).max(30).default([]),
	providerDraftUrl: z
		.url()
		.refine((value) => new URL(value).protocol === "https:")
		.optional(),
});
export type OutboundDraft = z.infer<typeof OutboundDraftSchema>;

export const OutboundPolicySchema = z.strictObject({
	routes: z
		.array(
			z.strictObject({
				channel: text.max(80),
				topic: text.max(100).optional(),
				reviewerTediId: z.uuid(),
			}),
		)
		.max(100)
		.default([]),
	/** A provider identifier is configuration; it is never a credential or tenant fallback. */
	gmailProviderId: text.max(200).optional(),
});
export type OutboundPolicy = z.infer<typeof OutboundPolicySchema>;

export const OutboundReviewSchema = z.strictObject({
	draftRevision: z.number().int().positive(),
	verdict: z.enum(["ready", "changes_required", "blocked"]),
	notes: text.max(8_000),
	voice: text.max(4_000),
	grounding: text.max(4_000),
	risks: text.max(4_000),
	/** Proposed edits become the next draft and require review before approval. */
	editedBody: text.max(40_000).optional(),
});

export const OutboundStateSchema = z.strictObject({
	schema: z.literal(OUTBOUND_SCHEMA),
	draft: OutboundDraftSchema,
	draftRevision: z.number().int().positive(),
	author: z.strictObject({ type: text, id: text, sessionId: text.optional() }),
	ownerUserId: text,
	reviewerTediId: z.uuid(),
	interactionId: z.uuid(),
	status: z.enum([
		"reviewing",
		"waiting_on_you",
		"feedback",
		"approved_manual",
		"rejected",
		"sending",
		"sent",
		"send_unknown",
	]),
	review: OutboundReviewSchema.extend({
		reviewerTediId: z.uuid(),
		reviewedAt: z.string(),
	}).nullable(),
	providerReceipt: text.optional(),
	styleBefore: z.string().optional(),
});
export type OutboundState = z.infer<typeof OutboundStateSchema>;

export const OutboundRecordSchema = z.strictObject({
	workItemId: z.uuid(),
	projectId: z.uuid().nullable(),
	title: z.string(),
	version: z.number().int(),
	outbound: OutboundStateSchema,
});
export type OutboundRecord = z.infer<typeof OutboundRecordSchema>;

export const OutboundActionSchema = z.enum([
	"approve_manual",
	"approve_send",
	"edit",
	"feedback",
	"reject",
]);

export function chooseOutboundReviewer(
	policy: OutboundPolicy,
	draft: Pick<OutboundDraft, "channel" | "topic">,
): string | null {
	const routes = policy.routes.filter(
		(route) =>
			route.channel === draft.channel &&
			(!route.topic || route.topic === draft.topic),
	);
	return (
		routes.find((route) => route.topic === draft.topic)?.reviewerTediId ??
		routes.find((route) => !route.topic)?.reviewerTediId ??
		null
	);
}

export function reviewedOutbound(state: OutboundState): boolean {
	return (
		state.status === "waiting_on_you" &&
		state.review?.verdict === "ready" &&
		state.review.draftRevision === state.draftRevision &&
		state.review.reviewerTediId === state.reviewerTediId
	);
}
