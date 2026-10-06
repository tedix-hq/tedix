/**
 * MCP Worker -- .well-known route handlers
 *
 * App-specific routing and resolution logic for well-known endpoints.
 * Delegates RFC 9728 metadata building to @tedix/mcp-shared/well-known.
 */

import type { AppMetadata, AppTool } from "@tedix/api-contract/schemas/app";
import type { SkillEntry } from "@tedix/api-contract/contracts/cognitive";
import { CAPABILITY_SCOPES } from "@tedix/mcp-shared/auth/scopes";
import {
	handleProtectedResource,
	isProtectedResourcePath,
} from "@tedix/mcp-shared/well-known";
import {
	collectAdvertisedScopes,
	getDescopeAuthServerUrl,
	getDescopeDiscoveryUrl,
} from "@tedix/mcp-shared/well-known/oauth";
import { extractAppFromHostname, type HostnameInfo } from "./hostname";
import { getApiClient } from "./lib/api-client";
import { createMcpLogger } from "./log";
import {
	renderSkillIndexEntry,
	type SkillDocumentEntry,
} from "./mcp/skill-document";
import type { AppData } from "./resolution";
import {
	isRetryableUpstreamError,
	upstreamUnavailableResponse,
} from "./upstream";

const log = createMcpLogger("mcp.well_known");

/**
 * Look up app by hostname using API client
 */
export async function lookupAppByHostname(
	hostnameInfo: HostnameInfo,
	hostname: string,
	env: CloudflareEnv,
): Promise<{
	app: AppData | null;
	challengeToken: string | null;
	/** True when the lookup failed because apps/api was transiently unavailable
	 * (vs. a genuine not-found). Lets callers return 503 instead of 404. */
	upstreamUnavailable?: boolean;
}> {
	const client = getApiClient({
		serviceFetch: env.API_SERVICE,
		headers: { "X-Tedix-Tedi-Scopes": "apps:read" },
	});

	try {
		if (hostnameInfo.type === "base_domain") {
			const domainResult = await client.apps.getByDomain({ domain: hostname });
			if (domainResult.app) {
				return {
					app: {
						id: domainResult.app.id,
						name: domainResult.app.name,
						slug: domainResult.app.slug,
						domain: domainResult.app.domain,
						organizationId: domainResult.app.organizationId,
						visibility: domainResult.app.visibility,
					},
					challengeToken: null,
				};
			}
			if (env.DEFAULT_APP_SLUG) {
				const slugResult = await client.apps.getBySlugWithTools({
					slug: env.DEFAULT_APP_SLUG,
				});
				if (slugResult.app) {
					return {
						app: {
							id: slugResult.app.id,
							name: slugResult.app.name,
							slug: slugResult.app.slug,
							domain: slugResult.app.primaryDomain,
							organizationId: slugResult.app.organizationId,
							visibility: slugResult.app.visibility,
							openaiChallengeToken: slugResult.app.openaiChallengeToken,
						},
						challengeToken: slugResult.app.openaiChallengeToken ?? null,
					};
				}
			}
			return { app: null, challengeToken: null };
		}

		if (hostnameInfo.type === "subdomain" && hostnameInfo.appSlug) {
			const result = await client.apps.getBySlugWithTools({
				slug: hostnameInfo.appSlug,
			});
			if (result.app) {
				return {
					app: {
						id: result.app.id,
						name: result.app.name,
						slug: result.app.slug,
						domain: result.app.primaryDomain,
						organizationId: result.app.organizationId,
						visibility: result.app.visibility,
						openaiChallengeToken: result.app.openaiChallengeToken,
					},
					challengeToken: result.app.openaiChallengeToken ?? null,
				};
			}
		}

		if (hostnameInfo.type === "custom" && hostnameInfo.customDomain) {
			const domainResult = await client.apps.getByDomain({
				domain: hostnameInfo.customDomain,
			});
			if (domainResult.app) {
				const slugResult = await client.apps.getBySlugWithTools({
					slug: domainResult.app.slug,
				});
				return {
					app: {
						id: domainResult.app.id,
						name: domainResult.app.name,
						slug: domainResult.app.slug,
						domain: domainResult.app.domain,
						organizationId: domainResult.app.organizationId,
						visibility: domainResult.app.visibility,
						openaiChallengeToken: slugResult.app?.openaiChallengeToken,
					},
					challengeToken: slugResult.app?.openaiChallengeToken ?? null,
				};
			}
		}
	} catch (error) {
		log.error("Failed to look up app", {
			event: "well_known.app_lookup_failed",
			error,
			outcome: "unavailable",
		});
		// A transient apps/api outage must not masquerade as a genuine
		// not-found — surface it so the handler can return 503, not 404.
		return {
			app: null,
			challengeToken: null,
			upstreamUnavailable: isRetryableUpstreamError(error),
		};
	}

	return { app: null, challengeToken: null };
}

