/**
 * `apps.getScopeManifest` documents the scopes an operator must configure in
 * Descope, so it has to name the scopes the MCP edge ENFORCES. It used to run
 * every tool through `toolToScope` — the resolver's `enforcePolicies: true`
 * branch — which described a policy model no coarse-mode app runs.
 *
 * Each case below is chosen so the two answers differ; the assertions are
 * cross-checked against `resolveMcpToolRequiredScopes` itself.
 */

import { createRouterClient } from "@orpc/server";
import { toolToScope } from "@tedix/mcp-shared/auth/scopes";
import {
	inferToolNamespace,
	resolveMcpToolRequiredScopes,
	resolveMcpToolNamespace,
} from "@tedix/mcp-shared/auth/tool-scopes";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	getAppById: vi.fn(),
	getToolsByAppId: vi.fn(),
}));

vi.mock("@tedix/db/queries/app-records", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, getAppById: mocks.getAppById };
});

vi.mock("@tedix/db/queries/tools", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, getToolsByAppId: mocks.getToolsByAppId };
});

import { appsContractRouter } from "./apps";

const ORG_ID = "org-1";
const APP_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";

type ToolOverrides = {
	toolId: string;
	toolTypeId?: string;
	config?: Record<string, unknown>;
	description?: string | null;
	annotations?: unknown;
	writeCapability?: string | null;
	authRequired?: boolean | null;
	visibility?: string | null;
};

function stubApp(metadata: unknown, tools: ToolOverrides[]) {
	mocks.getAppById.mockResolvedValue({
		id: APP_ID,
		slug: "acme",
		organizationId: ORG_ID,
		metadata,
	});
	mocks.getToolsByAppId.mockResolvedValue(
		tools.map((tool) => {
			const namespace = inferToolNamespace(tool.toolId);
			return {
				id: `tool-${tool.toolId}`,
				appId: APP_ID,
				toolTypeId: "rpc",
				config: { endpoint: `${namespace}/test` },
				description: null,
				annotations: null,
				writeCapability: null,
				authRequired: false,
				visibility: "public",
				enabled: true,
				...tool,
			};
		}),
	);
}

function enforcedScopes(
	tool: ToolOverrides,
	mcpConfig: Record<string, unknown> | undefined,
): string[] {
	const shape = {
		toolId: tool.toolId,
		toolTypeId: tool.toolTypeId ?? "rpc",
		config: tool.config ?? {
			endpoint: `${inferToolNamespace(tool.toolId)}/test`,
		},
		annotations: tool.annotations as never,
		writeCapability: tool.writeCapability as never,
		authRequired: tool.authRequired ?? undefined,
		visibility: tool.visibility ?? undefined,
	};
	return resolveMcpToolRequiredScopes(
		shape,
		resolveMcpToolNamespace(
			shape,
			mcpConfig?.codeModeNamespaces as Record<string, string> | undefined,
		),
		mcpConfig,
	);
}

function makeClient() {
	const context = {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG_ID,
		url: new URL("https://api.tedix.test/rpc/apps"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions: ["apps:read"],
			roles: [],
			sub: "user-1",
		},
	} as unknown as BaseContext;

	return createRouterClient(appsContractRouter, { context });
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("apps.getScopeManifest reports enforced scopes", () => {
	it("reports unmapped tools without losing the classified scope catalog", async () => {
		stubApp(null, [
			{
				toolId: "list_invoices",
				config: { endpoint: "content/listInvoices" },
				authRequired: true,
			},
			{
				toolId: "resolve_mcp_credentials",
				config: { endpoint: "mcpCredentials/resolve" },
				authRequired: true,
			},
		]);
		const manifest = await makeClient().getScopeManifest({ appId: APP_ID });
		expect(manifest.complete).toBe(false);
		expect(manifest.unclassifiedTools).toEqual(["resolve_mcp_credentials"]);
		expect(manifest.toolScopes.map((entry) => entry.toolName)).toEqual([
			"list_invoices",
		]);
	});

	it("lists the per-app toolScopes override, not the per-tool policy scope", async () => {
		const mcpConfig = {
			toolScopes: { list_invoices: ["mcp:content.write"] },
			scopeDescriptions: { "mcp:content.write": "Manage content & blog" },
		};
		const tool: ToolOverrides = { toolId: "list_invoices" };
		stubApp({ mcpConfig }, [tool]);
		expect(enforcedScopes(tool, mcpConfig)).toEqual(["mcp:content.write"]);
		// The scope the old derivation emitted, kept here so the case cannot
		// quietly stop discriminating.
		expect(toolToScope("list_invoices")).toBe("mcp:list.invoices");

		const manifest = await makeClient().getScopeManifest({ appId: APP_ID });

		expect(manifest.toolScopes).toEqual([
			{
				scope: "mcp:content.write",
				description: "Manage content & blog",
				toolName: "list_invoices",
				requiresConsent: true,
			},
		]);
	});

	it("keeps the per-tool policy scope for an enforcePolicies app", async () => {
		// Policy mode IS the `toolToScope` branch — the manifest must be unchanged
		// for these apps, which is what makes the coarse-mode fix safe to ship.
		const mcpConfig = { enforcePolicies: true };
		const tool: ToolOverrides = { toolId: "list_invoices" };
		stubApp({ mcpConfig }, [tool]);

		const manifest = await makeClient().getScopeManifest({ appId: APP_ID });

		expect(manifest.toolScopes.map((entry) => entry.scope)).toEqual([
			toolToScope("list_invoices"),
		]);
	});

	it("uses the domain admin scope for a declared-destructive tool", async () => {
		const destructive: ToolOverrides = {
			toolId: "sync_ledger",
			writeCapability: "destructive",
		};
		stubApp(null, [destructive]);
		expect(enforcedScopes(destructive, undefined)).toEqual([
			"mcp:content.admin",
		]);

		const manifest = await makeClient().getScopeManifest({ appId: APP_ID });

		expect(manifest.toolScopes.map((entry) => entry.scope)).toEqual([
			"mcp:content.admin",
		]);
	});

	it("omits a tool the edge requires no scope for", async () => {
		// There is nothing to configure in Descope for an unscoped tool. Emitting
		// `mcp:app.create` for it made operators provision a scope no request
		// ever asks for.
		const unscoped: ToolOverrides = { toolId: "app_create" };
		const destructive: ToolOverrides = {
			toolId: "sync_ledger",
			annotations: { destructiveHint: true },
		};
		stubApp(null, [unscoped, destructive]);
		expect(enforcedScopes(unscoped, undefined)).toEqual([]);

		const manifest = await makeClient().getScopeManifest({ appId: APP_ID });

		expect(manifest.toolScopes.map((entry) => entry.toolName)).toEqual([
			"sync_ledger",
		]);
	});

	it("still carries the server identity and platform scopes", async () => {
		stubApp(
			{
				mcpConfig: {
					descopeResourceId: "res-123",
					toolScopes: { list_invoices: ["mcp:content.write"] },
				},
			},
			[{ toolId: "list_invoices" }],
		);

		const manifest = await makeClient().getScopeManifest({ appId: APP_ID });

		expect(manifest.serverUrl).toBe("https://acme.mcp.tedix.dev");
		expect(manifest.descopeResourceId).toBe("res-123");
		expect(manifest.platformScopes.length).toBeGreaterThan(0);
	});
});
