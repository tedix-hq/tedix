/**
 * Pure planners for platform-operator app reference repair.
 *
 * Each planner turns rows read by `@tedix/db/queries/app-reference-maintenance`
 * into (a) the human-readable per-field change plan returned to the operator
 * and (b) the compare-and-set writes that apply exactly that plan. Planners
 * never touch storage, so dry run and apply share one code path.
 */

import type {
	AppReferenceChange,
	UnresolvedAggregateEntry,
} from "@tedix/api-contract/schemas/app-reference-maintenance";
import {
	AGGREGATE_APPS_PATH,
	type AppReferenceMetadataPath,
	type AppReferenceScanRow,
	type AppReferenceWrite,
	type AppSlugCandidate,
	type AppToolConnectionRow,
	type CatalogScanConnectionRow,
	CONNECTION_PROVIDER_ID_PATH,
	GUIDANCE_SKILL_APPS_PATH,
	INACTIVE_AGGREGATE_APPS_PATH,
	OPENAPI_SYNC_CONNECTION_PROVIDER_ID_PATH,
} from "@tedix/db/queries/app-reference-maintenance";

type AggregateList = "aggregateApps" | "inactiveAggregateApps";
type AggregateEntry = Record<string, unknown>;

const AGGREGATE_LISTS: ReadonlyArray<{
	list: AggregateList;
	path: typeof AGGREGATE_APPS_PATH | typeof INACTIVE_AGGREGATE_APPS_PATH;
	column: "aggregateAppsJson" | "inactiveAggregateAppsJson";
}> = [
	{
		list: "aggregateApps",
		path: AGGREGATE_APPS_PATH,
		column: "aggregateAppsJson",
	},
	{
		list: "inactiveAggregateApps",
		path: INACTIVE_AGGREGATE_APPS_PATH,
		column: "inactiveAggregateAppsJson",
	},
];

export type AppReferencePlan = {
	changes: AppReferenceChange[];
	writes: AppReferenceWrite[];
};

