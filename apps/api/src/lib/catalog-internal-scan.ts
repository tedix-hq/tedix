import type { DbClient } from "@tedix/db/client";
import { getCatalogBaseApp } from "@tedix/db/queries/apps";
import { listCmsSitesByOrganization } from "@tedix/db/queries/cms-sites";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { SURFACE_SLUG_PATTERN } from "@tedix/tenant-directory";
import {
	hostSetting,
	type PlatformDomainEnv,
	platformDomain,
} from "@tedix/worker-kit/platform-hosts";
import type { FetchFn, ServiceBindingFetcher } from "./mcp-client";

type CatalogScanEnv = PlatformDomainEnv & {
	MCP_URL?: string;
	SITE_BUILDER_HOSTNAME?: string;
	CMS_TENANT_HOST_SUFFIX?: string;
	MCP_SERVICE?: ServiceBindingFetcher;
	CMS?: ServiceBindingFetcher;
	PLATFORM_SERVICE_TOKEN?: string;
};

function tenantLabel(hostname: string, suffix: string): string | undefined {
	if (!hostname.endsWith(`.${suffix}`)) return undefined;
	const label = hostname.slice(0, -suffix.length - 1);
	return label.length <= 63 && SURFACE_SLUG_PATTERN.test(label)
		? label
		: undefined;
}

export async function resolveCatalogBuilderSite(
	db: DbClient,
	input: { catalogAppId?: string; organizationId?: string | null },
): Promise<string | undefined> {
	const base = input.catalogAppId
		? await getCatalogBaseApp(db, { catalogAppId: input.catalogAppId })
		: null;
	const organizationId = base?.organizationId ?? input.organizationId;
	if (!organizationId) return undefined;

	const active = (await listCmsSitesByOrganization(db, organizationId)).filter(
		(site) => site.status === "active",
	);
	if (active.length === 1) return active[0]?.slug;
	if (active.length > 1) {
		const org = await getOrganizationById(db, organizationId);
		return active.find((site) => site.slug === org?.slug)?.slug;
	}
}

/** The platform bearer is attached only inside the pinned service-binding fetch. */
export function createCatalogScanFetch(
	endpoint: string,
	env: CatalogScanEnv,
	resolveBuilderSite?: () => Promise<string | undefined>,
): FetchFn | undefined {
	const url = URL.parse(endpoint);
	if (
		!url ||
		url.protocol !== "https:" ||
		url.port ||
		url.username ||
		url.password ||
		url.hash ||
		url.pathname.replace(/\/+$/, "") !== "/mcp"
	)
		return undefined;

	const host = url.hostname;
	const cmsDomain = hostSetting(env.PLATFORM_DOMAIN, "tedix.dev");
	const builder =
		host === hostSetting(env.SITE_BUILDER_HOSTNAME, `builder.${cmsDomain}`);
	const tenant = tenantLabel(
		host,
		hostSetting(env.CMS_TENANT_HOST_SUFFIX, `cms.${cmsDomain}`),
	);
	const mcpHost = env.MCP_URL
		? URL.parse(env.MCP_URL)?.hostname
		: `mcp.${platformDomain(env)}`;
	const cms = builder || Boolean(tenant);
	const gateway =
		!cms && mcpHost && (host === mcpHost || tenantLabel(host, mcpHost));
	if (!cms && !gateway) return undefined;

	const binding = cms ? env.CMS : env.MCP_SERVICE;
	const token = env.PLATFORM_SERVICE_TOKEN;
	let builderSite: Promise<string | undefined> | undefined;
	return async (requestUrl, init) => {
		if (new URL(requestUrl).href !== url.href)
			throw new Error("Catalog scan endpoint changed");
		if (!binding || !token)
			throw new Error(
				"Catalog scan service binding or platform sign-in is unavailable",
			);

		const headers = new Headers(init?.headers);
		headers.set("Authorization", `Bearer ${token}`);
		headers.set("X-Service-Binding", "true");
		if (gateway) {
			headers.set("X-Tedix-Host", host);
		} else {
			const site =
				tenant ??
				(url.searchParams.get("org") ||
					(await (builderSite ??= resolveBuilderSite?.())));
			if (!site)
				throw new Error("Catalog builder scan requires an active CMS site");
			headers.set("X-Tedix-Connection-Label", site);
		}

		return binding.fetch(
			new Request(requestUrl, { ...init, headers, redirect: "manual" }),
		);
	};
}

/** Never send a stored or externally supplied copy of the platform bearer. */
export function externalCatalogScanHeaders(
	headers: Record<string, string> | undefined,
	platformServiceToken?: string,
): Record<string, string> | undefined {
	if (
		headers &&
		platformServiceToken &&
		Object.values(headers).some((value) => value.includes(platformServiceToken))
	)
		return undefined;
	return headers;
}
