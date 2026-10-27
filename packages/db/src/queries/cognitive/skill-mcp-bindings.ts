/**
 * Stable app identity for executable-skill MCP namespaces.
 *
 * A skill declares `capabilities.mcp.<namespace>` and calls
 * `env.MCP.<namespace>.<method>()`. The namespace names an app by slug
 * (exact, `${ns}-tedix`, or underscore→dash), and slugs can be renamed. Every
 * content write therefore records `skill_entries.mcp_app_bindings`
 * (`{ namespace: appId }`), and the runtime routes a bound namespace to the
 * app's current slug. Slug matching remains the fallback for unbound
 * namespaces, exactly as before bindings existed (same rule as
 * `aggregate-app-links.ts`: id first, slug only as a fallback).
 *
 * A binding is stored only for an app the skill's organization owns or a
 * public app, so a binding never grants routing that slug matching would
 * not; anything else stays on slug matching.
 *
 * When several apps match a namespace, the one the organization's unified
 * gateway aggregates wins, so a skill reaches the same app as a Code Mode
 * caller (`github` is the org's `github-tedix` install, not the catalog base
 * app `github`). A binding to an app the gateway does not aggregate gives way
 * to a gateway app that matches the namespace.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import { apps } from "../../schema/apps";
import { skillEntries } from "../../schema/cognitive";
import { isAggregateSourceAllowed } from "../app-records";
import { chunkForBoundParams } from "../../utils/batch";
import { parseSkillFrontmatterCapabilities } from "./skill-tool-metadata";

export type SkillMcpAppBindings = Record<string, string>;

/**
 * Namespaces the runtime routes without an apps row (reserved aggregate
 * surfaces and platform gateway namespaces). They are never bound, so a
 * same-named app can never gain a durable link to them.
 */
const UNBOUND_NAMESPACES = new Set([
	"os",
	"home",
	"kernel",
	"tedi",
	"cognitive",
	"rationale",
]);

/** Slug candidates for a namespace, in the runtime's match order. */
export function mcpNamespaceSlugCandidates(namespace: string): string[] {
	// OS is a platform surface whose tool rows belong to the tedix app.
	// A same-named tenant app must not shadow it.
	if (namespace === "os") return ["tedix"];
	return [
		...new Set([namespace, `${namespace}-tedix`, namespace.replace(/_/g, "-")]),
	];
}

interface BindableApp {
	id: string;
	slug: string;
	organizationId: string;
	visibility: "public" | "private" | "disabled" | null;
}

const appColumns = {
	id: apps.id,
	slug: apps.slug,
	organizationId: apps.organizationId,
	visibility: apps.visibility,
};

function isBindable(app: BindableApp, organizationId: string): boolean {
	return app.organizationId === organizationId || app.visibility === "public";
}

async function listAppsBySlugs(
	db: DbClient,
	slugs: string[],
): Promise<BindableApp[]> {
	const rows: BindableApp[] = [];
	for (const chunk of chunkForBoundParams([...new Set(slugs)], 50)) {
		rows.push(
			...(await db
				.select(appColumns)
				.from(apps)
				.where(inArray(apps.slug, chunk))),
		);
	}
	return rows;
}

async function listAppsByIds(
	db: DbClient,
	ids: string[],
): Promise<BindableApp[]> {
	const rows: BindableApp[] = [];
	for (const chunk of chunkForBoundParams([...new Set(ids)], 50)) {
		rows.push(
			...(await db
				.select(appColumns)
				.from(apps)
				.where(inArray(apps.id, chunk))),
		);
	}
	return rows;
}

function bindableNamespaces(namespaces: Iterable<string>): string[] {
	return [...new Set(namespaces)].filter(
		(namespace) => !UNBOUND_NAMESPACES.has(namespace),
	);
}

function matchBySlug(
	namespace: string,
	bySlug: Map<string, BindableApp>,
	gatewayAppIds: ReadonlySet<string> = new Set(),
): BindableApp | undefined {
	const candidates = mcpNamespaceSlugCandidates(namespace)
		.map((slug) => bySlug.get(slug))
		.filter((app): app is BindableApp => Boolean(app));
	return candidates.find((app) => gatewayAppIds.has(app.id)) ?? candidates[0];
}

/**
 * App ids the organization's unified gateway aggregates
 * (`mcpConfig.aggregateApps`). Only the Code Mode gateway counts (the same
 * choice as `getOrganizationAggregatorGateways`): an app that itself wraps a
 * base app (`github-tedix` over `github`) is not the gateway.
 */
export async function listOrganizationGatewayAppIds(
	db: DbClient,
	organizationId: string,
): Promise<Set<string>> {
	const rows = await db
		.select({ slug: apps.slug, metadata: apps.metadata })
		.from(apps)
		.where(
			and(
				eq(apps.organizationId, organizationId),
				sql`json_extract(${apps.metadata}, '$.mcpConfig.aggregateApps') IS NOT NULL`,
			),
		);
	const gateways = rows.filter((row) => {
		const config = (
			row.metadata as { mcpConfig?: Record<string, unknown> } | null
		)?.mcpConfig;
		return config?.codeMode === true && config.authMode === "authenticated";
	});
	const gateway =
		gateways.find((row) => row.slug.endsWith("-unified")) ?? gateways[0];
	const entries = (
		gateway?.metadata as { mcpConfig?: { aggregateApps?: unknown } } | null
	)?.mcpConfig?.aggregateApps;
	const ids = new Set<string>();
	if (Array.isArray(entries))
		for (const entry of entries)
			if (entry && typeof entry.appId === "string") ids.add(entry.appId);
	return ids;
}

