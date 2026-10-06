import * as z from "zod";
const boundedNames = z
	.array(z.string().trim().min(1).max(200))
	.min(1)
	.max(50)
	.refine(
		(values) => new Set(values).size === values.length,
		"Duplicate permission",
	);
export const CreatePersonalResourceDelegationSchema = z
	.object({
		tediId: z.uuid(),
		skillId: z.uuid(),
		skillRevision: z.number().int().positive(),
		workspaceId: z.uuid(),
		resourceId: z.uuid(),
		connectionInstanceId: z.uuid(),
		operations: boundedNames,
		toolIds: boundedNames,
		expiresAt: z.iso.datetime({ offset: true }),
	})
	.strict();
export type CreatePersonalResourceDelegation = z.infer<
	typeof CreatePersonalResourceDelegationSchema
>;
export const PersonalResourceDelegationSchema =
	CreatePersonalResourceDelegationSchema.extend({
		id: z.uuid(),
		organizationId: z.uuid(),
		ownerUserId: z.string().min(1),
		providerId: z.string(),
		resourceType: z.string(),
		providerResourceId: z.string(),
		requiredScopes: z.array(z.string()),
		createdAt: z.string(),
		revokedAt: z.string().nullable(),
	}).strict();
