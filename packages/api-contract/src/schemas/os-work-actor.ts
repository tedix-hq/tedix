import * as z from "zod";

/** Stored in external_agent_principals.metadata by identity governance, not post authors. */
export const PersonalAgentIdentitySchema = z.strictObject({
	version: z.literal(1),
	representedUserId: z.string().min(1).max(200),
	imageUrl: z
		.url()
		.refine((url) => url.startsWith("https://"))
		.optional(),
});

/** Inbound adapters supply source facts separately from the authenticated submitting actor. */
export const WorkContributionSourceSchema = z.strictObject({
	channel: z.string().min(1).max(100),
	capturedAt: z.iso.datetime(),
	evidenceUrl: z
		.string()
		.min(1)
		.max(2000)
		.refine(
			(url) =>
				/^https:\/\/[^\s\\]+$/.test(url) || /^\/(?!\/)[^\s\\]*$/.test(url),
		),
	externalFindingId: z.string().min(1).max(300).optional(),
});
export type WorkContributionSource = z.infer<
	typeof WorkContributionSourceSchema
>;

/** Display provenance only; never execution authority. */
export const WorkActorReferenceSchema = z.object({
	type: z.string(),
	id: z.string().nullable().optional(),
	harness: z.string().nullable().optional(),
	source: WorkContributionSourceSchema.optional(),
	/** Only populate from a server-verified enrollment projection, never record metadata. */
	contributor: z
		.strictObject({
			id: z.uuid(),
			displayName: z.string().min(1).max(200),
			representedUserId: z.string().min(1).max(300),
			imageUrl: z
				.url()
				.refine((url) => url.startsWith("https://"))
				.optional(),
		})
		.optional(),
});
export type WorkActorReference = z.infer<typeof WorkActorReferenceSchema>;
