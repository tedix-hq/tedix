import { z } from "zod";

export const CommitAliasCountLocationSchema = z.enum([
	"work_attempts.metadata",
	"work_items.metadata",
	"kernel_requests.snapshot",
	"external_agent_attributions.target_id",
	"external_agent_review_evidence",
	"learning_interaction_events.metadata",
	"work_interactions.metadata",
	"work_item_comments.metadata",
	"work_interaction_card_revisions.proposal",
]);
const count = z.number().int().nonnegative();
export const CommitAliasCountCursorSchema = z.strictObject({
	runId: z.uuid(),
	repository: z.string().min(1).max(300),
	location: CommitAliasCountLocationSchema,
	store: z.string().regex(/^(main|LOGS_DB(?:_\d+)?)$/),
	after: z.string().max(300),
	scanned: count,
	locked: count,
	unlocked: count,
});
export const CommitAliasCountInputSchema = z.strictObject({
	repository: z.string().min(1).max(300),
	quietHoursUtc: z
		.strictObject({
			start: z.number().int().min(0).max(23),
			end: z.number().int().min(0).max(23),
		})
		.refine((hours) => hours.start !== hours.end),
	cursor: CommitAliasCountCursorSchema.optional(),
});
export const CommitAliasCountOutputSchema = z.strictObject({
	status: z.enum(["no_aliases", "continue", "complete"]),
	cursor: CommitAliasCountCursorSchema.nullable(),
	location: CommitAliasCountLocationSchema,
	store: z.string(),
	locationComplete: z.boolean(),
	scanned: count,
	locked: count,
	unlocked: count,
	inFlightAttemptIds: z.array(z.string()).max(200),
	openObserverWorkItemIds: z.array(z.string()).max(200),
});
export type CommitAliasCountCursor = z.infer<
	typeof CommitAliasCountCursorSchema
>;
export type CommitAliasCountInput = z.infer<typeof CommitAliasCountInputSchema>;
