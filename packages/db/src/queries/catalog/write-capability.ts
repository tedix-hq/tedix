/**
 * App Catalog Queries — unclassified write-capability report.
 *
 * The standing answer to "which tools has nobody classified?".
 *
 * `app_tools.write_capability` is three-state and NULL means UNDECLARED, which
 * every gate now treats as write-capable. That is the safe default, but a
 * default is not a backlog: without this report the undeclared set is invisible
 * and never shrinks. It rides the existing catalog-integrity workflow
 * (cron-fired from retention-cleanup, recorded to `workflow_runs`), so the count
 * lands in the ledger on every run and the per-tool detail comes back on the
 * operator-facing `POST /catalog/integrity/check` response.
 *
 * Deliberately scans `app_tools` DIRECTLY rather than the `app_catalog_mcp_tools`
 * snapshot every other integrity check uses: hand-seeded and template-instantiated
 * rows have no catalog snapshot at all, and those are precisely the rows most
 * likely to be unclassified.
 */

import {
	deriveToolWriteCapability,
	type ToolAnnotations,
} from "@tedix/api-contract/schemas/tools";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import { apps } from "../../schema/apps";
import { appTools } from "../../schema/tools";

/**
 * Why a tool is unclassified. Determines who can fix it and how:
 *
 * - `no_annotations`    the row carries no MCP annotations at all. Upstream
 *                       never sent any (Atlassian, Stripe, ...) — needs an
 *                       explicit declaration, a re-sync will not help.
 * - `inconclusive_annotations`
 *                       annotations exist but state nothing about mutation
 *                       (only `idempotentHint`/`openWorldHint`, or an empty
 *                       object). Also needs an explicit declaration.
 * - `stale_sync`        annotations DO state the answer but the column was
 *                       never populated. Re-syncing the app fixes it.
 */
export type UnclassifiedWriteCapabilityReason =
	| "no_annotations"
	| "inconclusive_annotations"
	| "stale_sync";

export interface UnclassifiedWriteCapabilityItem {
	appId: string;
	appSlug: string | null;
	appName: string;
	toolRowId: string;
	toolId: string;
	toolTypeId: string;
	schemaSource: string | null;
	enabled: boolean;
	reason: UnclassifiedWriteCapabilityReason;
	/** The capability a re-sync would derive, when `reason` is `stale_sync`. */
	derivable: "read" | "write" | "destructive" | null;
}

export interface UnclassifiedWriteCapabilityReport {
	checkedAt: string;
	/** Every tool row with a NULL declaration, enabled or not, regardless of `limit`. */
	totalTools: number;
	/** Distinct apps owning those rows. */
	totalApps: number;
	/** How many rows `items` actually carries. */
	listed: number;
	truncated: boolean;
	items: UnclassifiedWriteCapabilityItem[];
	summary: string;
}

export interface ReportUnclassifiedWriteCapabilityOptions {
	/** Max rows to enumerate. Counts are always exact. */
	limit?: number;
	appId?: string;
}

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

/** List every tool whose write capability nobody has declared. */
export async function reportUnclassifiedWriteCapability(
	db: DbClient,
	options: ReportUnclassifiedWriteCapabilityOptions = {},
): Promise<UnclassifiedWriteCapabilityReport> {
	const limit = Math.min(
		Math.max(options.limit ?? DEFAULT_LIMIT, 1),
		MAX_LIMIT,
	);
	// DELIBERATELY not filtered on `enabled`. The report's stated job is "every
	// currently unclassified tool", and a disabled row is one re-enable away
	// from being a live undeclared tool — excluding it made the backlog look
	// smaller than it is, which is the one thing a backlog report must not do.
	// `enabled` travels on each item instead, so a reader can triage without the
	// listing lying about its own size.
	const where = and(
		isNull(appTools.writeCapability),
		options.appId ? eq(appTools.appId, options.appId) : undefined,
	);

	// Exact totals first — `items` is bounded by `limit`, the counts are not, so
	// a truncated listing still reports the true size of the backlog.
	const totalsRows = await db
		.select({
			totalTools: count(),
			totalApps: sql<number>`count(distinct ${appTools.appId})`,
		})
		.from(appTools)
		.where(where);
	const totals = totalsRows[0];
	const totalTools = Number(totals?.totalTools ?? 0);
	const totalApps = Number(totals?.totalApps ?? 0);

	// Every selected column gets a DISTINCT output name: D1 batch results are
	// object rows and collapse duplicate names before Drizzle maps them.
	const rows = await db
		.select({
			appId: appTools.appId,
			appSlug: apps.slug,
			appName: apps.name,
			toolRowId: appTools.id,
			toolId: appTools.toolId,
			toolTypeId: appTools.toolTypeId,
			schemaSource: appTools.schemaSource,
			enabled: appTools.enabled,
			annotations: appTools.annotations,
		})
		.from(appTools)
		.innerJoin(apps, eq(apps.id, appTools.appId))
		.where(where)
		.orderBy(asc(apps.slug), asc(appTools.toolId))
		.limit(limit);

	const items = rows.map((row): UnclassifiedWriteCapabilityItem => {
		const annotations = (row.annotations ?? null) as ToolAnnotations | null;
		// The derivation is the SAME helper the sync paths use, so `stale_sync`
		// means exactly "re-running sync would classify this row" and can never
		// drift from what a re-sync would actually write.
		const derivable = deriveToolWriteCapability(annotations);
		const reason: UnclassifiedWriteCapabilityReason = derivable
			? "stale_sync"
			: annotations
				? "inconclusive_annotations"
				: "no_annotations";
		return {
			appId: row.appId,
			appSlug: row.appSlug ?? null,
			appName: row.appName,
			toolRowId: row.toolRowId,
			toolId: row.toolId,
			toolTypeId: row.toolTypeId,
			schemaSource: row.schemaSource ?? null,
			enabled: row.enabled ?? true,
			reason,
			derivable,
		};
	});

	const staleSync = items.filter((i) => i.reason === "stale_sync").length;
	const summary =
		totalTools === 0
			? "Every tool declares a write capability."
			: `${totalTools} enabled tool(s) across ${totalApps} app(s) have no declared write capability (UNDECLARED → gated). ` +
				`Listed ${items.length}${items.length < totalTools ? ` of ${totalTools}` : ""}` +
				(staleSync > 0 ? `; ${staleSync} fixable by re-syncing the app` : "") +
				".";

	return {
		checkedAt: new Date().toISOString(),
		totalTools,
		totalApps,
		listed: items.length,
		truncated: items.length < totalTools,
		items,
		summary,
	};
}
