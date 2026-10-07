/**
 * Platform-operator maintenance of cross-app references.
 *
 * Apps link to each other through `metadata.mcpConfig.aggregateApps` entries
 * (`{ slug, appId?, prefix?, connectionProviderId? }`) and to Descope outbound
 * apps through connection-provider ids. These procedures repair those links
 * across organizations. Every mutation is a dry run unless `dryRun: false`, and
 * every response is the exact per-row plan the apply step writes.
 */

import { SURFACE_SLUG_PATTERN } from "@tedix/tenant-directory";
import * as z from "zod";

const dryRun = z
	.boolean()
	.default(true)
	.describe(
		"Defaults to true: compute and return the plan without writing. Pass false to apply exactly the returned plan.",
	);

const organizationIdFilter = z
	.string()
	.min(1)
	.optional()
	.describe("Omit to scan every organization.");

/** One field change on one persisted row. */
export const AppReferenceChangeSchema = z.object({
	recordType: z
		.enum(["app", "catalog_app", "app_tool"])
		.describe(
			"app = apps row, catalog_app = app_catalog row, app_tool = app_tools row.",
		),
	recordId: z.string(),
	appId: z
		.string()
		.nullable()
		.describe("Owning app id; null for catalog rows."),
	organizationId: z
		.string()
		.nullable()
		.describe(
			"Owning organization; for catalog rows the scan organization, which may be null.",
		),
	field: z
		.string()
		.describe(
			"Dotted path of the changed field, e.g. metadata.mcpConfig.aggregateApps[2].appId.",
		),
	before: z.string().nullable(),
	after: z.string().nullable(),
});
export type AppReferenceChange = z.infer<typeof AppReferenceChangeSchema>;

/** An aggregate entry whose slug the gateway cannot resolve to exactly one app. */
export const UnresolvedAggregateEntrySchema = z.object({
	appId: z.string().describe("App holding the aggregate entry."),
	organizationId: z.string(),
	list: z.enum(["aggregateApps", "inactiveAggregateApps"]),
	index: z.number().int(),
	slug: z.string().nullable(),
	reason: z.enum(["not_found", "ambiguous", "invalid_entry"]),
	candidates: z
		.array(z.object({ appId: z.string(), organizationId: z.string() }))
		.describe("Every app carrying the slug; empty when not found."),
});
export type UnresolvedAggregateEntry = z.infer<
	typeof UnresolvedAggregateEntrySchema
>;

export const BackfillAggregateAppIdsInputSchema = z.object({
	organizationId: organizationIdFilter,
	dryRun,
});
export type BackfillAggregateAppIdsInput = z.infer<
	typeof BackfillAggregateAppIdsInputSchema
>;

export const BackfillAggregateAppIdsOutputSchema = z.object({
	dryRun: z.boolean(),
	applied: z.boolean(),
	scannedApps: z.number().int(),
	changes: z.array(AppReferenceChangeSchema),
	unresolved: z.array(UnresolvedAggregateEntrySchema),
});
export type BackfillAggregateAppIdsOutput = z.infer<
	typeof BackfillAggregateAppIdsOutputSchema
>;

export const RenameAppSlugInputSchema = z.object({
	appId: z.uuid(),
	newSlug: z
		.string()
		.min(1)
		.max(100)
		.regex(
			SURFACE_SLUG_PATTERN,
			"Slug must be lowercase alphanumeric with hyphens, no leading/trailing hyphens",
		),
	preserveToolPrefix: z
		.boolean()
		.default(true)
		.describe(
			"Defaults to true: a linking entry without a prefix gets prefix = old slug, so its tool names stay stable.",
		),
	dryRun,
});
export type RenameAppSlugInput = z.infer<typeof RenameAppSlugInputSchema>;

export const RenameAppSlugOutputSchema = z.object({
	dryRun: z.boolean(),
	applied: z.boolean(),
	appId: z.string(),
	organizationId: z.string(),
	fromSlug: z.string(),
	toSlug: z.string(),
	changes: z.array(AppReferenceChangeSchema),
	blockers: z
		.array(UnresolvedAggregateEntrySchema)
		.describe(
			"Linking entries without appId whose slug is ambiguous. Apply is refused while any remain.",
		),
});
export type RenameAppSlugOutput = z.infer<typeof RenameAppSlugOutputSchema>;

export const RelinkConnectionProviderInputSchema = z
	.object({
		from: z.string().min(1).describe("Connection provider id to replace."),
		to: z
			.string()
			.min(1)
			.describe("Existing Descope outbound app id that replaces it."),
		organizationId: organizationIdFilter,
		dryRun,
	})
	.refine((input) => input.from !== input.to, {
		message: "from and to must differ",
		path: ["to"],
	});
export type RelinkConnectionProviderInput = z.infer<
	typeof RelinkConnectionProviderInputSchema
>;

export const RelinkConnectionProviderOutputSchema = z.object({
	dryRun: z.boolean(),
	applied: z.boolean(),
	from: z.string(),
	to: z.string(),
	changes: z.array(AppReferenceChangeSchema),
});
export type RelinkConnectionProviderOutput = z.infer<
	typeof RelinkConnectionProviderOutputSchema
>;
