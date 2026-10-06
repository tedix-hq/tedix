import { createDbClient } from "@tedix/db/client";
import { getOrganizationBySlug } from "@tedix/db/queries/organizations";
import { listToolInvocationLabelsForOrganization } from "@tedix/db/queries/tools";
import { resolveWidgetCatalog } from "@tedix/widget-i18n/catalogs";

/**
 * Published widget branding for one tenant.
 *
 * Branding is authored in the provider console and has to reach the browser
 * before a signed session exists — the launcher is painted before anyone has
 * clicked it. So this is a public, revalidated read keyed by the tenant slug
 * that already appears in the host's script tag.
 *
 * It is an allowlist, not a filter: only the keys below ever leave the
 * organization record. Audience policy, capacity, analytics flags and the
 * portable WebMCP profile stay on the authenticated path where they belong.
 */
const BRANDING_KEYS = [
	"locale",
	"title",
	"subtitle",
	"product",
	"assistantLogoUrl",
	"assistantLogoUrlDark",
	"launcherIconUrl",
	"launcherIconUrlDark",
	"accentColor",
	"accentColorDark",
	"themeMode",
	"launcherPosition",
	"horizontalOffset",
	"bottomOffset",
	"zIndex",
	"launcherMode",
	"startMode",
	"homeModules",
	"conversationStarters",
	"translations",
] as const;

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

function effectiveLocale(hint?: string, configured?: string): string {
	for (const candidate of [hint, configured, "en-US"]) {
		if (!candidate?.trim()) continue;
		try {
			const [locale] = Intl.getCanonicalLocales(candidate.trim());
			if (locale) return locale;
		} catch {
			/* Invalid public hints do not override a valid default. */
		}
	}
	return "en-US";
}

function brandingHeaders(): HeadersInit {
	return {
		// Public wildcard (embedded on any host site), not the worker-kit allowlist.
		"Access-Control-Allow-Origin": "*",
		"Cross-Origin-Resource-Policy": "cross-origin",
		"X-Content-Type-Options": "nosniff",
		// The launcher cannot paint until this answers, so an unconditional round
		// trip per page load was seconds of unbranded widget on every visit. The
		// payload is public presentation config with no per-visitor content:
		// a minute of browser freshness and five at the edge cost a console
		// change almost nothing, and the long stale-while-revalidate window lets
		// a repeat visit paint from cache while it refreshes behind the paint.
		"Cache-Control":
			"public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
	};
}

/**
 * The colo's shared cache for this read.
 *
 * `s-maxage` on its own does nothing here: Cloudflare does not put a Worker's
 * own responses in the CDN cache, so every visitor's first request reached D1
 * through a cold Worker no matter what the header said. Holding the answer in
 * `caches.default` makes the first visitor in a colo pay that, and nobody else
 * until it expires.
 */
export interface WidgetBrandingCache {
	request: Request;
	waitUntil: (work: Promise<unknown>) => void;
}

/**
 * A tenant that does not exist, or has published nothing, gets an empty object
 * rather than a 404: the widget then renders its own defaults, and a probe
 * learns nothing about which slugs are real.
 *
 * `cache` is optional so the handler stays callable from a test or any caller
 * without an execution context; without it the read is simply uncached.
 */
export async function handleWidgetBranding(
	slug: string,
	database: D1Database | undefined,
	localeHint?: string | undefined,
	cache?: WidgetBrandingCache | undefined,
): Promise<Response> {
	// The URL carries the whole cache key: the tenant is the path and the locale
	// hint the query. The method check is not theoretical — Hono routes HEAD to
	// its GET handler, and the Cache API throws on a HEAD request rather than
	// ignoring it, so a HEAD probe would fail the read it is probing.
	const edge =
		cache && cache.request.method === "GET" ? caches.default : undefined;
	const hit = edge ? await edge.match(cache!.request) : undefined;
	if (hit) return hit;
	const response = await buildWidgetBranding(slug, database, localeHint);
	// `put` consumes the body, and the caller still has to send it.
	if (edge && cache) cache.waitUntil(edge.put(cache.request, response.clone()));
	return response;
}

async function buildWidgetBranding(
	slug: string,
	database: D1Database | undefined,
	localeHint?: string | undefined,
): Promise<Response> {
	const tenant = String(slug || "").toLowerCase();
	if (!SLUG.test(tenant) || !database) {
		const locale = effectiveLocale(localeHint);
		const { catalog } = resolveWidgetCatalog(locale);
		return Response.json(
			{ branding: {}, locale, catalog, toolLabels: {} },
			{ headers: brandingHeaders() },
		);
	}
	const client = createDbClient(database);
	const organization = await getOrganizationBySlug(client, tenant);
	const published = organization?.metadata?.tediWidget as
		| Record<string, unknown>
		| undefined;
	const branding: Record<string, unknown> = {};
	for (const key of BRANDING_KEYS)
		if (published?.[key] !== undefined && published[key] !== null)
			branding[key] = published[key];
	// The visitor's own language wins; the tenant's configured locale is the
	// default for hosts that do not pass one.
	const configured = typeof branding.locale === "string" ? branding.locale : "";
	const locale = effectiveLocale(localeHint, configured);
	const { catalog } = resolveWidgetCatalog(locale);
	// Default prompts belong to the configured language. Localized prompts are
	// selected from translations by the runtime using this same effective tag.
	if (
		locale.split("-")[0] !==
		effectiveLocale(undefined, configured).split("-")[0]
	)
		delete branding.conversationStarters;
	if (published) branding.locale = locale;
	return Response.json(
		{
			branding,
			version: published?.version ?? null,
			locale,
			catalog,
			toolLabels: organization?.id
				? await publishedToolLabels(client, organization.id)
				: {},
		},
		{ headers: brandingHeaders() },
	);
}

/**
 * What the tenant calls each of its tools, in present and past tense.
 *
 * The embedded transcript shows one row per tool call and must never print a
 * callable, so it renders a tenant-authored label or nothing at all. That makes
 * this part of published configuration rather than authenticated state: it is
 * the tenant's own customer-facing wording, the same class of value as the
 * assistant's name, and it has to be in the browser before the first turn ends.
 */
async function publishedToolLabels(
	client: ReturnType<typeof createDbClient>,
	organizationId: string,
): Promise<Record<string, { invoking?: string; invoked?: string }>> {
	const labels: Record<string, { invoking?: string; invoked?: string }> = {};
	const rows = await listToolInvocationLabelsForOrganization(
		client,
		organizationId,
	);
	for (const row of rows) {
		const invoking = row.invocationStatus?.invoking?.trim();
		const invoked = row.invocationStatus?.invoked?.trim();
		if (!invoking && !invoked) continue;
		labels[row.toolId] = {
			...(invoking ? { invoking } : {}),
			...(invoked ? { invoked } : {}),
		};
	}
	return labels;
}
