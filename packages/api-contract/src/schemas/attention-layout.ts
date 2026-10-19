import * as z from "zod";
const AttentionColumnSchema = z.enum([
	"moving",
	"waiting",
	"blocked",
	"done",
	"backlog",
]);

export const AttentionSourceSchema = z.enum([
	"local_claude",
	"local_codex",
	"local_devin",
	"cloud_tedi",
	"factory",
	"coordinator",
	"unknown",
]);
export const AttentionWidgetSchema = z.enum([
	"now",
	"contributions",
	"cards",
	"gaps",
	"unfiled",
]);
export const AttentionLayoutSchema = z.strictObject({
	version: z.literal(1).default(1),
	widgets: z
		.array(AttentionWidgetSchema)
		.max(5)
		.refine((v) => new Set(v).size === v.length)
		.default(["now", "contributions", "cards", "gaps", "unfiled"]),
	pinnedProjects: z.array(z.string().max(160)).max(50).default([]),
	hiddenColumns: z.array(AttentionColumnSchema).max(5).default([]),
	focusProjectId: z.string().max(160).nullable().default(null),
	focusToday: z.string().max(500).default(""),
	density: z.enum(["comfortable", "compact"]).default("comfortable"),
	sourceFilters: z.array(AttentionSourceSchema).max(6).default([]),
});
export const AttentionLayoutResultSchema = z.strictObject({
	layout: AttentionLayoutSchema,
	revision: z.number().int().nonnegative(),
});
export const UpdateAttentionLayoutInputSchema = z.strictObject({
	layout: AttentionLayoutSchema,
	expectedRevision: z.number().int().nonnegative(),
});
export const AttentionVisitResultSchema = z.strictObject({
	previousVisitAt: z.string().nullable(),
});
export type AttentionLayout = z.infer<typeof AttentionLayoutSchema>;
export const DEFAULT_ATTENTION_LAYOUT = AttentionLayoutSchema.parse({});
export const ATTENTION_LAYOUT_NAMESPACE = "work.attention.layout";
