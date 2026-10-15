import { describe, expect, test } from "bun:test";
import { MCP_MODERN_PROTOCOL_VERSION } from "@tedix/mcp-shared/protocol";
import { TedixHomeClient } from "./home-client";
import { parseMcpCallRequest, runMcpCall } from "./mcp-call";
import { parseOptions } from "./options";
import { resolveOrganizationTarget } from "./organization-target";

describe("tedix mcp call", () => {
	test("parses method, params and headers from argv", () => {
		const { command, options } = parseOptions([
			"-w",
			"acme",
			"mcp",
			"call",
			"events/poll",
			"--params",
			'{"cursor":"c1"}',
			"--header",
			"X-Probe=one",
			"--header=X-Other=two=2",
		]);
		expect(command).toBe("mcp");
		expect(options.workspace).toBe("acme");
		expect(
			parseMcpCallRequest({
				prompt: options.prompt,
				params: options.flowParams,
				headers: options.mcpHeader,
			}),
		).toEqual({
			method: "events/poll",
			params: { cursor: "c1" },
			headers: { "X-Probe": "one", "X-Other": "two=2" },
		});
	});

	test("rejects malformed requests and credential headers", () => {
		expect(() => parseMcpCallRequest({ prompt: "call" })).toThrow("Usage");
		expect(() => parseMcpCallRequest({ prompt: "list events/list" })).toThrow(
			"Usage",
		);
		expect(() =>
			parseMcpCallRequest({ prompt: "call events/list", params: "[1]" }),
		).toThrow("JSON object");
		expect(() =>
			parseMcpCallRequest({ prompt: "call events/list", params: "{" }),
		).toThrow("valid JSON");
		for (const header of [
			"Authorization=Bearer x",
			"cookie=a",
			"X-Tedix-Organization=other",
		]) {
			expect(() =>
				parseMcpCallRequest({ prompt: "call events/list", headers: [header] }),
			).toThrow("not allowed");
		}
		expect(() => parseOptions(["code", "x", "--header", "a=b"])).toThrow(
			"only valid with mcp call",
		);
	});

	test("keeps the aggregate surface unless an organization is targeted", () => {
		expect(
			resolveOrganizationTarget({
				url: "https://connect.mcp.tedix.dev/mcp",
				command: "mcp",
				workspace: "connect",
				environmentOrganization: "",
			}).headers,
		).toEqual({});
	});

	test("sends the stored login in-process and prints only the result", async () => {
		const seen: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
		const client = new TedixHomeClient({
			headers: { Authorization: "Bearer stored-secret-token" },
			url: "https://example.com/mcp",
			fetch: async (_url, init) => {
				const body = JSON.parse(String(init?.body));
				seen.push({ body, headers: new Headers(init?.headers) });
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result:
						body.method === "server/discover"
							? { supportedVersions: [MCP_MODERN_PROTOCOL_VERSION] }
							: { events: [{ id: "e1" }], cursor: "c2" },
				});
			},
		});
		try {
			const printed = await runMcpCall(client, {
				method: "events/list",
				params: { limit: 1 },
				headers: { "X-Probe": "one" },
			});
			expect(JSON.parse(printed)).toEqual({
				events: [{ id: "e1" }],
				cursor: "c2",
			});
			expect(printed).not.toContain("stored-secret-token");
			const call = seen.find((entry) => entry.body.method === "events/list");
			expect(call?.headers.get("authorization")).toBe(
				"Bearer stored-secret-token",
			);
			expect(call?.headers.get("x-probe")).toBe("one");
			expect(call?.body.params).toMatchObject({ limit: 1 });
		} finally {
			await client.close();
		}
	});
});
