import type {
	DirectorySurface,
	DirectoryWorkspaceRecord,
} from "@tedix/api-contract/contracts/directory";
import { resolveOsTenant } from "@/shared/os-tenant";
import { buildSurfaceUrl } from "@tedix/tenant-directory";

export type { DirectorySurface, DirectoryWorkspaceRecord };

export const OS_LAUNCHER_ORIGIN =
	typeof __OS_URL__ === "string" ? __OS_URL__ : "https://os.tedix.dev";
export type OsPlatformDomain = "tedix.dev" | "tedix.tech";

export function resolveOsPlatformDomain(hostname: string): OsPlatformDomain {
	const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
	return normalized === "os.tedix.tech" || normalized.endsWith(".os.tedix.tech")
		? "tedix.tech"
		: "tedix.dev";
}

/**
 * Session route-out surfaces: a browser handoff to a per-surface canonical
 * origin lands on the surface's own Worker, which starts its named session on
 * arrival. MCP is deliberately absent — it is a copy/discovery endpoint, never
 * a browser session, so it is never an authorized `returnTo` target.
 */
const SESSION_ROUTE_OUT_SURFACES: readonly DirectorySurface[] = ["os", "cms"];

/**
 * A normalized launcher row. The route builds these from directory records
 * (production) or the OS-only membership projection (local eval); the
 * presentational launcher renders them without re-deriving any hostname.
 */
interface LauncherSurfaceEntry {
	surface: DirectorySurface;
	/** Route-out destination for a session surface (os/cms); null for MCP. */
	href: string | null;
	/** MCP gateway endpoint to copy; null for session surfaces. */
	copyValue: string | null;
}

export interface LauncherWorkspace {
	organizationId: string;
	name: string;
	slug: string;
	/** `org.provisionComplete`; false workspaces render disabled, never routed. */
	provisioned: boolean;
	surfaces: LauncherSurfaceEntry[];
}

/** Build the central sign-in target for a tenant deep link. */

/**
 * Surface-neutral open-redirect gate. Accepts only an absolute HTTPS URL with
 * no port, no userinfo, and no embedded credentials, rejecting `http:`,
 * `javascript:`, `data:`, and anything unparseable. This is the syntactic half
 * of `returnTo` safety; it deliberately does NOT restrict the host — the
 * directory-backed origin check ({@link isReturnTargetAuthorized}) is the trust
 * root that binds a target to a member org's provisioned surface.
 */
export function parseSafeHttpsUrl(
	value: string | null | undefined,
): URL | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (
			url.protocol !== "https:" ||
			url.port !== "" ||
			url.username !== "" ||
			url.password !== ""
		) {
			return null;
		}
		return url;
	} catch {
		return null;
	}
}

/**
 * Accept only a canonical HTTPS **OS-tenant** origin. Retained for the
 * OS-surface self-links (`buildOsLauncherLoginUrl`, `buildTenantOsUrl`) that
 * assemble a target from the OS hostname grammar rather than the directory.
 * `returnTo` authorization no longer flows through this — it is directory-backed.
 */
export function parseAuthorizedTenantReturnTarget(
	value: string | null | undefined,
): URL | null {
	const url = parseSafeHttpsUrl(value);
	if (!url || resolveOsTenant(url.hostname).kind !== "tenant") return null;
	return url;
}

export function getLauncherReturnTarget(search: string): URL | null {
	return parseSafeHttpsUrl(new URLSearchParams(search).get("returnTo"));
}

/**
 * Build the set of origins a `returnTo` may redirect into: both the canonical
 * destination and broker-handoff origins of every PROVISIONED, session-routable
 * surface (os/cms) of a member org, drawn live from the directory.
 * MCP is excluded (copy-only, never a browser session). A non-provisioned
 * surface contributes nothing, and an org that is not `provisionComplete`
 * contributes no surfaces at all — so a stale or attacker-supplied host that is
 * not a currently-provisioned member surface is absent from the set and fails.
 */
export function collectAuthorizedReturnOrigins(
	workspaces: readonly DirectoryWorkspaceRecord[],
	osPlatformDomain: OsPlatformDomain = "tedix.dev",
): ReadonlySet<string> {
	const origins = new Set<string>();
	for (const workspace of workspaces) {
		if (!workspace.org.provisionComplete) continue;
		for (const surface of workspace.surfaces) {
			if (!surface.provisioned || !surface.canonicalUrl) continue;
			if (!SESSION_ROUTE_OUT_SURFACES.includes(surface.surface)) continue;
			for (const target of [surface.canonicalUrl, surface.handoffUrl]) {
				const url = parseSafeHttpsUrl(target);
				if (url) origins.add(url.origin);
			}
			if (surface.surface === "os" && osPlatformDomain === "tedix.tech") {
				const developmentUrl = buildTenantOsUrl(
					workspace.org.slug,
					osPlatformDomain,
				);
				if (developmentUrl) origins.add(new URL(developmentUrl).origin);
			}
		}
	}
	return origins;
}