/**
 * Handle .well-known routes for domain verification and OAuth
 */
export async function handleWellKnown(
	url: URL,
	hostname: string,
	env: CloudflareEnv,
): Promise<Response | null> {
	const path = url.pathname;

	if (path === "/.well-known/openai-apps-challenge") {
		return handleOpenAIChallenge(hostname, env);
	}

	if (path === "/.well-known/agent-skills/index.json") {
		return handlePublicSkillIndex(hostname, env);
	}

	// RFC 9728: clients derive the metadata URL by inserting /.well-known/oauth-protected-resource
	// between the host and the resource path. For /mcp this becomes /.well-known/oauth-protected-resource/mcp.
	if (isProtectedResourcePath(path)) {
		return handleOAuthMetadata(hostname, env);
	}

	return null;
}

function toSkillDocumentEntry(skill: SkillEntry): SkillDocumentEntry {
	return {
		id: skill.id,
		title: skill.title,
		slug: skill.slug ?? null,
		summary: skill.summary ?? null,
		description: skill.description ?? null,
		content: skill.content,
		files: skill.files ?? null,
		tags: skill.tags ?? null,
		toolIds: skill.toolIds ?? null,
		successCount: skill.successCount,
		revision: skill.revision,
		appId: skill.appId ?? null,
		audience: skill.audience ?? null,
		r2Path: skill.r2Path ?? null,
		updatedAt: skill.updatedAt ?? null,
		createdAt: skill.createdAt ?? null,
		source: "d1",
	};
}

async function handlePublicSkillIndex(
	hostname: string,
	env: CloudflareEnv,
): Promise<Response> {
	const { hostnameInfo, app, mcpConfig, tools, upstreamUnavailable } =
		await resolveAppMcpConfig(hostname, env);
	if (upstreamUnavailable) return upstreamUnavailableResponse();

	if (hostnameInfo.type === "base_domain" && !app) {
		return new Response(
			JSON.stringify({
				error: "App subdomain required",
				message: "Use {app}.mcp.tedix.dev format for skill discovery.",
			}),
			{
				status: 400,
				headers: {
					"Content-Type": "application/json",
					"Cache-Control": "private, no-store",
				},
			},
		);
	}
	if (!app) {
		return new Response(JSON.stringify({ error: "not_found" }), {
			status: 404,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "private, no-store",
			},
		});
	}

	const allowlist = new Set(mcpConfig?.publicSkillSlugs ?? []);
	let skills: SkillEntry[] = [];
	if (allowlist.size > 0) {
		if (!app.organizationId) {
			log.error("Resolved app without an organization boundary", {
				event: "well_known.organization_missing",
				appId: app.id,
				outcome: "misconfigured",
			});
			return upstreamUnavailableResponse();
		}
		try {
			const client = getApiClient({
				serviceFetch: env.API_SERVICE,
				orgId: app.organizationId,
			});
			const result = await client.skills.listByApp({
				appId: app.id,
				slugs: [...allowlist],
				limit: allowlist.size,
			});
			skills = result.skills.filter(
				(skill) =>
					skill.appId === app.id &&
					skill.tediId == null &&
					skill.visibility !== "private" &&
					skill.lifecycleState !== "draft" &&
					skill.lifecycleState !== "archived" &&
					Boolean(skill.slug && allowlist.has(skill.slug)),
			);
		} catch (error) {
			log.error("Failed to load public skill index", {
				event: "well_known.skill_index_failed",
				appId: app.id,
				error,
				outcome: "unavailable",
			});
			if (isRetryableUpstreamError(error)) return upstreamUnavailableResponse();
			return new Response(JSON.stringify({ error: "upstream_error" }), {
				status: 502,
				headers: {
					"Content-Type": "application/json",
					"Cache-Control": "private, no-store",
				},
			});
		}
	}

	const uuidToToolId = new Map(tools.map((tool) => [tool.id, tool.toolId]));
	const manifests = await Promise.all(
		skills
			.sort((a, b) => (a.slug ?? a.id).localeCompare(b.slug ?? b.id))
			.map((skill) =>
				renderSkillIndexEntry(
					toSkillDocumentEntry(skill),
					app.slug,
					uuidToToolId,
				),
			),
	);
	const entries = manifests.map((entry) => ({
		type: "skill-md",
		url: entry.uri,
		frontmatter: entry.frontmatter,
		digest: Array.isArray(entry.resources)
			? entry.resources.find((resource) => resource.uri === entry.uri)?.digest
			: undefined,
	}));
	return new Response(
		JSON.stringify(
			{
				$schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
				skills: entries,
			},
			null,
			2,
		),
		{
			headers: {
				"Content-Type": "application/json",
				// The Worker cache key is not proven to partition tenant hosts.
				// Keep this public document uncached to make cross-host leakage impossible.
				"Cache-Control": "private, no-store",
			},
		},
	);
}

