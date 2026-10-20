import * as z from "zod";

/**
 * One metric tile, honest by construction.
 *
 * A tile is either MEASURED — a value that must state the window it covers and
 * the source the number came from — or EMPTY, which names why no number
 * exists and optionally links to the setup path. There is no third state:
 * the schema cannot express a bare figure with no provenance, so a renderer
 * that honours this contract can never show a made-up or zero-as-unknown
 * number.
 */
export const MetricTileMeasuredSchema = z.strictObject({
	state: z.literal("measured"),
	label: z.string().min(1).max(160),
	value: z.string().min(1).max(240),
	/** The window the figure covers, in words: "today", "last 7 days", "Sep 1 – Oct 1". */
	window: z.string().min(1).max(240),
	/** Where the number came from, in words: "run ledger", "deck events". */
	source: z.string().min(1).max(240),
	/** Extra measured context rendered beside the provenance caption. */
	qualifier: z.string().max(500).optional(),
	/** Optional drill-down destination for the value. */
	href: z.string().min(1).max(500).optional(),
});
export const MetricTileEmptySchema = z.strictObject({
	state: z.literal("empty"),
	label: z.string().min(1).max(160),
	/** Why no number exists — stated, never implied by a zero or a dash. */
	emptyReason: z.string().min(1).max(500),
	/** Where to go to start measuring; absent when nothing is setup-shaped. */
	setupHref: z.string().min(1).max(500).optional(),
	setupLabel: z.string().min(1).max(160).optional(),
});
export const MetricTileSchema = z.discriminatedUnion("state", [
	MetricTileMeasuredSchema,
	MetricTileEmptySchema,
]);
export type MetricTileMeasured = z.infer<typeof MetricTileMeasuredSchema>;
export type MetricTileEmpty = z.infer<typeof MetricTileEmptySchema>;
export type MetricTile = z.infer<typeof MetricTileSchema>;