/**
 * The app a namespace resolves to: its bound app, unless the gateway
 * aggregates a different app that matches the namespace and the bound one is
 * not aggregated (a stale binding).
 */
function preferGatewayApp(
	namespace: string,
	bound: BindableApp | undefined,
	bySlug: Map<string, BindableApp>,
	gatewayAppIds: ReadonlySet<string>,
): BindableApp | undefined {
	const matched = matchBySlug(namespace, bySlug, gatewayAppIds);
	if (!bound) return matched;
	if (gatewayAppIds.has(bound.id) || !matched || !gatewayAppIds.has(matched.id))
		return bound;
	return matched;
}

function readBindings(value: unknown): SkillMcpAppBindings {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: SkillMcpAppBindings = {};
	for (const [namespace, appId] of Object.entries(value)) {
		if (typeof appId === "string" && appId.length > 0) out[namespace] = appId;
	}
	return out;
}

/**
 * Bindings for the namespaces a skill body declares. An existing binding is
 * kept while its app still exists and stays bindable (this is what survives a
 * rename); otherwise the namespace is bound to the app slug matching selects
 * today, when that app is bindable. Returns null when nothing is bound.
 */
export async function resolveSkillMcpAppBindings(
	db: DbClient,
	params: {
		organizationId: string;
		content: string;
		existing?: unknown;
	},
): Promise<SkillMcpAppBindings | null> {
	const namespaces = bindableNamespaces(
		Object.keys(parseSkillFrontmatterCapabilities(params.content).mcp),
	);
	if (!namespaces.length) return null;
	const existing = readBindings(params.existing);
	const boundIds = namespaces.flatMap((namespace) =>
		existing[namespace] ? [existing[namespace]] : [],
	);
	const byId = new Map(
		(boundIds.length ? await listAppsByIds(db, boundIds) : []).map((app) => [
			app.id,
			app,
		]),
	);
	const out: SkillMcpAppBindings = {};
	const gatewayAppIds = await listOrganizationGatewayAppIds(
		db,
		params.organizationId,
	);
	const bySlug = new Map(
		(
			await listAppsBySlugs(db, namespaces.flatMap(mcpNamespaceSlugCandidates))
		).map((app) => [app.slug, app]),
	);
	for (const namespace of namespaces) {
		const bound = existing[namespace]
			? byId.get(existing[namespace])
			: undefined;
		const app = preferGatewayApp(
			namespace,
			bound && isBindable(bound, params.organizationId) ? bound : undefined,
			bySlug,
			gatewayAppIds,
		);
		if (app && isBindable(app, params.organizationId)) out[namespace] = app.id;
	}
	return Object.keys(out).length ? out : null;
}

/**
 * Dispatch-time namespace → slug map for one skill. A bound namespace routes
 * to its app's current slug; an unbound (or stale) one falls back to slug
 * matching. Namespaces with no match stay unset so the bridge routes them to
 * the org aggregate. Reserved platform namespaces (UNBOUND_NAMESPACES) never
 * produce an entry: no app may own them, and a same-named app row would
 * otherwise become the dispatch target and the source slug the manifest
 * authorization check requires. The exception is `os`, which resolves only
 * to its platform app `tedix` and is never bound or backfilled.
 *
 * `backfill` lists slug-matched namespaces whose app is bindable, for
 * {@link recordMissingSkillMcpAppBindings}.
 */
export async function resolveSkillMcpNamespaceSlugs(
	db: DbClient,
	params: {
		organizationId: string;
		skillId: string;
		namespaces: string[];
	},
): Promise<{
	namespaceToSlug: Record<string, string>;
	backfill: SkillMcpAppBindings;
	repair: SkillMcpAppBindings;
}> {
	const namespaces = [...new Set(params.namespaces)];
	const namespaceToSlug: Record<string, string> = {};
	const backfill: SkillMcpAppBindings = {};
	const repair: SkillMcpAppBindings = {};
	if (!namespaces.length) return { namespaceToSlug, backfill, repair };

	const [row] = await db
		.select({ mcpAppBindings: skillEntries.mcpAppBindings })
		.from(skillEntries)
		.where(
			and(
				eq(skillEntries.id, params.skillId),
				eq(skillEntries.organizationId, params.organizationId),
			),
		)
		.limit(1);
	const bindings = readBindings(row?.mcpAppBindings);
	const bound = bindableNamespaces(namespaces).filter(
		(namespace) => bindings[namespace],
	);
	const byId = new Map(
		(bound.length
			? await listAppsByIds(
					db,
					bound.map((namespace) => bindings[namespace]!),
				)
			: []
		).map((app) => [app.id, app]),
	);
	const gatewayAppIds = await listOrganizationGatewayAppIds(
		db,
		params.organizationId,
	);
	const bySlug = new Map(
		(
			await listAppsBySlugs(db, namespaces.flatMap(mcpNamespaceSlugCandidates))
		).map((app) => [app.slug, app]),
	);
	for (const namespace of namespaces) {
		const reserved = UNBOUND_NAMESPACES.has(namespace);
		// OS is the one reserved surface with a fixed platform app (tedix, see
		// mcpNamespaceSlugCandidates); it still resolves, but is never bound.
		if (reserved && namespace !== "os") continue;
		const boundApp = bound.includes(namespace)
			? byId.get(bindings[namespace]!)
			: undefined;
		const app = preferGatewayApp(
			namespace,
			boundApp && isBindable(boundApp, params.organizationId)
				? boundApp
				: undefined,
			bySlug,
			gatewayAppIds,
		);
		if (!app) continue;
		namespaceToSlug[namespace] = app.slug;
		if (reserved || !row || !isBindable(app, params.organizationId)) continue;
		if (!bindings[namespace]) backfill[namespace] = app.id;
		else if (bindings[namespace] !== app.id) repair[namespace] = app.id;
	}
	return { namespaceToSlug, backfill, repair };
}

