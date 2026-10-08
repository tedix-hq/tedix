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
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import { apps } from "../../schema/apps";
import { skillEntries } from "../../schema/cognitive";
import { chunkForBoundParams } from "../../utils/batch";
import { parseSkillFrontmatterCapabilities } from "./skill-tool-metadata";

export type SkillMcpAppBindings = Record<string, string>;

/**
 * Namespaces the runtime routes without an apps row (reserved aggregate
 * surfaces and platform gateway namespaces). They are never bound, so a
 * same-named app can never gain a durable link to them.
 */
const UNBOUND_NAMESPACES = new Set([
	"home",
	"kernel",
	"tedi",
	"cognitive",
	"rationale",
]);

/** Slug candidates for a namespace, in the runtime's match order. */
export function mcpNamespaceSlugCandidates(namespace: string): string[] {
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
): BindableApp | undefined {
	for (const candidate of mcpNamespaceSlugCandidates(namespace)) {
		const app = bySlug.get(candidate);
		if (app) return app;
	}
	return undefined;
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
	const unresolved: string[] = [];
	for (const namespace of namespaces) {
		const app = existing[namespace] ? byId.get(existing[namespace]) : undefined;
		if (app && isBindable(app, params.organizationId)) out[namespace] = app.id;
		else unresolved.push(namespace);
	}
	if (unresolved.length) {
		const bySlug = new Map(
			(
				await listAppsBySlugs(
					db,
					unresolved.flatMap(mcpNamespaceSlugCandidates),
				)
			).map((app) => [app.slug, app]),
		);
		for (const namespace of unresolved) {
			const app = matchBySlug(namespace, bySlug);
			if (app && isBindable(app, params.organizationId))
				out[namespace] = app.id;
		}
	}
	return Object.keys(out).length ? out : null;
}

/**
 * Dispatch-time namespace → slug map for one skill. A bound namespace routes
 * to its app's current slug; an unbound (or stale) one falls back to slug
 * matching. Namespaces with no match stay unset so the bridge routes them to
 * the org aggregate. Reserved namespaces are resolved like any unbound one;
 * `resolveMcpTarget` routes them before consulting this map.
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
}> {
	const namespaces = [...new Set(params.namespaces)];
	const namespaceToSlug: Record<string, string> = {};
	const backfill: SkillMcpAppBindings = {};
	if (!namespaces.length) return { namespaceToSlug, backfill };

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
	const unresolved: string[] = [];
	for (const namespace of namespaces) {
		const app = bound.includes(namespace)
			? byId.get(bindings[namespace]!)
			: undefined;
		if (app && isBindable(app, params.organizationId))
			namespaceToSlug[namespace] = app.slug;
		else unresolved.push(namespace);
	}
	if (unresolved.length) {
		const bySlug = new Map(
			(
				await listAppsBySlugs(
					db,
					unresolved.flatMap(mcpNamespaceSlugCandidates),
				)
			).map((app) => [app.slug, app]),
		);
		for (const namespace of unresolved) {
			const app = matchBySlug(namespace, bySlug);
			if (!app) continue;
			namespaceToSlug[namespace] = app.slug;
			if (
				!UNBOUND_NAMESPACES.has(namespace) &&
				!bindings[namespace] &&
				row &&
				isBindable(app, params.organizationId)
			) {
				backfill[namespace] = app.id;
			}
		}
	}
	return { namespaceToSlug, backfill };
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
