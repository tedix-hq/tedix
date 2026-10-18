import * as z from "zod";

export const SessionFeedbackCandidateSchema = z.strictObject({
	text: z.string().trim().min(6).max(300),
	quote: z.string().trim().min(6).max(280),
	sessionKey: z.string().min(1).max(200),
	occurredAt: z.string().datetime(),
	harness: z.string().min(1).max(40),
	repository: z.string().max(300).optional(),
	projectId: z.string().uuid().optional(),
	kind: z.enum(["correction", "preference", "project"]),
	sourceFile: z.string().max(500).optional(),
	sourceHash: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
});
export type SessionFeedbackCandidate = z.infer<
	typeof SessionFeedbackCandidateSchema
>;
export const RecordSessionFeedbackInputSchema = z
	.strictObject({
		candidates: z.array(SessionFeedbackCandidateSchema).min(1).max(8),
	})
	.refine(
		(input) =>
			new Set(
				input.candidates.map((candidate) => candidate.repository ?? "general"),
			).size === 1,
		"A feedback batch belongs to one repository",
	);
export const RecordSessionFeedbackResultSchema = z.object({
	lessons: z.array(
		z.object({
			id: z.string(),
			text: z.string(),
			status: z.enum(["confirmed", "pending", "duplicate"]),
		}),
	),
});