async function handleOpenAIChallenge(
	hostname: string,
	env: CloudflareEnv,
): Promise<Response> {
	const hostnameInfo = extractAppFromHostname(hostname, env);
	const { app, challengeToken, upstreamUnavailable } =
		await lookupAppByHostname(hostnameInfo, hostname, env);

	// A transient apps/api outage must not look like a permanently-absent app:
	// return 503 + Retry-After so the verifier retries instead of treating the
	// (real) app as not found.
	if (!app && upstreamUnavailable) {
		return upstreamUnavailableResponse();
	}

	// Explicit no-store on every negative/error branch below: none of these are
	// safe to let the Workers Cache tier (wrangler.jsonc `cache.enabled`) retain
	// — a not-yet-provisioned app, or a not-yet-configured challenge token, can
	// become valid moments later and must never serve a stale negative.
	if (hostnameInfo.type === "base_domain" && !app) {
		return new Response(
			"App subdomain required. Use {app}.mcp.tedix.dev format.",
			{ status: 400, headers: { "Cache-Control": "private, no-store" } },
		);
	}

	if (!app) {
		return new Response("App not found", {
			status: 404,
			headers: { "Cache-Control": "private, no-store" },
		});
	}

	if (!challengeToken) {
		return new Response("Challenge token not configured", {
			status: 404,
			headers: { "Cache-Control": "private, no-store" },
		});
	}

	// Cacheable: unauthenticated, identical for every caller of this app (the
	// OpenAI Apps SDK domain-verification crawler), varies only by hostname —
	// already captured by the Workers Cache key (entrypoint + URL). Tagged so a
	// future `ctx.cache.purge({ tags: ["app:{app.id}"] })` can evict it the
	// moment `apps.openaiChallengeToken` changes (today: no apps/api mutation
	// endpoint writes this field yet — see `apps/api/src/rpc/routers/apps.ts`;
	// wire the purge there once one exists).
	return new Response(challengeToken, {
		headers: {
			"Content-Type": "text/plain",
			"Cache-Control": "public, max-age=300",
			"Cache-Tag": `app:${app.id}`,
		},
	});
}

/**
 * Resolve the app and its mcpConfig for a given hostname.
 * Shared helper used by OAuth metadata endpoints.
 */
