/**
 * App Catalog Queries — same-vendor siblings and plain-slug ownership.
 *
 * One vendor can legitimately own several catalog rows: per-store endpoint
 * variants are different servers with different tool sets, and a brokered or
 * templated listing may predate the runnable row. Only one of them can hold the
 * plain vendor slug (`hubspot`) that base apps, connection providers, tenant
 * installs and Code Mode namespaces inherit. Historically the first row synced
 * won it, which is often the least useful one. This module ranks the siblings
 * and plans a slug reassignment toward the best-ranked one.
 */

import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { type App, apps } from "../../schema/apps";
import {
	appCatalog,
	appCatalogChanges,
	type CatalogApp,
	type Source,
} from "../../schema/catalog";
import { listBaseAppsForCatalogApps } from "../apps";
import { batchNonEmpty } from "../../utils/batch";
import {
	extractVendorDomain,
	normalizeVendorName,
} from "./endpoint-normalization";
import { getCatalogAppBySlug } from "./get-app";
import { listCatalogStoreListingsByAppIds } from "./store-listings";
import type { Database } from "./tool-source-policy";
import { buildRefreshCatalogShadowedVariantsStatements } from "./vendor-variants";

/** Mirrors the API's `CatalogInstallability.state`; the API owns the derivation. */
export type CatalogInstallabilityState =
	| "installable"
	| "needs_base_app"
	| "needs_mcp_endpoint"
	| "service_connector"
	| "listing_only"
	| "disabled";

const INSTALLABILITY_RANK: Record<CatalogInstallabilityState, number> = {
	installable: 0,
	needs_base_app: 1,
	needs_mcp_endpoint: 2,
	service_connector: 2,
	listing_only: 2,
	disabled: 3,
};

const SOURCE_RANK: Partial<Record<Source, number>> = {
	official: 0,
	claude: 1,
	chatgpt: 2,
};
const UNRANKED_SOURCE = 3;

export interface VendorSiblingRankInput {
	id: string;
	installabilityState: CatalogInstallabilityState;
	mcpToolCount: number;
	/** Every store the row is listed in; the best one counts. */
	sources: readonly Source[];
}

function bestSourceRank(sources: readonly Source[]): number {
	return Math.min(
		UNRANKED_SOURCE,
		...sources.map((source) => SOURCE_RANK[source] ?? UNRANKED_SOURCE),
	);
}

/**
 * Order same-vendor siblings best-first: installability (installable >
 * needs_base_app > needs_mcp_endpoint / service_connector / listing_only >
 * disabled), then MCP tool count, then listing source (official > claude >
 * chatgpt), then id for a stable result. Pure; does not mutate its input.
 */
export function rankVendorSiblings<T extends VendorSiblingRankInput>(
	rows: readonly T[],
): T[] {
	return [...rows].sort(
		(a, b) =>
			INSTALLABILITY_RANK[a.installabilityState] -
				INSTALLABILITY_RANK[b.installabilityState] ||
			b.mcpToolCount - a.mcpToolCount ||
			bestSourceRank(a.sources) - bestSourceRank(b.sources) ||
			a.id.localeCompare(b.id),
	);
}

function hasConcreteEndpoint(app: CatalogApp): boolean {
	const endpoint = app.mcpEndpointNormalized ?? app.baseUrl;
	return Boolean(endpoint) && !/[{}]/.test(endpoint ?? "");
}

/** Better installability, or the same installability with more tools. */
function strictlyOutranks(
	a: Pick<VendorSiblingRankInput, "installabilityState" | "mcpToolCount">,
	b: Pick<VendorSiblingRankInput, "installabilityState" | "mcpToolCount">,
): boolean {
	const byInstallability =
		INSTALLABILITY_RANK[b.installabilityState] -
		INSTALLABILITY_RANK[a.installabilityState];
	return (
		byInstallability > 0 ||
		(byInstallability === 0 && a.mcpToolCount > b.mcpToolCount)
	);
}

export interface RankedCatalogVendorSibling extends VendorSiblingRankInput {
	app: CatalogApp;
	baseAppId: string | null;
}

