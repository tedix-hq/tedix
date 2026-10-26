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
