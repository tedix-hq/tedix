import * as z from "zod";

export const PersonalAgentEnrollmentSchema = z.strictObject({
	id: z.uuid(),
	orgId: z.uuid(),
	representedUserId: z.string().min(1).max(300),
	sourceAgentName: z.string().trim().min(1).max(100),
	projectId: z.uuid(),
	secretName: z.string().min(1),
	active: z.boolean(),
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