function parseArray(json: string | null): unknown[] | null {
	if (json === null) return null;
	try {
		const parsed: unknown = JSON.parse(json);
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function isEntry(value: unknown): value is AggregateEntry {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(entry: AggregateEntry, key: string): string | null {
	const value = entry[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function appChange(
	row: Pick<AppReferenceScanRow, "id" | "organizationId">,
	field: string,
	before: string | null,
	after: string | null,
): AppReferenceChange {
	return {
		recordType: "app",
		recordId: row.id,
		appId: row.id,
		organizationId: row.organizationId,
		field,
		before,
		after,
	};
}

function listWrite(
	row: AppReferenceScanRow,
	path: AppReferenceMetadataPath,
	before: string | null,
	next: unknown,
): AppReferenceWrite {
	return {
		kind: "app_metadata",
		appId: row.id,
		path,
		before,
		after: JSON.stringify(next),
		afterIsJson: true,
	};
}

function unresolved(
	row: AppReferenceScanRow,
	list: AggregateList,
	index: number,
	slug: string | null,
	candidates: AppSlugCandidate[],
): UnresolvedAggregateEntry {
	return {
		appId: row.id,
		organizationId: row.organizationId,
		list,
		index,
		slug,
		reason:
			slug === null
				? "invalid_entry"
				: candidates.length === 0
					? "not_found"
					: "ambiguous",
		candidates: candidates.map((candidate) => ({
			appId: candidate.id,
			organizationId: candidate.organizationId,
		})),
	};
}

/** Slugs of aggregate entries that still lack an appId. */
export function slugsMissingAppId(rows: AppReferenceScanRow[]): string[] {
	const slugs = new Set<string>();
	for (const row of rows) {
		for (const { column } of AGGREGATE_LISTS) {
			for (const entry of parseArray(row[column]) ?? []) {
				if (!isEntry(entry) || stringField(entry, "appId")) continue;
				const slug = stringField(entry, "slug");
				if (slug) slugs.add(slug);
			}
		}
	}
	return [...slugs];
}

/**
 * Set `appId` on every aggregate entry whose slug resolves to exactly one
 * app. Resolution is the gateway's: a global exact slug match (see
 * `listAppSlugCandidates`). Zero or several candidates are reported, and the
 * entry is left untouched.
 */
export function planAggregateAppIdBackfill(
	rows: AppReferenceScanRow[],
	candidatesBySlug: Map<string, AppSlugCandidate[]>,
): AppReferencePlan & { unresolved: UnresolvedAggregateEntry[] } {
	const changes: AppReferenceChange[] = [];
	const writes: AppReferenceWrite[] = [];
	const unresolvedEntries: UnresolvedAggregateEntry[] = [];
	for (const row of rows) {
		for (const { list, path, column } of AGGREGATE_LISTS) {
			const entries = parseArray(row[column]);
			if (!entries) continue;
			let modified = false;
			const next = entries.map((entry, index) => {
				if (!isEntry(entry)) {
					unresolvedEntries.push(unresolved(row, list, index, null, []));
					return entry;
				}
				if (stringField(entry, "appId")) return entry;
				const slug = stringField(entry, "slug");
				const candidates = slug ? (candidatesBySlug.get(slug) ?? []) : [];
				const [only] = candidates;
				if (!slug || candidates.length !== 1 || !only) {
					unresolvedEntries.push(
						unresolved(row, list, index, slug, candidates),
					);
					return entry;
				}
				modified = true;
				changes.push(
					appChange(
						row,
						`metadata.mcpConfig.${list}[${index}].appId`,
						null,
						only.id,
					),
				);
				return { ...entry, appId: only.id };
			});
			if (modified) writes.push(listWrite(row, path, row[column], next));
		}
	}
	return { changes, writes, unresolved: unresolvedEntries };
}

/**
 * Rename `target` to `newSlug` and rewrite every aggregate entry linking to
 * it: by `appId`, or by the old slug when the entry has no `appId` and the old
 * slug resolves to `target` alone (the entry also gains `appId`). A slug-only
 * entry whose old slug is ambiguous is a blocker. `guidanceSkillApps` values
 * naming the old slug follow the rename once no entry in that app keeps it.
 */
export function planAppSlugRename(input: {
	target: AppSlugCandidate;
	newSlug: string;
	preserveToolPrefix: boolean;
	linkers: AppReferenceScanRow[];
	oldSlugCandidates: AppSlugCandidate[];
}): AppReferencePlan & { blockers: UnresolvedAggregateEntry[] } {
	const { target, newSlug, preserveToolPrefix, linkers, oldSlugCandidates } =
		input;
	const oldSlug = target.slug;
	const slugResolvesToTarget =
		oldSlugCandidates.length === 1 && oldSlugCandidates[0]?.id === target.id;
	const changes: AppReferenceChange[] = [];
	const writes: AppReferenceWrite[] = [];
	const blockers: UnresolvedAggregateEntry[] = [];

	for (const row of linkers) {
		const remainingSlugs = new Set<string>();
		let rowChanged = false;
		for (const { list, path, column } of AGGREGATE_LISTS) {
			const entries = parseArray(row[column]);
			if (!entries) continue;
			let modified = false;
			const next = entries.map((entry, index) => {
				if (!isEntry(entry)) return entry;
				const entryAppId = stringField(entry, "appId");
				const entrySlug = stringField(entry, "slug");
				const linksById = entryAppId === target.id;
				const linksBySlug = !entryAppId && entrySlug === oldSlug;
				if (!linksById && !linksBySlug) {
					if (entrySlug) remainingSlugs.add(entrySlug);
					return entry;
				}
				if (linksBySlug && !slugResolvesToTarget) {
					blockers.push(
						unresolved(row, list, index, entrySlug, oldSlugCandidates),
					);
					if (entrySlug) remainingSlugs.add(entrySlug);
					return entry;
				}
				const field = (key: string) =>
					`metadata.mcpConfig.${list}[${index}].${key}`;
				const updated: AggregateEntry = { ...entry };
				if (!entryAppId) {
					updated.appId = target.id;
					changes.push(appChange(row, field("appId"), null, target.id));
				}
				if (entrySlug !== newSlug) {
					updated.slug = newSlug;
					changes.push(appChange(row, field("slug"), entrySlug, newSlug));
				}
				if (
					preserveToolPrefix &&
					entrySlug &&
					entrySlug !== newSlug &&
					!stringField(entry, "prefix")
				) {
					updated.prefix = entrySlug;
					changes.push(appChange(row, field("prefix"), null, entrySlug));
				}
				remainingSlugs.add(newSlug);
				if (
					updated.slug === entry.slug &&
					updated.appId === entry.appId &&
					updated.prefix === entry.prefix
				) {
					return entry;
				}
				modified = true;
				return updated;
			});
			if (modified) {
				rowChanged = true;
				writes.push(listWrite(row, path, row[column], next));
			}
		}

		const guidance = parseArray(row.guidanceSkillAppsJson);
		if (
			rowChanged &&
			guidance?.includes(oldSlug) &&
			!remainingSlugs.has(oldSlug)
		) {
			const next = guidance.map((value) =>
				value === oldSlug ? newSlug : value,
			);
			guidance.forEach((value, index) => {
				if (value === oldSlug) {
					changes.push(
						appChange(
							row,
							`metadata.mcpConfig.guidanceSkillApps[${index}]`,
							oldSlug,
							newSlug,
						),
					);
				}
			});
			writes.push(
				listWrite(
					row,
					GUIDANCE_SKILL_APPS_PATH,
					row.guidanceSkillAppsJson,
					next,
				),
			);
		}
	}

	if (oldSlug !== newSlug) {
		changes.push({
			recordType: "app",
			recordId: target.id,
			appId: target.id,
			organizationId: target.organizationId,
			field: "slug",
			before: oldSlug,
			after: newSlug,
		});
		writes.push({
			kind: "app_slug",
			appId: target.id,
			before: oldSlug,
			after: newSlug,
		});
	}
	return { changes, writes, blockers };
}

/** Replace provider `from` with `to` in every reference the rows carry. */
export function planConnectionProviderRelink(input: {
	from: string;
	to: string;
	apps: AppReferenceScanRow[];
	catalogApps: CatalogScanConnectionRow[];
	tools: AppToolConnectionRow[];
}): AppReferencePlan {
	const { from, to } = input;
	const changes: AppReferenceChange[] = [];
	const writes: AppReferenceWrite[] = [];

	for (const row of input.apps) {
		for (const [path, column, field] of [
			[
				CONNECTION_PROVIDER_ID_PATH,
				"connectionProviderId",
				"metadata.mcpConfig.connectionProviderId",
			],
			[
				OPENAPI_SYNC_CONNECTION_PROVIDER_ID_PATH,
				"openApiSyncConnectionProviderId",
				"metadata.mcpConfig.openApiSync.connectionProviderId",
			],
		] as const) {
			if (row[column] !== from) continue;
			changes.push(appChange(row, field, from, to));
			writes.push({
				kind: "app_metadata",
				appId: row.id,
				path,
				before: from,
				after: to,
				afterIsJson: false,
			});
		}
		for (const { list, path, column } of AGGREGATE_LISTS) {
			const entries = parseArray(row[column]);
			if (!entries) continue;
			let modified = false;
			const next = entries.map((entry, index) => {
				if (!isEntry(entry) || entry.connectionProviderId !== from)
					return entry;
				modified = true;
				changes.push(
					appChange(
						row,
						`metadata.mcpConfig.${list}[${index}].connectionProviderId`,
						from,
						to,
					),
				);
				return { ...entry, connectionProviderId: to };
			});
			if (modified) writes.push(listWrite(row, path, row[column], next));
		}
	}

	for (const tool of input.tools) {
		if (tool.connectionId !== from) continue;
		changes.push({
			recordType: "app_tool",
			recordId: tool.id,
			appId: tool.appId,
			organizationId: tool.organizationId,
			field: `app_tools[${tool.toolId}].config.auth.connectionId`,
			before: from,
			after: to,
		});
		writes.push({
			kind: "app_tool_connection",
			toolRowId: tool.id,
			before: from,
			after: to,
		});
	}

	for (const catalogApp of input.catalogApps) {
		if (catalogApp.scanConnectionId !== from) continue;
		changes.push({
			recordType: "catalog_app",
			recordId: catalogApp.id,
			appId: null,
			organizationId: catalogApp.scanOrganizationId,
			field: "app_catalog.scan_connection_id",
			before: from,
			after: to,
		});
		writes.push({
			kind: "catalog_scan_connection",
			catalogAppId: catalogApp.id,
			before: from,
			after: to,
		});
	}

	return { changes, writes };
}
