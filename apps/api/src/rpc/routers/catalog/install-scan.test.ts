import { describe, expect, it, vi } from "vite-plus/test";
import {
	resolveCatalogScanFetchFn,
	resolveCatalogScanHeaders,
	selectCatalogInstallCandidate,
} from "./install-scan";

const trust = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@tedix/db/queries/installation-trust", () => ({
	getInstallationTrustPolicy: trust.read,
}));

describe("selectCatalogInstallCandidate", () => {
	it("prefers an exact catalog alias over an earlier broad prose match", () => {
		const generic = {
			name: "CB Insights",
			keywordsForDiscovery: null,
			keywordsForTriggering: null,
		};
		const microsoft = {
			name: "Microsoft 365",
			keywordsForDiscovery: ["outlook", "microsoft outlook"],
			keywordsForTriggering: ["install outlook"],
		};

		expect(selectCatalogInstallCandidate("Outlook", [generic, microsoft])).toBe(
			microsoft,
		);
	});

	it("preserves relevance order when no exact alias exists", () => {
		const first = {
			name: "First",
			keywordsForDiscovery: ["calendar search"],
			keywordsForTriggering: null,
		};
		const second = {
			name: "Second",
			keywordsForDiscovery: null,
			keywordsForTriggering: ["calendar helper"],
		};

		expect(selectCatalogInstallCandidate("calendar", [first, second])).toBe(
			first,
		);
		expect(selectCatalogInstallCandidate("calendar", [])).toBeNull();
	});
});

describe("managed CMS scan route", () => {
	it("uses only an explicitly provisioned service binding endpoint", async () => {
		trust.read.mockResolvedValue({
			version: 1,
			aggregate: {
				sharedSourceOrganizationIds: [],
				aggregateHostOrganizationIds: [],
			},
			catalogScan: {
				endpoints: [
					{
						url: "https://builder.example/mcp?site=sample",
						transport: "cms",
						headers: {},
					},
				],
			},
		});
		const send = vi.fn(async () => new Response("ok"));
		const context = { db: {}, env: { CMS: { fetch: send } } } as never;
		const scan = await resolveCatalogScanFetchFn(
			context,
			"https://builder.example/mcp?site=sample",
		);
		expect(scan).toBeDefined();
		await scan!("https://builder.example/mcp?site=sample", { method: "POST" });
		expect(send).toHaveBeenCalledOnce();
		for (const endpoint of [
			"http://builder.example/mcp?site=sample",
			"https://builder.example/not-mcp",
			"https://builder.example.attacker.example/mcp?site=sample",
			"https://builder.example/mcp?site=other",
		]) {
			expect(
				await resolveCatalogScanFetchFn(context, endpoint),
			).toBeUndefined();
		}
	});
});

it("uses one grant snapshot for privileged headers and transport after publication changes", async () => {
	const policy = {
		version: 1 as const,
		aggregate: {
			sharedSourceOrganizationIds: [],
			aggregateHostOrganizationIds: [],
		},
		catalogScan: {
			endpoints: [
				{
					url: "https://builder.example/mcp",
					transport: "cms" as const,
					headers: {},
				},
			],
		},
	};
	trust.read.mockReset().mockResolvedValue(null);
	const send = vi.fn(async () => new Response("ok"));
	const context = {
		db: {},
		env: { PLATFORM_SERVICE_TOKEN: "platform-token", CMS: { fetch: send } },
	} as never;
	const headers = await resolveCatalogScanHeaders(
		context,
		{} as never,
		"https://builder.example/mcp",
		policy,
	);
	const scan = await resolveCatalogScanFetchFn(
		context,
		"https://builder.example/mcp",
		policy,
	);
	expect(headers).toEqual({ Authorization: "Bearer platform-token" });
	await scan!("https://builder.example/mcp", { headers });
	expect(send).toHaveBeenCalledOnce();
	expect(trust.read).not.toHaveBeenCalled();
	expect(
		await resolveCatalogScanHeaders(
			context,
			{} as never,
			"https://builder.example/mcp",
			null,
		),
	).toBeUndefined();
	expect(
		await resolveCatalogScanFetchFn(
			context,
			"https://builder.example/mcp",
			null,
		),
	).toBeUndefined();
	expect(trust.read).not.toHaveBeenCalled();
});