async function resolveAppMcpConfig(
	hostname: string,
	env: CloudflareEnv,
): Promise<{
	hostnameInfo: HostnameInfo;
	app: AppData | null;
	mcpConfig: AppMetadata["mcpConfig"] | undefined;
	tools: AppTool[];
	upstreamUnavailable?: boolean;
}> {
	const hostnameInfo = extractAppFromHostname(hostname, env);
	const lookup = await lookupAppByHostname(hostnameInfo, hostname, env);
	const { app } = lookup;

	let tools: AppTool[] = [];
	let mcpConfigUpstreamUnavailable = false;
	const mcpConfig = app
		? await (async () => {
				try {
					const client = getApiClient({
						serviceFetch: env.API_SERVICE,
						headers: { "X-Tedix-Tedi-Scopes": "apps:read" },
					});
					const result = await client.apps.getBySlugWithTools({
						slug: app.slug,
					});
					tools = result.tools ?? [];
					return (result.app?.metadata as AppMetadata | null)?.mcpConfig;
				} catch (error) {
					// App resolved but its mcpConfig fetch failed transiently — flag
					// so OAuth metadata returns 503 rather than a misleading 404.
					mcpConfigUpstreamUnavailable = isRetryableUpstreamError(error);
					return undefined;
				}
			})()
		: undefined;

	return {
		hostnameInfo,
		app,
		mcpConfig,
		tools,
		upstreamUnavailable:
			lookup.upstreamUnavailable || mcpConfigUpstreamUnavailable,
	};
}

async function loadDescopeSupportedScopes(params: {
	projectId: string;
	resourceId: string;
	baseUrl: string;
}): Promise<string[] | null> {
	const discoveryUrl = getDescopeDiscoveryUrl(
		params.projectId,
		params.resourceId,
		params.baseUrl,
	);
	try {
		const response = await fetch(discoveryUrl, {
			headers: { Accept: "application/json" },
		});
		if (!response.ok) return null;

		const metadata = (await response.json()) as {
			scopes_supported?: unknown;
		};
		if (!Array.isArray(metadata.scopes_supported)) return null;

		const scopes = metadata.scopes_supported.filter(
			(scope): scope is string => typeof scope === "string" && scope.length > 0,
		);
		return scopes.length > 0 ? [...new Set(scopes)].sort() : null;
	} catch (error) {
		console.warn(
			"[well-known] Failed to load Descope AIH scopes; falling back to D1 metadata",
			error instanceof Error ? error.message : error,
		);
		return null;
	}
}

const CAPABILITY_SCOPE_SET: ReadonlySet<string> = new Set(CAPABILITY_SCOPES);
const LEGACY_CAPABILITY_SCOPE_SET = new Set([
	"mcp:tedis",
	"mcp:apps",
	"mcp:memory",
	"mcp:skills",
	"mcp:content",
	"mcp:catalog",
	"mcp:observe",
	"mcp:messaging",
	"mcp:settings",
]);

/**
 * Keep exact scope names that the authorization server registers.
 *
 * `scopes_supported` is a promise to OAuth clients: every entry is something
 * they may request. The Descope-sourced list keeps that promise, but the D1
 * fallback below is built from `mcpConfig.toolScopes`, which carries internal
 * tool-authorization scopes. Those are checked by us, per tool, after a token
 * is issued — they are not registered with Descope and cannot be granted.
 *
 * Advertising one is not a cosmetic mismatch, it breaks login outright: a client
 * that requests every advertised scope gets the whole authorization rejected
 * by Descope with "Received invalid scope".
 *
 * The capability catalog is granular, so `.read`, `.write`, and `.admin` are
 * first-class grantable scopes. Tenant policy-mode per-tool scopes are passed
 * through unchanged as well.
 */
export function normalizeAdvertisedScopeNames(
	names: readonly string[],
): string[] {
	const normalized = new Set<string>();
	for (const name of names) {
		if (LEGACY_CAPABILITY_SCOPE_SET.has(name)) continue;
		const separator = name.indexOf(".");
		const parent = separator > 0 ? name.slice(0, separator) : null;
		normalized.add(parent && CAPABILITY_SCOPE_SET.has(parent) ? parent : name);
	}
	return [...normalized].sort();
}

