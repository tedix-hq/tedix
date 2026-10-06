import * as z from "zod";
import { JsonValueSchema } from "./common";
import {
	CategorySchema,
	ConnectorTypeSchema,
	DeveloperTypeSchema,
	SourceSchema,
} from "./catalog";

const optionalText = z
	.string()
	.nullable()
	.optional()
	.describe("May be absent when the supplier does not publish this metadata.");
const optionalStrings = z
	.array(z.string())
	.nullable()
	.optional()
	.describe("May be absent when the supplier does not publish this metadata.");
/** Normalized store input. Supplier-specific fields belong in rawData. */
export const CatalogSnapshotItemSchema = z.strictObject({
	source: SourceSchema,
	sourceAppId: z.string().min(1),
	sourceCreatedAt: optionalText,
	name: z.string().min(1),
	description: optionalText,
	modelDescription: optionalText,
	baseUrl: optionalText,
	connectorType: ConnectorTypeSchema,
	distributionChannel: z
		.enum(["ECOSYSTEM_DIRECTORY", "DEFAULT_OAI_CATALOG", "INDIVIDUAL"])
		.nullable()
		.optional()
		.describe(
			"May be absent when the supplier does not publish this metadata.",
		),
	developerType: DeveloperTypeSchema,
	status: z
		.enum(["ENABLED", "DISABLED"])
		.optional()
		.describe(
			"May be absent when the supplier does not publish this metadata.",
		),
	category: CategorySchema.nullable()
		.optional()
		.describe(
			"May be absent when the supplier does not publish this metadata.",
		),
	developer: optionalText,
	website: optionalText,
	privacyPolicy: optionalText,
	termsOfService: optionalText,
	logoUrl: optionalText,
	logoUrlDark: optionalText,
	service: optionalText,
	version: optionalText,
	versionId: optionalText,
	versionNotes: optionalText,
	seoDescription: optionalText,
	screenshots: optionalStrings,
	categories: optionalStrings,
	subCategories: optionalStrings,
	hasWrites: z
		.boolean()
		.optional()
		.describe(
			"May be absent when the supplier does not publish this metadata.",
		),
	hasInteractive: z
		.boolean()
		.optional()
		.describe(
			"May be absent when the supplier does not publish this metadata.",
		),
	hasFileSearch: z
		.boolean()
		.optional()
		.describe(
			"May be absent when the supplier does not publish this metadata.",
		),
	hasDeepResearch: z
		.boolean()
		.optional()
		.describe(
			"May be absent when the supplier does not publish this metadata.",
		),
	hasSync: z
		.boolean()
		.optional()
		.describe(
			"May be absent when the supplier does not publish this metadata.",
		),
	authTypes: z
		.array(z.enum(["NONE", "OAUTH", "API_KEY"]))
		.nullable()
		.optional()
		.describe(
			"May be absent when the supplier does not publish this metadata.",
		),
	authRequired: z
		.boolean()
		.optional()
		.describe(
			"May be absent when the supplier does not publish this metadata.",
		),
	isDiscoverable: z
		.boolean()
		.optional()
		.describe(
			"May be absent when the supplier does not publish this metadata.",
		),
	keywordsForDiscovery: optionalStrings,
	keywordsForTriggering: optionalStrings,
	regions: optionalStrings,
	storeUrl: optionalText,
	reviewStatus: z
		.enum(["PENDING", "REJECTED", "RELEASED"])
		.nullable()
		.optional()
		.describe(
			"May be absent when the supplier does not publish this metadata.",
		),
	supportsFullActions: z
		.boolean()
		.nullable()
		.optional()
		.describe(
			"May be absent when the supplier does not publish this metadata.",
		),
	safetyStatus: optionalText,
	systemHints: z
		.strictObject({ tierLevel: optionalText })
		.nullable()
		.optional()
		.describe(
			"May be absent when the supplier does not publish this metadata.",
		),
	richContent: z
		.strictObject({ serverLabel: optionalText, publishedAt: optionalText })
		.nullable()
		.optional()
		.describe(
			"May be absent when the supplier does not publish this metadata.",
		),
	rawData: z
		.record(z.string(), JsonValueSchema)
		.nullable()
		.optional()
		.describe(
			"May be absent when the supplier does not publish this metadata.",
		),
});

export const CatalogSnapshotSchema = z
	.strictObject({
		expectedSourceCount: z.number().int().positive(),
		capturedSourceCount: z.number().int().positive(),
		items: z.array(CatalogSnapshotItemSchema).min(1).max(20_000),
	})
	.superRefine((value, ctx) => {
		if (value.expectedSourceCount !== value.capturedSourceCount)
			ctx.addIssue({ code: "custom", message: "Source capture is incomplete" });
		const ids = new Set<string>();
		for (const item of value.items) {
			const key = JSON.stringify([item.source, item.sourceAppId]);
			if (ids.has(key))
				ctx.addIssue({
					code: "custom",
					message: `Duplicate store listing: ${key}`,
				});
			ids.add(key);
		}
	});

export const ImportCatalogSnapshotInputSchema = z.strictObject({
	snapshotId: z
		.uuid()
		.describe("Stable idempotency key for this captured snapshot."),
	feed: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
	url: z.url().max(2048),
	expression: z
		.string()
		.min(1)
		.max(100_000)
		.describe(
			"JavaScript expression executed only in a fresh browser page. Must return expectedSourceCount, capturedSourceCount, and normalized items. Network is restricted to the page origin.",
		),
	provenanceKey: z
		.string()
		.regex(/^[a-z][a-zA-Z0-9_]{0,63}$/)
		.describe(
			"Object key in listing rawData identifying this feed. Removal only reconciles listings bearing this provenance.",
		),
	removalSources: z.array(SourceSchema).max(10).default([]),
});
export const ImportCatalogSnapshotOutputSchema = z.strictObject({
	success: z.literal(true),
	syncLogId: z.uuid(),
	workflowInstanceId: z.string(),
	snapshotKey: z.string(),
	capturedSourceCount: z.number().int(),
	listingsCount: z.number().int(),
});
export type CatalogSnapshot = z.infer<typeof CatalogSnapshotSchema>;
