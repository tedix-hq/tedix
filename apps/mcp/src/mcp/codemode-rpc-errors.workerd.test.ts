import { os, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import { buildMcpServer, type CachedAppData } from "./server-factory";

it("rejects first-party oRPC failures with code and status inside the real Code Mode sandbox", async () => {
	let calls = 0;
	const api = new RPCHandler({
		skills: {
			improve: os.handler(() => {
				calls++;
				throw new ORPCError("NOT_FOUND", { message: "Skill not found" });
			}),
		},
	});
	const cached = {
		app: {
			id: "fictional-app",
			slug: "fictional",
			name: "Fictional",
			organizationId: "fictional-org",
		},
		tools: [
			{
				id: "fictional-tool",
				toolId: "improve_skills",
				title: "Improve skills",
				description: "Improve a skill",
				toolTypeId: "rpc",
				enabled: true,
				config: { transport: "rpc", endpoint: "skills/improve" },
				inputSchema: { type: "object", properties: { id: { type: "string" } } },
				outputSchema: null,
				annotations: { readOnlyHint: true, destructiveHint: false },
			},
		],
		metadata: {
			mcpConfig: {
				codeMode: true,
				authMode: "authenticated",
				toolScopes: { improve_skills: ["mcp:skills.write"] },
			},
		},
		catalogMcp: null,
		catalogResources: [],
		catalogResourceTemplates: [],
		catalogPrompts: [],
		capabilities: {},
		expiresAt: Date.now() + 60_000,
	} as unknown as CachedAppData;
	const server = await buildMcpServer(
		cached,
		{ authType: "service", scopes: ["mcp:skills.write"] },
		{
			...env,
			API_SERVICE: {
				fetch: async (request: Request) => {
					const { response } = await api.handle(request, { prefix: "/rpc" });
					if (!response) throw new Error("Unmatched fixture procedure");
					return response;
				},
			},
		} as unknown as CloudflareEnv,
		{
			waitUntil(p: Promise<unknown>) {
				void p.catch(() => {});
			},
		} as ExecutionContext,
	);
	const [client, transport] = InMemoryTransport.createLinkedPair();
	const pending = new Map<number, (message: Record<string, unknown>) => void>();
	let id = 0;
	client.onmessage = (message) => {
		const value = message as unknown as Record<string, unknown>;
		if (typeof value.id === "number") {
			pending.get(value.id)?.(value);
			pending.delete(value.id);
		}
	};
	await server.connect(transport);
	async function request(method: string, params: Record<string, unknown>) {
		const next = ++id;
		const response = new Promise<Record<string, unknown>>((resolve) =>
			pending.set(next, resolve),
		);
		await client.send({ jsonrpc: "2.0", id: next, method, params } as never);
		return response;
	}
	try {
		await request("initialize", {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "fictional-errors", version: "1" },
		});
		await client.send({
			jsonrpc: "2.0",
			method: "notifications/initialized",
		} as never);
		const invoke = async (code: string) => {
			const response = await request("tools/call", {
				name: "code",
				arguments: { code },
			});
			expect(response.error).toBeUndefined();
			return response.result as {
				isError?: boolean;
				structuredContent: { result?: unknown };
			};
		};
		const caught = await invoke(`async () => {
			try { return { resolved: true, value: await skills.improve_skills({ id: "fictional-missing" }) }; }
			catch (error) { return { isError: error instanceof Error, code: error.code, status: error.status, message: error.message }; }
		}`);
		expect(calls).toBe(1);
		expect(caught.structuredContent.result).toEqual({
			isError: true,
			code: "NOT_FOUND",
			status: 404,
			message: "NOT_FOUND: Skill not found",
		});
		const uncaught = await invoke(
			'async () => await skills.improve_skills({ id: "fictional-missing" })',
		);
		expect(uncaught.isError).toBe(true);
		expect(calls).toBe(2);
	} finally {
		await server.close();
	}
});
