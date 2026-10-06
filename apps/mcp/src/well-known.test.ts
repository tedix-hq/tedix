import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { getApiClient, getBySlugWithTools, listByApp } = vi.hoisted(() => {
	const getByDomain = vi.fn();
	const getBySlugWithTools = vi.fn();
	const listByApp = vi.fn();
	return {
		getByDomain,
		getBySlugWithTools,
		listByApp,
		getApiClient: vi.fn(() => ({
			apps: { getByDomain, getBySlugWithTools },
			skills: { listByApp },
		})),
	};
});

vi.mock("./lib/api-client", () => ({ getApiClient }));

import {
	CAPABILITY_SCOPES,
	PLATFORM_OPERATOR_SCOPE,
	PLATFORM_SCOPES,
} from "@tedix/mcp-shared/auth/scopes";
import { handleWellKnown, normalizeAdvertisedScopeNames } from "./well-known";

function createEnv() {
	return {
		ENVIRONMENT: "development",
		MCP_URL: "https://mcp.tedix.tech",
		API_URL: "https://api.tedix.tech",
		MCP_UI_URL: "https://mcp-ui.tedix.tech",
		DESCOPE_AIH_BASE_URL: "https://api.descope.com",
		DEFAULT_APP_SLUG: "",
		// No API_SERVICE: the OAuth mcpConfig fetch falls back to the (mocked)
		// oRPC client, and is skipped entirely when app resolution fails.
	} as unknown as CloudflareEnv;
}

/** The apps/api SERVICE_UNAVAILABLE shape (ORPCError-like). */
const transient = () =>
	Object.assign(new Error("Service Unavailable"), {
		code: "SERVICE_UNAVAILABLE",
		status: 503,
	});

const HOST = "acme.mcp.tedix.tech";
const oauthUrl = new URL(
	"https://acme.mcp.tedix.tech/.well-known/oauth-protected-resource/mcp",
);
const challengeUrl = new URL(
	"https://acme.mcp.tedix.tech/.well-known/openai-apps-challenge",
);
const skillIndexUrl = new URL(
	"https://acme.mcp.tedix.tech/.well-known/agent-skills/index.json",
);

function skill(params: {
	id: string;
	appId: string;
	slug: string;
	visibility?: "private" | "shared" | "org";
}) {
	return {
		id: params.id,
		organizationId: "org_acme",
		title: params.slug,
		slug: params.slug,
		description: `${params.slug} description`,
		content: `# ${params.slug}`,
		successCount: 0,
		failureCount: 0,
		revision: 1,
		visibility: params.visibility ?? ("org" as const),
		appId: params.appId,
	};
}

describe("public Agent Skills index", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("publishes only explicitly allowlisted skills from the serving app", async () => {
		getBySlugWithTools.mockResolvedValue({
			app: {
				id: "app_acme",
				name: "Acme",
				slug: "acme",
				primaryDomain: null,
				organizationId: "org_acme",
				visibility: "private",
				metadata: {
					mcpConfig: {
						publicSkillSlugs: ["public-guide", "private-guide", "other-tenant"],
					},
				},
			},
			tools: [],
		});
		listByApp.mockResolvedValue({
			skills: [
				skill({ id: "skill_public", appId: "app_acme", slug: "public-guide" }),
				skill({
					id: "skill_private",
					appId: "app_acme",
					slug: "private-guide",
					visibility: "private",
				}),
				skill({ id: "skill_other", appId: "app_other", slug: "other-tenant" }),
			],
		});

		const response = await handleWellKnown(skillIndexUrl, HOST, createEnv());
		expect(response?.status).toBe(200);
		expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
		const body = (await response?.json()) as {
			skills: Array<{ url: string; frontmatter: { name: string } }>;
		};
		expect(body.skills).toHaveLength(1);
		expect(body.skills[0]).toMatchObject({
			url: "skill://acme/public-guide/SKILL.md",
			frontmatter: { name: "public-guide" },
		});
		expect(listByApp).toHaveBeenCalledWith({
			appId: "app_acme",
			slugs: ["public-guide", "private-guide", "other-tenant"],
			limit: 3,
		});
		expect(getApiClient).toHaveBeenCalledWith({
			serviceFetch: undefined,
			orgId: "org_acme",
		});
	});

	it("returns an empty public index without reading organization skills when no allowlist exists", async () => {
		getBySlugWithTools.mockResolvedValue({
			app: {
				id: "app_acme",
				name: "Acme",
				slug: "acme",
				primaryDomain: null,
				organizationId: "org_acme",
				visibility: "private",
				metadata: { mcpConfig: {} },
			},
			tools: [],
		});

		const response = await handleWellKnown(skillIndexUrl, HOST, createEnv());
		expect(await response?.json()).toMatchObject({ skills: [] });
		expect(listByApp).not.toHaveBeenCalled();
	});
});

describe("well-known transient upstream handling", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("OAuth metadata returns 503 + Retry-After when apps/api is transiently down", async () => {
		getBySlugWithTools.mockRejectedValue(transient());
		const res = await handleWellKnown(oauthUrl, HOST, createEnv());
		expect(res?.status).toBe(503);
		expect(res?.headers.get("Retry-After")).toBeTruthy();
	});

	it("openai-challenge returns 503 when apps/api is transiently down", async () => {
		getBySlugWithTools.mockRejectedValue(transient());
		const res = await handleWellKnown(challengeUrl, HOST, createEnv());
		expect(res?.status).toBe(503);
		expect(res?.headers.get("Retry-After")).toBeTruthy();
	});

	it("OAuth metadata still returns 404 for a genuinely-unknown app", async () => {
		getBySlugWithTools.mockResolvedValue({ app: null, tools: [] });
		const res = await handleWellKnown(oauthUrl, HOST, createEnv());
		expect(res?.status).toBe(404);
	});

	it("openai-challenge still returns 404 for a genuinely-unknown app", async () => {
		getBySlugWithTools.mockResolvedValue({ app: null, tools: [] });
		const res = await handleWellKnown(challengeUrl, HOST, createEnv());
		expect(res?.status).toBe(404);
	});
});

