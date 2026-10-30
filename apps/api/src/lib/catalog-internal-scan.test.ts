import { describe, expect, it, vi } from "vite-plus/test";
import { InstallationTrustPolicySchema } from "@tedix/api-contract/schemas/installation-trust";
import {
	getManagedCatalogScanEndpoint,
	createManagedCatalogScanFetch,
	resolveTedixInternalScanHeaders,
} from "./catalog-internal-scan";

const policy = InstallationTrustPolicySchema.parse({
	version: 1,
	aggregate: {
		sharedSourceOrganizationIds: [],
		aggregateHostOrganizationIds: [],
	},
	catalogScan: {
		endpoints: [
			{
				url: "https://builder.example/mcp",
				transport: "cms",
				headers: { "X-Tedix-Connection-Label": "sample-site" },
			},
			{
				url: "https://docs.example/mcp?org=sample",
				transport: "http",
				headers: {
					"X-Tedix-Connection-Label": "sample",
					"X-Tedix-Delegated-Scope": "mcp:content.read",
					"X-Tedix-Actor-Type": "service",
					"X-Tedix-Actor-Id": "catalog-scanner",
				},
			},
			{
				url: "https://sample.gateway.example/mcp/",
				transport: "mcp",
				headers: {},
			},
		],
	},
});

describe("managed MCP scan auth", () => {
	it.each(policy.catalogScan.endpoints.map((entry) => entry.url))(
		"recognizes an explicitly provisioned endpoint: %s",
		(endpoint) => {
			expect(getManagedCatalogScanEndpoint(endpoint, policy)?.url).toBe(
				endpoint,
			);
		},
	);

	it.each([
		"http://docs.example/mcp?org=sample",
		"https://docs.example/not-mcp?org=sample",
		"https://unconfigured.example/mcp",
		"https://docs.example.attacker.example/mcp?org=sample",
		"https://deep.sample.gateway.example/mcp/",
		"https://docs.example/mcp?org=other",
		"https://docs.example/mcp?org=sample&extra=1",
		"https://user:password@docs.example/mcp?org=sample",
		"https://docs.example/mcp?org=sample#fragment",
	])("does not send authority to an untrusted endpoint: %s", (endpoint) => {
		expect(getManagedCatalogScanEndpoint(endpoint, policy)).toBeUndefined();
		expect(
			resolveTedixInternalScanHeaders({
				endpoint,
				policy,
				platformServiceToken: "platform-token",
			}),
		).toBeUndefined();
	});

	it("requires both a private installation grant and a platform token", () => {
		const endpoint = "https://builder.example/mcp";
		expect(
			resolveTedixInternalScanHeaders({
				endpoint,
				policy: null,
				platformServiceToken: "platform-token",
			}),
		).toBeUndefined();
		expect(
			resolveTedixInternalScanHeaders({
				endpoint,
				policy,
				platformServiceToken: undefined,
			}),
		).toBeUndefined();
	});

	it("uses only the headers provisioned for the exact endpoint", () => {
		expect(
			resolveTedixInternalScanHeaders({
				endpoint: "https://docs.example/mcp?org=sample",
				policy,
				platformServiceToken: "platform-token",
			}),
		).toEqual({
			Authorization: "Bearer platform-token",
			"X-Tedix-Actor-Id": "catalog-scanner",
			"X-Tedix-Actor-Type": "service",
			"X-Tedix-Connection-Label": "sample",
			"X-Tedix-Delegated-Scope": "mcp:content.read",
		});
		expect(
			resolveTedixInternalScanHeaders({
				endpoint: "https://builder.example/mcp",
				policy,
				platformServiceToken: "platform-token",
			}),
		).toEqual({
			Authorization: "Bearer platform-token",
			"X-Tedix-Connection-Label": "sample-site",
		});
	});

	it("marks only a configured MCP service-binding route", () => {
		expect(
			resolveTedixInternalScanHeaders({
				endpoint: "https://sample.gateway.example/mcp/",
				policy,
				platformServiceToken: "platform-token",
			}),
		).toEqual({
			Authorization: "Bearer platform-token",
			"X-Service-Binding": "true",
		});
	});
	it("never follows a privileged scan redirect or a changed endpoint", async () => {
		const grant = policy.catalogScan.endpoints[1]!;
		const send = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(null, {
					status: 302,
					headers: { Location: "https://other.example/mcp" },
				}),
		);
		const scan = createManagedCatalogScanFetch(grant, {}, send);
		expect(
			(
				await scan(grant.url, {
					headers: { Authorization: "Bearer platform-token" },
				})
			).status,
		).toBe(302);
		expect(send).toHaveBeenCalledOnce();
		expect(send.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
		await expect(scan("https://other.example/mcp")).rejects.toThrow(
			"endpoint changed",
		);
		expect(send).toHaveBeenCalledOnce();
	});

	it("does not downgrade a missing service binding to public HTTP", () => {
		expect(() =>
			createManagedCatalogScanFetch(policy.catalogScan.endpoints[0]!, {}),
		).toThrow("binding is unavailable");
	});
});
