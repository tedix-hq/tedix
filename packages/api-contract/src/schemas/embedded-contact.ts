import { z } from "zod";

const reserved = new Set([
	"__proto__",
	"constructor",
	"prototype",
	"organizationId",
	"providerOrganizationId",
	"installationId",
	"hostUserId",
	"externalTenantId",
	"permissions",
	"scopes",
	"role",
	"roles",
	"apiKey",
	"token",
]);
export const EmbeddedContactAttributesSchema = z
	.record(
		z
			.string()
			.regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
			.refine(
				(key) => !reserved.has(key),
				"Reserved identity or authorization field",
			),
		z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]),
	)
	.refine((value) => Object.keys(value).length <= 50, "At most 50 attributes")
	.refine(
		(value) => new TextEncoder().encode(JSON.stringify(value)).length <= 8192,
		"Attributes must fit within 8 KiB",
	);
export type EmbeddedContactAttributes = z.infer<
	typeof EmbeddedContactAttributesSchema
>;
const NamePatch = z
	.string()
	.trim()
	.min(1)
	.max(300)
	.nullable()
	.optional()
	.describe("Omit to preserve; null clears the name.");
const AttributesPatch = EmbeddedContactAttributesSchema.nullable()
	.optional()
	.describe(
		"Omit to preserve; null clears all attributes; individual null values remove keys.",
	);
export const EmbeddedContactProfilePatchSchema = z.strictObject({
	user: z
		.strictObject({
			name: NamePatch,
			email: z
				.email()
				.max(320)
				.nullable()
				.optional()
				.describe("Omit to preserve; null clears email."),
			customAttributes: AttributesPatch,
		})
		.optional()
		.describe("Host-authenticated user fields; omit to preserve."),
	company: z
		.strictObject({ name: NamePatch, customAttributes: AttributesPatch })
		.optional()
		.describe("Host-authenticated company fields; omit to preserve."),
});
export type EmbeddedContactProfilePatch = z.infer<
	typeof EmbeddedContactProfilePatchSchema
>;
export const EmbeddedContactUserSchema = z.object({
	installationId: z.uuid(),
	externalTenantId: z.string(),
	hostUserId: z.string(),
	name: z
		.string()
		.nullable()
		.describe(
			"Null when the host has not supplied a name or explicitly cleared it.",
		),
	email: z
		.string()
		.nullable()
		.describe(
			"Null when the host has not supplied an email or explicitly cleared it.",
		),
	role: z
		.string()
		.nullable()
		.describe(
			"Optional host-facing role label, null when absent or cleared; grants no Tedix permissions.",
		),
	customAttributes: EmbeddedContactAttributesSchema,
	firstSeenAt: z.string(),
	lastSeenAt: z.string(),
});
export type EmbeddedContactUser = z.infer<typeof EmbeddedContactUserSchema>;
export const EmbeddedContactCompanySchema = z.object({
	installationId: z.uuid(),
	externalTenantId: z.string(),
	name: z
		.string()
		.nullable()
		.describe(
			"Null when the host has not supplied a name or explicitly cleared it.",
		),
	customAttributes: EmbeddedContactAttributesSchema,
	firstSeenAt: z
		.string()
		.nullable()
		.describe("Null until the host first identifies this company profile."),
	lastSeenAt: z
		.string()
		.nullable()
		.describe(
			"Null until the host identifies this company profile; independent of chat usage.",
		),
});
export type EmbeddedContactCompany = z.infer<
	typeof EmbeddedContactCompanySchema
>;
export const EmbeddedContactIdentitySchema = z.object({
	installationId: z.uuid(),
	user: EmbeddedContactUserSchema,
	company: EmbeddedContactCompanySchema,
});
export type EmbeddedContactIdentity = z.infer<
	typeof EmbeddedContactIdentitySchema
>;