describe("normalizeAdvertisedScopeNames", () => {
	it("drops removed broad scopes and preserves granular scopes", () => {
		expect(
			normalizeAdvertisedScopeNames([
				"mcp:content",
				"mcp:content.read",
				"mcp:content.write",
				"mcp:content.admin",
			]),
		).toEqual(["mcp:content.admin", "mcp:content.read", "mcp:content.write"]);
	});

	it("advertises nothing outside the authorization vocabulary for aggregate apps", () => {
		const advertised = normalizeAdvertisedScopeNames([
			"platform:admin",
			"mcp:apps",
			"mcp:apps.read",
			"mcp:apps.write",
			"mcp:content.read",
			"mcp:memory.admin",
			"mcp:observe.read",
			"mcp:skills.write",
		]);
		expect(advertised).toEqual([
			"mcp:apps.read",
			"mcp:apps.write",
			"mcp:content.read",
			"mcp:memory.admin",
			"mcp:observe.read",
			"mcp:skills.write",
			"platform:admin",
		]);
		for (const scope of advertised) {
			expect([
				...CAPABILITY_SCOPES,
				...PLATFORM_SCOPES,
				PLATFORM_OPERATOR_SCOPE,
			]).toContain(scope);
		}
	});

	it("passes through custom tenant scopes whose parent is not a capability scope", () => {
		// Policy-mode tenant apps register these against their own Descope
		// resource, so collapsing them would break those logins instead.
		expect(
			normalizeAdvertisedScopeNames([
				"mcp:search.listings",
				"mcp:invoice.create",
			]),
		).toEqual(["mcp:invoice.create", "mcp:search.listings"]);
	});

	it("leaves a bare capability scope list untouched apart from ordering", () => {
		expect(normalizeAdvertisedScopeNames([...CAPABILITY_SCOPES])).toEqual(
			[...CAPABILITY_SCOPES].sort(),
		);
	});
});

describe("OAuth metadata scope advertisement", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
	});

	it("keeps Resource discovery independent from per-tool scope overrides", async () => {
		// Descope discovery fails, so the edge must use the exact D1 Resource
		// catalog. An empty toolScopes map is intentional: authorization falls back
		// to the shared namespace resolver instead of a legacy aggregate override.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 500 })),
		);
		getBySlugWithTools.mockResolvedValue({
			app: {
				id: "app_1",
				slug: "acme",
				metadata: {
					mcpConfig: {
						descopeResourceId: "res_1",
						toolScopes: {},
						scopeDescriptions: {
							"mcp:work.read": "Read Work Items",
							"mcp:work.write": "Execute Work Items",
							"platform:admin": "Operate the control plane",
						},
					},
				},
			},
			tools: [],
		});

		const res = await handleWellKnown(oauthUrl, HOST, createEnv());
		expect(res?.status).toBe(200);
		const body = (await res?.json()) as {
			scopes_supported: string[];
			scope_descriptions: Record<string, string>;
		};
		expect(body.scopes_supported).toEqual([
			"mcp:work.read",
			"mcp:work.write",
			"platform:admin",
		]);
		expect(body.scope_descriptions).toEqual({
			"mcp:work.read": "Read Work Items",
			"mcp:work.write": "Execute Work Items",
			"platform:admin": "Operate the control plane",
		});
	});

	/**
	 * Reproduces the invalid-scope login break end-to-end: Descope discovery is
	 * unavailable (so the D1 fallback is used) and the app's toolScopes carry
	 * granular tool-authorization scopes. Discovery must still advertise only
	 * scopes Descope can actually grant.
	 */
	it("never advertises tool-level sub-scopes when falling back to D1 toolScopes", async () => {
		// Descope discovery fails => loadDescopeSupportedScopes returns null.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 500 })),
		);
		getBySlugWithTools.mockResolvedValue({
			app: {
				id: "app_1",
				slug: "acme",
				metadata: {
					mcpConfig: {
						descopeResourceId: "res_1",
						toolScopes: {
							get_docs_file: ["mcp:content.read"],
							commit_docs_change: ["mcp:content.admin"],
							list_apps: ["mcp:apps"],
						},
					},
				},
			},
			tools: [],
		});

		const res = await handleWellKnown(oauthUrl, HOST, createEnv());
		expect(res?.status).toBe(200);
		const body = (await res?.json()) as { scopes_supported: string[] };

		expect(body.scopes_supported).toEqual([
			"mcp:content.admin",
			"mcp:content.read",
		]);
	});

	it("binds copied protected-resource overrides to the serving tenant host", async () => {
		getBySlugWithTools.mockResolvedValue({
			app: {
				id: "app_1",
				slug: "acme",
				metadata: {
					mcpConfig: {
						protectedResourceMetadata: {
							resource: "https://other-unified.mcp.tedix.dev/mcp",
							authorization_servers: ["https://auth.example.com"],
							scopes_supported: ["platform:admin"],
						},
					},
				},
			},
			tools: [],
		});
		const response = await handleWellKnown(oauthUrl, HOST, createEnv());
		expect(await response?.json()).toMatchObject({
			resource: "https://acme.mcp.tedix.tech/mcp",
			authorization_servers: ["https://auth.example.com"],
			scopes_supported: ["platform:admin"],
		});
		expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
		expect(response?.headers.has("Cache-Tag")).toBe(false);
	});
});
