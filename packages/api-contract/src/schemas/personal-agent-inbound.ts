import * as z from "zod";

export const PersonalAgentEnrollmentSchema = z.strictObject({
	id: z.uuid(),
	orgId: z.uuid(),
	representedUserId: z.string().min(1).max(300),
	sourceAgentName: z.string().trim().min(1).max(100),
	projectId: z.uuid(),
	secretName: z.string().min(1),
	active: z.boolean(),
	delivery: z
		.strictObject({
			workComment: z.literal(true),
			email: z
				.strictObject({ memberId: z.uuid(), senderAddressId: z.uuid() })
				.nullable(),
		})
		.optional(),
	createdAt: z.iso.datetime(),
});
export type PersonalAgentEnrollment = z.infer<
	typeof PersonalAgentEnrollmentSchema
>;

export const PersonalAgentFindingSchema = z.strictObject({
	externalFindingId: z.string().trim().min(1).max(200),
	title: z.string().trim().min(1).max(200),
	body: z.string().trim().min(1).max(8000),
	evidenceUrl: z
		.url()
		.max(2000)
		.refine((url) => url.startsWith("https://")),
	kind: z.enum(["proposal", "fyi"]),
});
export type PersonalAgentFinding = z.infer<typeof PersonalAgentFindingSchema>;

/** Server-stamped enrollment provenance, separate from the represented person. */
export const PersonalAgentContributionSchema = z.strictObject({
	sourceAgentId: z.uuid(),
	sourceAgentName: z.string(),
	representedUserId: z.string(),
	sourceChannel: z.enum(["browser_form", "webhook"]),
	capturedAt: z.iso.datetime(),
	evidenceUrl: z.url(),
	externalFindingId: z.string(),
	kind: z.enum(["proposal", "fyi"]),
});
export type PersonalAgentContribution = z.infer<
	typeof PersonalAgentContributionSchema
>;

export const PersonalAgentReceiptSchema = z.strictObject({
	workItemId: z.uuid(),
	externalFindingId: z.string(),
	capturedAt: z.iso.datetime(),
	duplicate: z.boolean(),
	disposition: z.literal("proposed"),
});

export const PersonalAgentOutcomeSchema = z.strictObject({
	id: z.string(),
	sourceAgentId: z.uuid(),
	externalFindingId: z.string(),
	workItemId: z.uuid(),
	interactionId: z.uuid(),
	responseId: z.uuid(),
	decision: z.string(),
	option: z.string().nullable(),
	decidedBy: z.string(),
	decidedAt: z.iso.datetime(),
	sourceVersion: z.number().int(),
	correctsResponseId: z.string().nullable(),
	supersedes: z.string().nullable(),
	execution: z.strictObject({
		state: z.enum(["unverified", "verified", "corroborated", "contradicted"]),
		evidenceId: z.string().nullable(),
		evidenceUri: z.string().nullable(),
		evidenceVersion: z.string().nullable(),
		observationSource: z.string().nullable(),
		observerType: z.string().nullable(),
		observerId: z.string().nullable(),
		verificationId: z.string().nullable(),
		observedAt: z.string().nullable(),
	}),
	recordedAt: z.iso.datetime(),
});
export type PersonalAgentOutcome = z.infer<typeof PersonalAgentOutcomeSchema>;

export const PersonalAgentValueSchema = z.strictObject({
	sourceAgentId: z.uuid(),
	sourceAgentName: z.string(),
	windowStart: z.iso.datetime(),
	windowEnd: z.iso.datetime(),
	findings: z.number(),
	decisionFindings: z.number(),
	decisionCards: z.number(),
	fyiFindings: z.number(),
	decidedFromCard: z.number(),
	decidedFromCardPercent: z.number().nullable(),
	outcomes: z.number(),
	verifiedOutcomes: z.number(),
	corroboratedOutcomes: z.number(),
	emailsSent: z.number(),
	acknowledgedOutcomes: z.number(),
	agentReportedReminderRetirements: z.number(),
	remindersAvoided: z.null(),
	historicalChatBaseline: z.null(),
});
