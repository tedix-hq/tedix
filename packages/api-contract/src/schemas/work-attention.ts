import * as z from "zod";
import { AgentSessionRequestSchema } from "./agent-session-requests";
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
	source: z.enum([
		"attempt",
		"session",
		"reported_lane",
		"skill",
		"run",
		"backlog",
	]),
});
export const AttentionInputSchema = z.strictObject({
	utcOffsetMinutes: z.number().int().min(-840).max(840).default(0),
});
export const AttentionResultSchema = z.strictObject({
	cards: z.array(AttentionCardSchema),
	projects: z.array(
		z.strictObject({
			id: z.string(),
			name: z.string(),
			status: z.string(),
			active: z.number(),
			recent: z.number(),
		}),
	),
	unfiled: z.array(AgentSessionRequestSchema),
	unattendedObjectives: z
		.array(z.strictObject({ id: z.string(), title: z.string() }))
		.optional(),
	truncated: z.boolean(),
});
export type AttentionResult = z.infer<typeof AttentionResultSchema>;
