import {
	isClientIdMetadataDocumentUrl,
	McpInboundClientPolicySchema,
} from "@tedix/api-contract/schemas/mcp-grant";
import { describe, expect, it } from "vite-plus/test";
import {
	evaluateInboundClientPolicy,
	parseStoredInboundClientPolicy,
} from "./mcp-inbound-client-policy";

const cimd = "https://client.example.test/oauth/client.json";
const client = { mcpServerId: "server-1", clientId: cimd };

describe("inbound client policy", () => {
	it("recognizes only exact https metadata document URLs as CIMD client IDs", () => {
		expect(isClientIdMetadataDocumentUrl(cimd)).toBe(true);
		for (const id of [
			"opaque-dcr-client",
			"http://client.example.test/client.json",
			"https://client.example.test/",
			"https://client.example.test",
			"https://client.example.test/client.json?x=1",
			"https://client.example.test/client.json#frag",
			"https://user:pass@client.example.test/client.json",
			"https://CLIENT.example.test/client.json",
		])
			expect(isClientIdMetadataDocumentUrl(id), id).toBe(false);
	});

	it.each([
		"mcp:apps.write",
		"mcp:work.admin",
		"connections.execute",
		"connections.admin",
		"platform:admin",
		"*",
		"unknown.read",
	])(
		"requires a live exact exception for a dynamic client's %s scope",
		(scope) => {
			const dynamic = {
				mcpServerId: "server-1",
				clientId: "dynamic-1",
				scopes: ["mcp:apps.read", scope],
			};
			const now = Date.parse("2026-10-26T12:00:00.000Z");
			for (const stored of [
				undefined,
				{ mode: "audit", entries: [] },
				{ mode: "enforce", entries: [] },
			]) {
				expect(evaluateInboundClientPolicy(stored, dynamic, now).allowed).toBe(
					false,
				);
			}
			for (const mode of ["audit", "enforce"]) {
				for (const [entry, allowed] of [
					[
						{
							mcpServerId: "server-1",
							clientId: "dynamic-1",
							expiresAt: "2026-10-27T12:00:00.000Z",
						},
						true,
					],
					[
						{
							mcpServerId: "server-1",
							clientId: "dynamic-1",
							expiresAt: "2026-10-26T12:00:00.000Z",
						},
						false,
					],
					[
						{
							mcpServerId: "other",
							clientId: "dynamic-1",
							expiresAt: "2026-10-27T12:00:00.000Z",
						},
						false,
					],
					[
						{
							mcpServerId: "server-1",
							clientId: "other",
							expiresAt: "2026-10-27T12:00:00.000Z",
						},
						false,
					],
				] as const) {
					expect(
						evaluateInboundClientPolicy(
							{ mode, entries: [entry] },
							dynamic,
							now,
						).allowed,
					).toBe(allowed);
				}
			}
		},
	);

	it("preserves read-only dynamic access and the CIMD policy boundary", () => {
		const dynamic = {
			mcpServerId: "server-1",
			clientId: "dynamic-1",
			scopes: ["mcp:apps.read", "connections.read", "openid"],
		};
		expect(evaluateInboundClientPolicy(undefined, dynamic).allowed).toBe(true);
		expect(
			evaluateInboundClientPolicy({ mode: "audit", entries: [] }, dynamic)
				.allowed,
		).toBe(true);
		expect(
			evaluateInboundClientPolicy({ mode: "enforce", entries: [] }, dynamic)
				.allowed,
		).toBe(false);
		const metadataClient = { ...client, scopes: ["mcp:apps.write"] };
		expect(evaluateInboundClientPolicy(undefined, metadataClient).allowed).toBe(
			true,
		);
		expect(
			evaluateInboundClientPolicy(
				{ mode: "enforce", entries: [] },
				metadataClient,
			).allowed,
		).toBe(false);
	});

	it("accepts an opaque client ID only as an expiring exception", () => {
		const entry = { mcpServerId: "server-1", clientId: "opaque-dcr-client" };
		expect(
			McpInboundClientPolicySchema.safeParse({
				mode: "enforce",
				entries: [entry],
			}).success,
		).toBe(false);
		expect(
			McpInboundClientPolicySchema.safeParse({
				mode: "enforce",
				entries: [{ ...entry, expiresAt: "2027-01-01T00:00:00.000Z" }],
			}).success,
		).toBe(true);
		expect(
			McpInboundClientPolicySchema.safeParse({
				mode: "enforce",
				entries: [{ mcpServerId: "server-1", clientId: cimd }],
			}).success,
		).toBe(true);
	});

	it("admits every client without a policy and in audit mode, but records the miss", () => {
		expect(evaluateInboundClientPolicy(undefined, client)).toEqual({
			mode: "none",
			listed: false,
			allowed: true,
		});
		expect(
			evaluateInboundClientPolicy({ mode: "audit", entries: [] }, client),
		).toEqual({ mode: "audit", listed: false, allowed: true });
	});

	it("enforces exact, unexpired entries and fails closed on an unreadable policy", () => {
		const now = Date.parse("2026-10-26T12:00:00.000Z");
		const policy = (entries: unknown[]) => ({ mode: "enforce", entries });
		expect(
			evaluateInboundClientPolicy(
				policy([{ mcpServerId: "server-1", clientId: cimd }]),
				client,
				now,
			),
		).toEqual({ mode: "enforce", listed: true, allowed: true });
		expect(
			evaluateInboundClientPolicy(
				policy([
					{
						mcpServerId: "server-1",
						clientId: cimd,
						expiresAt: "2026-10-26T11:59:59.000Z",
					},
				]),
				client,
				now,
			).allowed,
		).toBe(false);
		expect(
			evaluateInboundClientPolicy(
				policy([{ mcpServerId: "server-1", clientId: `${cimd}/` }]),
				client,
				now,
			).allowed,
		).toBe(false);
		expect(
			evaluateInboundClientPolicy(
				parseStoredInboundClientPolicy("{not json"),
				client,
			),
		).toEqual({ mode: "invalid", listed: false, allowed: false });
		expect(parseStoredInboundClientPolicy(null)).toBeNull();
	});
});