export type ClassifyCatalogInstallability = (
	app: CatalogApp,
	baseApp: App | null,
) => CatalogInstallabilityState;

/**
 * Every catalog row of one vendor (same registrable website domain AND exact
 * normalized name — the same identity the import fold uses), ranked best-first
 * by `rankVendorSiblings`. Different companies that share a name have
 * different domains and never appear together.
 */
export async function rankCatalogVendorSiblings(
	db: Database,
	params: {
		website: string | null | undefined;
		name: string | null | undefined;
		classifyInstallability: ClassifyCatalogInstallability;
	},
): Promise<RankedCatalogVendorSibling[]> {
	const domain = extractVendorDomain(params.website);
	const name = normalizeVendorName(params.name);
	if (!domain || !name) return [];

	const candidates = await db
		.select()
		.from(appCatalog)
		.where(
			and(
				isNotNull(appCatalog.website),
				sql`lower(replace(replace(${appCatalog.website}, 'https://', ''), 'http://', '')) LIKE ${`%${domain}%`}`,
			),
		)
		.limit(100);
	const siblings = candidates.filter(
		(row) =>
			extractVendorDomain(row.website) === domain &&
			normalizeVendorName(row.name) === name,
	);
	if (siblings.length === 0) return [];

	const ids = siblings.map((row) => row.id);
	const baseApps = await listBaseAppsForCatalogApps(db, ids);
	const listings = await listCatalogStoreListingsByAppIds(db, ids);

	return rankVendorSiblings(
		siblings.map((app) => {
			const baseApp =
				baseApps
					.filter((candidate) => candidate.catalogAppId === app.id)
					.sort((a, b) =>
						(a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
					)[0] ?? null;
			return {
				id: app.id,
				app,
				baseAppId: baseApp?.id ?? null,
				installabilityState: params.classifyInstallability(app, baseApp),
				mcpToolCount: app.mcpToolCount ?? 0,
				sources: listings
					.filter((listing) => listing.catalogAppId === app.id)
					.map((listing) => listing.source),
			};
		}),
	);
}

export interface CatalogPlainSlugPlanEntry {
	catalogAppId: string;
	slug: string | null;
	installabilityState: CatalogInstallabilityState;
	mcpToolCount: number;
	sources: Source[];
	baseAppId: string | null;
}

export interface CatalogPlainSlugPlan {
	slug: string;
	action: "reassign" | "keep" | "blocked";
	reason: string;
	holder: CatalogPlainSlugPlanEntry;
	/** The sibling that receives the plain slug (`reassign` only). */
	winner: CatalogPlainSlugPlanEntry | null;
	/** The slug the current holder moves to (`reassign` only). */
	holderNextSlug: string | null;
	/** All same-vendor siblings, best-first. */
	ranked: CatalogPlainSlugPlanEntry[];
}

function planEntry(row: RankedCatalogVendorSibling): CatalogPlainSlugPlanEntry {
	return {
		catalogAppId: row.id,
		slug: row.app.slug,
		installabilityState: row.installabilityState,
		mcpToolCount: row.mcpToolCount,
		sources: [...row.sources],
		baseAppId: row.baseAppId,
	};
}

/**
 * Decide who should hold a plain vendor slug. The best-ranked sibling takes it
 * only when the current holder has nothing built from it (no `apps` row points
 * at it): renaming a holder that apps already inherited would strand them. The
 * holder moves to the winner's numbered slug when that is a `<slug>-…` form,
 * otherwise to the first free `<slug>-<n>`. Read-only.
 */
export async function planCatalogPlainSlugReassignment(
	db: Database,
	params: {
		slug: string;
		classifyInstallability: ClassifyCatalogInstallability;
	},
): Promise<CatalogPlainSlugPlan | null> {
	const holderApp = await getCatalogAppBySlug(db, params.slug);
	if (!holderApp) return null;

	const ranked = await rankCatalogVendorSiblings(db, {
		website: holderApp.website,
		name: holderApp.name,
		classifyInstallability: params.classifyInstallability,
	});
	const holderRow = ranked.find((row) => row.id === holderApp.id);
	const holder: CatalogPlainSlugPlanEntry = holderRow
		? planEntry(holderRow)
		: {
				catalogAppId: holderApp.id,
				slug: holderApp.slug,
				installabilityState: params.classifyInstallability(holderApp, null),
				mcpToolCount: holderApp.mcpToolCount ?? 0,
				sources: [],
				baseAppId: null,
			};
	const plan: CatalogPlainSlugPlan = {
		slug: params.slug,
		action: "keep",
		reason: "",
		holder,
		winner: null,
		holderNextSlug: null,
		ranked: ranked.map(planEntry),
	};

	// Only a sibling under this same name with a real endpoint may take the
	// slug, and only when it is strictly better — a source-order tie-break or a
	// `{url}` template endpoint is churn, not an improvement.
	const best = ranked.find(
		(row) =>
			row.id === holderApp.id ||
			((row.app.slug === params.slug ||
				row.app.slug?.startsWith(`${params.slug}-`) === true) &&
				hasConcreteEndpoint(row.app) &&
				strictlyOutranks(row, holder)),
	);
	if (!best || best.id === holderApp.id) {
		plan.reason =
			ranked.length > 1
				? "The current holder is already the best-ranked sibling."
				: "No other catalog row of the same vendor (website domain + name) exists.";
		return plan;
	}

	const [builtFrom] = await db
		.select({ id: apps.id })
		.from(apps)
		.where(eq(apps.catalogAppId, holderApp.id))
		.limit(1);
	if (builtFrom) {
		plan.action = "blocked";
		plan.reason = `Apps are built from the current holder (e.g. ${builtFrom.id}); moving its slug would strand them.`;
		return plan;
	}

	plan.action = "reassign";
	plan.winner = planEntry(best);
	plan.holderNextSlug =
		best.app.slug?.startsWith(`${params.slug}-`) === true
			? best.app.slug
			: await firstFreeNumberedSlug(db, params.slug);
	plan.reason = `${best.app.slug ?? best.id} outranks the holder (${best.installabilityState}, ${best.mcpToolCount} tool(s)).`;
	return plan;
}

async function firstFreeNumberedSlug(
	db: Database,
	slug: string,
): Promise<string> {
	for (let n = 2; n <= 100; n++) {
		const candidate = `${slug}-${n}`;
		if (!(await getCatalogAppBySlug(db, candidate))) return candidate;
	}
	return `${slug}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Apply a `reassign` plan in one batch. The holder parks on a unique temporary
 * slug first so the swap never violates `app_catalog.slug UNIQUE`.
 */
export async function applyCatalogPlainSlugReassignment(
	db: Database,
	plan: CatalogPlainSlugPlan,
): Promise<void> {
	const winner = plan.winner;
	const holderNextSlug = plan.holderNextSlug;
	if (plan.action !== "reassign" || !winner || !holderNextSlug) {
		throw new Error(`Plan for ${plan.slug} is not a reassignment`);
	}
	const holderId = plan.holder.catalogAppId;
	const now = new Date().toISOString();
	const slugChange = (catalogAppId: string, from: string | null, to: string) =>
		db.insert(appCatalogChanges).values({
			id: crypto.randomUUID(),
			catalogAppId,
			changeType: "updated",
			fieldName: "slug",
			oldValue: from,
			newValue: to,
			detectedAt: now,
		});
	const setSlug = (catalogAppId: string, slug: string) =>
		db
			.update(appCatalog)
			.set({ slug, updatedAt: sql`datetime('now')` })
			.where(eq(appCatalog.id, catalogAppId));

	const writes: BatchItem<"sqlite">[] = [
		setSlug(holderId, `${plan.slug}-reassigning-${holderId.slice(0, 8)}`),
		setSlug(winner.catalogAppId, plan.slug),
		setSlug(holderId, holderNextSlug),
		slugChange(holderId, plan.slug, holderNextSlug),
		slugChange(winner.catalogAppId, winner.slug, plan.slug),
		// The plain slug ranks first in a vendor group, so the shadowed flags move.
		...buildRefreshCatalogShadowedVariantsStatements(db),
	];
	await db.batch(batchNonEmpty(writes));
}
