import { describe, expect, test } from "bun:test";
import { TedixHomeClient } from "./home-client";

const MODERN = "2026-07-28";
const TASKS = "io.modelcontextprotocol/tasks";
const TASK_TIME = "2026-08-30T00:00:00.000Z";
const taskBase = (taskId: string) => ({
	taskId,
	createdAt: TASK_TIME,
	lastUpdatedAt: TASK_TIME,
	ttlMs: null,
});

describe("CLI MCP protocol certification", () => {
	test("lists resources through the modern request-bound transport", async () => {
		const requests: Array<{ method: string; headers: Headers }> = [];
		const client = new TedixHomeClient({
			url: "https://cert-unified.mcp.tedix.dev/mcp",
			headers: { Authorization: "Bearer certification" },
			fetch: async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as {
					id: string;
					method: string;
				};
				requests.push({
					method: body.method,
					headers: new Headers(init?.headers),
				});
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result:
						body.method === "server/discover"
							? { supportedVersions: [MODERN], capabilities: {} }
							: { resources: [{ uri: "ui://certification" }] },
				});
			},
		});
		const listed = await client.listResources();
		expect(listed).toEqual({
			resources: [{ uri: "ui://certification" }],
		});
		expect(requests.map((request) => request.method)).toEqual([
			"server/discover",
			"resources/list",
		]);
		expect(requests[1]?.headers.get("Mcp-Method")).toBe("resources/list");
		await client.close();
	});

	test("covers modern discovery, resources, MRTR, Tasks, and binding headers", async () => {
		const requests: Array<{
			body: { method: string; params: Record<string, unknown>; id: string };
			headers: Headers;
		}> = [];
		let governedCalls = 0;
		let taskPolls = 0;
		const fetch = async (
			_input: string | URL | Request,
			init?: RequestInit,
		) => {
			const body = JSON.parse(String(init?.body)) as {
				method: string;
				params: Record<string, unknown>;
				id: string;
			};
			requests.push({ body, headers: new Headers(init?.headers) });
			let result: unknown;
			if (body.method === "server/discover") {
				result = {
					supportedVersions: [MODERN],
					capabilities: { resources: {}, extensions: { [TASKS]: {} } },
				};
			} else if (body.method === "resources/read") {
				result = { contents: [{ uri: body.params.uri, text: "certified" }] };
			} else if (body.method === "tools/call") {
				const name = body.params.name;
				const args = body.params.arguments as
					| Record<string, unknown>
					| undefined;
				if (name === "code" && args?.code === "governed") {
					governedCalls++;
					result =
						governedCalls === 1
							? {
									resultType: "input_required",
									requestState: "signed-state",
									inputRequests: {
										approval: {
											method: "elicitation/create",
											params: {
												mode: "form",
												requestedSchema: { properties: { reason: {} } },
											},
										},
									},
								}
							: { structuredContent: { governed: true } };
				} else {
					result = {
						resultType: "task",
						...taskBase("task-cert"),
						status: "working",
					};
				}
			} else if (body.method === "tasks/get") {
				taskPolls++;
				result =
					taskPolls === 1
						? {
								resultType: "complete",
								...taskBase("task-cert"),
								status: "working",
								pollIntervalMs: 1,
							}
						: {
								resultType: "complete",
								...taskBase("task-cert"),
								taskId: "task-cert",
								status: "completed",
								result: { structuredContent: { task: "complete" } },
							};
			}
			return Response.json({ jsonrpc: "2.0", id: body.id, result });
		};
		const client = new TedixHomeClient({
			fetch,
			headers: { Authorization: "Bearer certification" },
			url: "https://cert-unified.mcp.tedix.dev/mcp",
		});

		await expect(client.discoverProtocol()).resolves.toMatchObject({
			supportedVersions: [MODERN],
		});
		await expect(client.readResource("skill://certification")).resolves.toEqual(
			{
				contents: [{ uri: "skill://certification", text: "certified" }],
			},
		);
		await expect(
			client.runCodeWithDestructiveApproval(
				"governed",
				"protocol certification",
			),
		).resolves.toEqual({ governed: true });
		await expect(client.callTool("async_cert", {})).resolves.toEqual({
			task: "complete",
		});
		await client.close();

		expect(requests.some(({ body }) => body.method === "initialize")).toBe(
			false,
		);
		expect(requests.map(({ body }) => body.method)).toEqual([
			"server/discover",
			"server/discover",
			"resources/read",
			"tools/call",
			"tools/call",
			"tools/call",
			"tasks/get",
			"tasks/get",
		]);
		for (const { body, headers } of requests) {
			expect(headers.get("MCP-Protocol-Version")).toBe(MODERN);
			expect(headers.get("Mcp-Method")).toBe(body.method);
			expect(headers.get("Authorization")).toBe("Bearer certification");
			expect(body.params._meta).toMatchObject({
				"io.modelcontextprotocol/protocolVersion": MODERN,
				"io.modelcontextprotocol/clientCapabilities": {
					extensions: { [TASKS]: {} },
					elicitation: { form: {} },
				},
			});
		}
		expect(
			requests
				.find(({ body }) => body.method === "resources/read")
				?.headers.get("Mcp-Name"),
		).toBe("skill://certification");
		expect(
			requests
				.find(({ body }) => body.method === "tasks/get")
				?.headers.get("Mcp-Name"),
		).toBe("task-cert");
		const governedRetry = requests.filter(
			({ body }) =>
				body.method === "tools/call" &&
				(body.params.arguments as Record<string, unknown> | undefined)?.code ===
					"governed",
		)[1]?.body.params;
		expect(governedRetry).toMatchObject({
			requestState: "signed-state",
			inputResponses: {
				approval: {
					action: "accept",
					content: { reason: "protocol certification" },
				},
			},
		});
	});
});