/**
 * Add bindings for namespaces the skill has not bound yet. Existing keys win
 * (`json_patch(new, existing)`), so a concurrent content write is never
 * overwritten; `updated_at` and the revision are left alone because the skill
 * itself did not change.
 */
export async function recordMissingSkillMcpAppBindings(
	db: DbClient,
	params: {
		organizationId: string;
		skillId: string;
		bindings: SkillMcpAppBindings;
	},
): Promise<void> {
	if (!Object.keys(params.bindings).length) return;
	await db
		.update(skillEntries)
		.set({
			mcpAppBindings: sql`json_patch(${JSON.stringify(params.bindings)}, coalesce(${skillEntries.mcpAppBindings}, '{}'))`,
		})
		.where(
			and(
				eq(skillEntries.id, params.skillId),
				eq(skillEntries.organizationId, params.organizationId),
			),
		);
}

/**
 * Replace stale bindings: namespaces whose bound app gave way to the app the
 * organization's gateway aggregates. New keys win (`json_patch(existing, new)`).
 */
export async function repairSkillMcpAppBindings(
	db: DbClient,
	params: {
		organizationId: string;
		skillId: string;
		bindings: SkillMcpAppBindings;
	},
): Promise<void> {
	if (!Object.keys(params.bindings).length) return;
	await db
		.update(skillEntries)
		.set({
			mcpAppBindings: sql`json_patch(coalesce(${skillEntries.mcpAppBindings}, '{}'), ${JSON.stringify(params.bindings)})`,
		})
		.where(
			and(
				eq(skillEntries.id, params.skillId),
				eq(skillEntries.organizationId, params.organizationId),
			),
		);
}

/**
 * An installed proxy can inherit a provider's tools without owning tool rows.
 * Follow only unfiltered aggregate links; filtered mounts require their own
 * method-level authorization and must not become a grant for the whole app.
 *
 * The proxy itself must be bindable for the organization. A linked app is
 * followed when it is bindable too, or when the gateway's aggregate ownership
 * rule serves it to the linking app (`isAggregateSourceAllowed`): an org-owned
 * install over a private Tedix platform base app (`acme-peec` → `peec`)
 * resolves here exactly as it does in the gateway. Another tenant's private app
 * is never followed.
 */
export async function skillMcpProxyIncludesSource(
	db: DbClient,
	params: { organizationId: string; appSlug: string; sourceAppSlug: string },
): Promise<boolean> {
	// `host` is the organization of the app whose link named this ref; the
	// root proxy has none and must itself be bindable.
	const pending: Array<{ id?: string; slug?: string; host?: string }> = [
		{ slug: params.appSlug },
	];
	const visited = new Set<string>();
	for (let reads = 0; pending.length && reads < 8; reads++) {
		const ref = pending.shift()!;
		const [app] = await db
			.select({ ...appColumns, metadata: apps.metadata })
			.from(apps)
			.where(ref.id ? eq(apps.id, ref.id) : eq(apps.slug, ref.slug!))
			.limit(1);
		if (!app || visited.has(app.id) || app.visibility === "disabled") continue;
		if (
			!isBindable(app, params.organizationId) &&
			!(
				ref.host &&
				(await isAggregateSourceAllowed(db, ref.host, app.organizationId))
			)
		)
			continue;
		visited.add(app.id);
		if (app.slug === params.sourceAppSlug) return true;
		const links = app.metadata?.mcpConfig?.aggregateApps;
		if (!Array.isArray(links)) continue;
		for (const link of links) {
			if (
				link.toolIds !== undefined ||
				link.endpointPrefixes !== undefined ||
				link.readOnly === true
			)
				continue;
			const host = app.organizationId;
			if (link.appId) pending.push({ id: link.appId, host });
			else if (link.slug) pending.push({ slug: link.slug, host });
			if (pending.length >= 8) break;
		}
	}
	return false;
}
