import * as z from "zod";
import { AgentSessionRequestSchema } from "./agent-session-requests";
import { JsonValueSchema } from "./common";
export const AttentionColumnSchema = z.enum([
	"moving",
	"waiting",
	"blocked",
	"done",
	"backlog",
]);
export const AttentionCardSchema = z.strictObject({
	id: z.string(),
	who: z.string(),
	title: z.string(),
	projectId: z.string().nullable(),
	column: AttentionColumnSchema,
	startedAt: z.string(),
	heartbeatAt: z.string().nullable(),
	note: z.string(),
	href: z.string(),
	activitySource: z
		.enum([
			"local_claude",
			"local_codex",
			"cloud_tedi",
			"factory",
			"coordinator",
			"unknown",
		])
		.optional(),
	finishedAt: z.string().nullable().optional(),
	tediName: z.string().nullable().optional(),
	factoryName: z.string().nullable().optional(),
	workspaceId: z.string().nullable().optional(),
	source: z.enum([
		"attempt",
		"session",
		"reported_lane",
		"interaction",
		"skill",
		"run",
		"backlog",
	]),
});
export const AttentionInputSchema = z.strictObject({
	workspaceId: z.string().optional(),
	utcOffsetMinutes: z.number().int().min(-840).max(840).default(0),
});
export const ContinuityPolicySchema = z.object({
	idleHours: z.number().min(0.25).max(720).default(24),
	coordinatorTediId: z.string().min(1).max(200).optional(),
	cadence: z
		.object({
			everyHours: z.number().min(1).max(720),
			minResults: z.number().int().min(1).max(1000).default(1),
			description: z.string().min(1).max(240),
		})
		.optional(),
});
export const ProjectMetadataSchema = z
	.object({ continuity: ContinuityPolicySchema.optional() })
	.catchall(JsonValueSchema);

export const StallSchema = z.strictObject({
	scopeId: z.string(),
	name: z.string(),
	cause: z.string(),
	reason: z.string(),
	href: z.string(),
	requestedAt: z.string(),
	needsYou: z.boolean(),
});
export const CadencePromiseSchema = z.strictObject({
	scopeId: z.string(),
	name: z.string(),
	href: z.string(),
	description: z.string(),
	status: z.enum(["kept", "missed"]),
	delivered: z.number(),
	required: z.number(),
	start: z.string(),
	end: z.string(),
});
export const ContinuityPageSchema = z.strictObject({
	stalls: z.array(StallSchema),
	promises: z.array(CadencePromiseSchema),
	next: z.string().nullable(),
});
export const AttentionResultSchema = z.strictObject({
	stalls: z.array(StallSchema).optional(),
	cadencePromises: z.array(CadencePromiseSchema).optional(),
	cards: z.array(AttentionCardSchema),
	projects: z.array(
		z.strictObject({
			id: z.string(),
			name: z.string(),
			status: z.string(),
			objectiveId: z.string().nullable().optional(),
			active: z.number(),
			recent: z.number(),
			lastAttentionAt: z.string().nullable().optional(),
		}),
	),
	unfiled: z.array(AgentSessionRequestSchema),
	automaticFilingEnabled: z.boolean().optional(),
	pendingFilingCount: z.number().int().nonnegative().optional(),
	filings: z
		.array(
			z.strictObject({
				id: z.string(),
				text: z.string(),
				projectId: z.string().nullable(),
				previousProjectId: z.string().nullable(),
				by: z.enum(["auto", "correction"]),
				confidence: z.number(),
				reason: z.string(),
				at: z.string(),
				review: z.boolean(),
			}),
		)
		.optional(),
	filingDigest: z
		.strictObject({
			since: z.string(),
			total: z.number(),
			corrected: z.number(),
			correctionRate: z.number().nullable(),
		})
		.optional(),
	emptyAutoCreated: z
		.array(
			z.strictObject({
				id: z.string(),
				name: z.string(),
				kind: z.enum(["project", "workspace"]),
			}),
		)
		.optional(),
	unattendedObjectives: z
		.array(
			z.strictObject({
				id: z.string(),
				title: z.string(),
				lastAttentionAt: z.string().nullable().optional(),
			}),
		)
		.optional(),
	truncated: z.boolean(),
});
export type AttentionResult = z.infer<typeof AttentionResultSchema>;