/**
 * Authorize a parsed `returnTo` against the directory-derived origin set. The
 * target's origin must exactly match a provisioned member surface origin;
 * anything else — an off-host redirect, a stale workspace, a non-provisioned
 * surface — is rejected, so the browser can never be redirected off a
 * provisioned host.
 */
export function isReturnTargetAuthorized(
	target: URL,
	authorizedOrigins: ReadonlySet<string>,
): boolean {
	return authorizedOrigins.has(target.origin);
}

export function buildTenantOsUrl(
	slug: string,
	platformDomain: OsPlatformDomain = "tedix.dev",
): string | null {
	const candidate =
		platformDomain === "tedix.dev"
			? buildSurfaceUrl("os", slug)
			: `https://${slug}.os.tedix.tech/`;
	if (!candidate) return null;
	const target = parseAuthorizedTenantReturnTarget(candidate);
	return target?.toString() ?? null;
}

/**
 * Mirror the canonical tenant hostname boundary on loopback. The production
 * hostname parser remains the slug validator; localhost never invents a
 * second organization-slug grammar.
 */
export function buildLocalOsUrl(slug: string, port = "3030"): string | null {
	if (!buildTenantOsUrl(slug)) return null;
	if (port && !/^\d+$/.test(port)) return null;
	return `http://${slug}.localhost${port ? `:${port}` : ""}/`;
}

/**
 * Suggest a valid DNS label without making the browser the authority. The API
 * validates uniqueness and the exact same hostname grammar before persisting.
 */
export function suggestOsOrganizationSlug(
	name: string,
	fallback = "my-workspace",
): string {
	const normalized = name
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/['’]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 63)
		.replace(/-+$/g, "");
	if (normalized) return normalized;
	const safeFallback = fallback
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 63)
		.replace(/-+$/g, "");
	return safeFallback || "my-workspace";
}

/**
 * Navigate directly to the canonical tenant origin. The tenant Worker starts
 * its named session flow when the browser has no matching product session.
 */
export function buildTenantOsHandoffUrl(target: URL): string {
	return target.toString();
}

/**
 * Normalize directory records into launcher rows. Only provisioned surfaces of
 * a `provisionComplete` org become entries; MCP becomes a copy entry (its
 * server-built endpoint), and os/cms become route-out anchors to their
 * server-built session handoff URL. A non-`provisionComplete` org yields an entry
 * with no surfaces so the launcher can render it disabled without routing.
 */
export function buildLauncherWorkspacesFromDirectory(
	records: readonly DirectoryWorkspaceRecord[],
	osPlatformDomain: OsPlatformDomain = "tedix.dev",
): LauncherWorkspace[] {
	return records.map((record) => ({
		organizationId: record.org.organizationId,
		name: record.org.name,
		slug: record.org.slug,
		provisioned: record.org.provisionComplete,
		surfaces: record.org.provisionComplete
			? record.surfaces.flatMap((surface): LauncherSurfaceEntry[] => {
					if (!surface.provisioned || !surface.canonicalUrl) return [];
					if (surface.surface === "mcp") {
						if (!parseSafeHttpsUrl(surface.canonicalUrl)) return [];
						return [
							{ surface: "mcp", href: null, copyValue: surface.canonicalUrl },
						];
					}
					const handoffUrl = parseSafeHttpsUrl(surface.handoffUrl);
					if (!handoffUrl) {
						return [];
					}
					if (surface.surface === "os" && osPlatformDomain === "tedix.tech") {
						const developmentUrl = buildTenantOsUrl(
							record.org.slug,
							osPlatformDomain,
						);
						if (!developmentUrl) return [];
						handoffUrl.hostname = new URL(developmentUrl).hostname;
					}
					return [
						{
							surface: surface.surface,
							href: handoffUrl.toString(),
							copyValue: null,
						},
					];
				})
			: [],
	}));
}

/**
 * Local-eval launcher rows. The zero-account lane has no directory and no other
 * surfaces: each OS membership becomes a single OS route-out to its isolated
 * localhost origin, built through the same tenant-hostname validator.
 */
export function buildLocalLauncherWorkspaces(
	items: readonly {
		organizationId: string;
		organizationName: string;
		organizationSlug: string;
	}[],
	port: string,
): LauncherWorkspace[] {
	return items.flatMap((item): LauncherWorkspace[] => {
		const href = buildLocalOsUrl(item.organizationSlug, port);
		if (!href) return [];
		return [
			{
				organizationId: item.organizationId,
				name: item.organizationName,
				slug: item.organizationSlug,
				provisioned: true,
				surfaces: [{ surface: "os", href, copyValue: null }],
			},
		];
	});
}
