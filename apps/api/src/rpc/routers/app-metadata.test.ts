import { describe, expect, it } from "vite-plus/test";
import { mergeAppMetadataPatch, normalizeAppMetadata } from "./app-metadata";

describe("normalizeAppMetadata", () => {
	it("materializes current mcpConfig defaults", () => {
		const metadata = normalizeAppMetadata({
			mcpConfig: {
				serverName: "CMS",
				aggregateApps: [{ slug: "cms" }],
			},
		});

		expect(metadata.mcpConfig).toMatchObject({
			serverName: "CMS",
			authMode: "authenticated",
			capabilities: [],
			enforcePolicies: false,
			aggregateApps: [{ slug: "cms" }],
		});
	});

	it("materializes scope sync defaults for partial live rows", () => {
		const metadata = normalizeAppMetadata({
			mcpConfig: {
				scopeSync: {
					lastSyncedAt: "2026-05-11T19:41:38.592Z",
					lastError: null,
				},
			},
		});

		expect(metadata.mcpConfig?.scopeSync).toEqual({
			enabled: false,
			strategy: "descope-api",
			lastSyncedAt: "2026-05-11T19:41:38.592Z",
		});
	});

	it("drops removed custom Descope management endpoint fallbacks", () => {
		const metadata = normalizeAppMetadata({
			mcpConfig: {
				scopeSync: {
					registerPath: "/legacy/create",
					syncPathTemplate: "/legacy/{resourceId}",
					syncMethod: "PATCH",
				},
			},
		});

		expect(metadata.mcpConfig?.scopeSync).toEqual({
			enabled: false,
			strategy: "descope-api",
		});
	});

	it("removes stale blogConfig language without mutating the caller object", () => {
		const input = {
			blogConfig: {
				enabled: true,
				language: "de",
				imageGeneration: {},
			},
		};

		const metadata = normalizeAppMetadata(input);

		expect(metadata.blogConfig).toMatchObject({
			enabled: true,
			imageGeneration: { enabled: false },
		});
		expect("language" in (metadata.blogConfig as Record<string, unknown>)).toBe(
			false,
		);
		expect("language" in input.blogConfig).toBe(true);
	});
});

describe("mergeAppMetadataPatch", () => {
	it("removes an app-level Connection binding without persisting the null sentinel", () => {
		const merged = mergeAppMetadataPatch(
			{
				mcpConfig: {
					authMode: "authenticated",
					aggregateApps: [{ slug: "tedix-docs" }],
					connectionProviderId: "github",
					connectionScope: "tenant",
					connectionScopes: ["repo"],
					credentialProfile: { helpText: "Connect GitHub" },
				},
			},
			{ mcpConfig: { connectionProviderId: null } },
		);

		expect(merged.mcpConfig).toMatchObject({
			authMode: "authenticated",
			aggregateApps: [{ slug: "tedix-docs" }],
		});
		expect(merged.mcpConfig).not.toHaveProperty("connectionProviderId");
		expect(merged.mcpConfig).not.toHaveProperty("connectionScope");
		expect(merged.mcpConfig).not.toHaveProperty("connectionScopes");
		expect(merged.mcpConfig).not.toHaveProperty("credentialProfile");
	});
});
