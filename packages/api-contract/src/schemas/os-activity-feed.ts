import * as z from "zod";
import { WorkActorReferenceSchema } from "./os-work-actor";
import { CardReviewSourceSchema } from "./os-card-review";
import { DecisionEnvelopeSchema } from "./os-decision-deck";

export const ACTIVITY_FEED_ENTRY = "tedix:app/activity-feed";
export const ActivityFeedKindSchema = z.enum([
	"work",
	"result",
	"approval",
	"decision",
	"correction",
	"signal",
]);
export const ActivityFeedReactionSchema = z.enum([
	"more",
	"why",
	"mute",
	"comment",
	"work",
]);

/** A projection of a canonical record, never a second execution ledger. */
export const ActivityFeedItemSchema = z.strictObject({
	id: z.string().min(1),
	actor: z.string().min(1),
	actorIdentity: WorkActorReferenceSchema.optional(),
	sentence: z.string().min(1).max(1000),
	source: z.string().min(1).max(2000),
	projectId: z.uuid().nullable(),
	tediId: z.uuid().nullable(),
	workItemId: z.uuid().nullable(),
	kind: ActivityFeedKindSchema,
	classId: z.string().min(1).max(100),
	importance: z.enum(["low", "normal", "high", "critical"]),
	at: z.iso.datetime(),
	dueAt: z.iso.datetime().nullable(),
	needsAction: z.boolean(),
	stalled: z.boolean(),
	done: z.boolean(),
	explanation: z.string(),
	reactions: z.array(ActivityFeedReactionSchema).max(5),
	attachment: z
		.strictObject({
			title: z.string().min(1).max(200),
			summary: z.string().max(300).optional(),
		})
		.optional(),
	decision: DecisionEnvelopeSchema.optional(),
});
export type ActivityFeedItem = z.infer<typeof ActivityFeedItemSchema>;

export const ActivityFeedConfigSchema = z
	.strictObject({
		version: z.literal(1),
		scope: z.enum(["projects", "organization"]).optional(),
		today: z
			.strictObject({
				outputId: z.uuid(),
				skillId: z.uuid(),
				tediId: z.uuid(),
				personId: z.string().min(1).max(300),
				timeZone: z.string().min(1).default("UTC"),
			})
			.optional(),
		factorySources: z
			.array(
				z.strictObject({ projectId: z.uuid(), source: CardReviewSourceSchema }),
			)
			.max(10)
			.default([]),
		projects: z
			.array(
				z.strictObject({ id: z.uuid(), label: z.string().min(1).max(100) }),
			)
			.max(20),
		pageSize: z.number().int().min(5).max(50).default(20),
		attentionBudget: z.number().int().min(1).max(100).default(10),
		digestBelow: z.enum(["low", "normal"]).default("low"),
		quietHours: z
			.strictObject({
				start: z.number().int().min(0).max(23),
				end: z.number().int().min(0).max(23),
			})
			.optional(),
		deckUrl: z
			.string()
			.regex(/^\/workspace\//)
			.optional(),
		weights: z
			.strictObject({
				importance: z.number().min(0).max(100),
				action: z.number().min(0).max(100),
				deadline: z.number().min(0).max(100),
				unseen: z.number().min(0).max(100),
				preference: z.number().min(0).max(100),
			})
			.default({
				importance: 10,
				action: 25,
				deadline: 30,
				unseen: 8,
				preference: 5,
			}),
	})
	.refine(
		(config) => config.scope === "organization" || config.projects.length > 0,
		{
			message: "Choose at least one project or use organization scope",
			path: ["projects"],
		},
	);
export type ActivityFeedConfig = z.infer<typeof ActivityFeedConfigSchema>;