async function handleOAuthMetadata(
	hostname: string,
	env: CloudflareEnv,
): Promise<Response> {
	const { hostnameInfo, app, mcpConfig, tools, upstreamUnavailable } =
		await resolveAppMcpConfig(hostname, env);

	// Don't let a transient apps/api outage make a configured OAuth server briefly
	// advertise no auth (404). Return 503 + Retry-After so clients retry discovery.
	if (upstreamUnavailable) {
		return upstreamUnavailableResponse();
	}

	// Explicit no-store on every negative/config-error branch below: none are
	// safe to let the Workers Cache tier (wrangler.jsonc `cache.enabled`) retain
	// — an app can gain OAuth config (descopeResourceId, tool scopes) moments
	// after a caller sees one of these, and a stale negative must not persist.
	if (hostnameInfo.type === "base_domain" && !app) {
		return new Response(
			JSON.stringify({
				error: "App subdomain required",
				message: "Use {app}.mcp.tedix.dev format for OAuth metadata.",
			}),
			{
				status: 400,
				headers: {
					"Content-Type": "application/json",
					"Cache-Control": "private, no-store",
				},
			},
		);
	}

	const advertisedScopes = collectAdvertisedScopes({
		mcpConfig,
		tools: tools.map((tool) => ({
			name: tool.toolId,
			description: tool.description ?? undefined,
		})),
	});

	// If app has a custom protectedResourceMetadata override, keep its auth
	// server/scopes but bind `resource` to the endpoint that served this document.
	// Copied aggregate-app config must never make one tenant gateway advertise a
	// different tenant's resource URL; SDK OAuth clients correctly reject that.
	// Never edge-cache OAuth metadata. The MCP Worker serves many tenant hosts
	// from one zone and its configured cache key is not host-partitioned; caching
	// this response can leak one tenant's resource/as metadata onto another host.
	if (mcpConfig?.protectedResourceMetadata) {
		const metadata = {
			...mcpConfig.protectedResourceMetadata,
			resource: `https://${hostname}/mcp`,
			scopes_supported: normalizeAdvertisedScopeNames(
				Array.isArray(mcpConfig.protectedResourceMetadata.scopes_supported)
					? mcpConfig.protectedResourceMetadata.scopes_supported.filter(
							(scope): scope is string => typeof scope === "string",
						)
					: [],
			),
		};
		return new Response(JSON.stringify(metadata, null, 2), {
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "private, no-store",
			},
		});
	}

	// No OAuth config = no scopes = 404
	if (advertisedScopes.length === 0) {
		return new Response(JSON.stringify({ error: "not_found" }), {
			status: 404,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "private, no-store",
			},
		});
	}

	// Require descopeResourceId -- without it there's no valid authorization server
	if (!mcpConfig?.descopeResourceId) {
		return new Response(
			JSON.stringify({
				error: "configuration_error",
				message:
					"OAuth requires descopeResourceId in mcpConfig. Register this MCP server in the Descope Agentic Identity Hub.",
			}),
			{
				status: 404,
				headers: {
					"Content-Type": "application/json",
					"Cache-Control": "private, no-store",
				},
			},
		);
	}

	const authServerUrl = getDescopeAuthServerUrl(
		env.DESCOPE_PROJECT_ID,
		mcpConfig.descopeResourceId,
		env.DESCOPE_AIH_BASE_URL,
	);
	const descopeScopes = await loadDescopeSupportedScopes({
		projectId: env.DESCOPE_PROJECT_ID,
		resourceId: mcpConfig.descopeResourceId,
		baseUrl: env.DESCOPE_AIH_BASE_URL,
	});

	// resource_documentation: config-driven, with sensible default
	const resourceDocumentation =
		(mcpConfig?.resourceDocumentation as string | undefined) ??
		(app
			? `https://docs.tedix.dev/apps/${app.slug}`
			: "https://docs.tedix.dev/mcp");

	// Delegate shape construction to the shared package, then force no-store for
	// the same cross-host isolation invariant as the override branch above.
	const response = handleProtectedResource({
		resource: `https://${hostname}/mcp`,
		authorizationServers: [authServerUrl],
		scopesSupported: normalizeAdvertisedScopeNames(
			descopeScopes ?? advertisedScopes.map((scope) => scope.name),
		),
		resourceDocumentation,
		scopeDescriptions: mcpConfig?.scopeDescriptions,
		cacheTagAppId: app?.id,
	});
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", "private, no-store");
	headers.delete("Cache-Tag");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
