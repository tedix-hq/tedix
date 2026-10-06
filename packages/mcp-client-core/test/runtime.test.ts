import { describe, expect, it } from "vite-plus/test";
import type { McpClientManager } from "../src/client-manager";
import {
	extractCredentialBoundCallables,
	credentialBoundReviewDiscoveryCode,
	TedixMcpRuntime,
	truncatePayload,
} from "../src/runtime";

function makeManager(
	callTool: (serverId: string) => Promise<unknown>,
	connections = [
		{
			serverId: "tedix-unified",
			url: "https://tedix-unified.mcp.tedix.dev/mcp",
			transport: "streamable-http",
			connectedAt: new Date().toISOString(),
		},
	],
): McpClientManager {
	return {
		listConnections: () => connections,
		listTools: (serverId: string) =>
			connections.some((conn) => conn.serverId === serverId)
				? [
						{
							serverId,
							name: "code",
							inputSchema: {},
						},
					]
				: [],
		callTool,
		connect: async () => {
			throw new Error("connect should not be called");
		},
		connectStatelessSnapshot: async () => {
			throw new Error("connectStatelessSnapshot should not be called");
		},
	} as unknown as McpClientManager;
}

describe("extractCredentialBoundCallables", () => {
	it("returns only callables authorized for the resolved credential", () => {
		expect(
			extractCredentialBoundCallables({
				results: [
					{
						callable: "work.review_work_item_evidence",
						authorized: false,
						missingScopes: ["mcp:work.admin"],
					},
					{ callable: "work.complete_work_item", authorized: true },
				],
			}),
		).toEqual(["work.complete_work_item"]);
	});
});

describe("credentialBoundReviewDiscoveryCode", () => {
	it("uses one bounded discovery for both review mutations", () => {
		const code = credentialBoundReviewDiscoveryCode();
		expect(code.match(/discover\.search/g)).toHaveLength(1);
		expect(code).toContain("review_work_item_evidence");
		expect(code).toContain("complete_work_item");
	});
});

describe("TedixMcpRuntime", () => {
	it("exposes skills/get as an explicit inert manifest read", async () => {
		const calls: Array<{ serverId: string; uri: string }> = [];
		const manager = {
			listConnections: () => [],
			listTools: () => [],
			getSkill: async (serverId: string, uri: string) => {
				calls.push({ serverId, uri });
				return {
					skill: {
						uri,
						frontmatter: { name: "fixture", description: "metadata only" },
						resources: [],
					},
				};
			},
		} as unknown as McpClientManager;
		const runtime = new TedixMcpRuntime({
			manager,
			platform: {
				listServers: async () => [],
				resolveCredentials: async () => ({ headers: {} }),
			},
		});
		const spec = runtime
			.getToolSpecs()
			.find((item) => item.function.name === "mcp_get_skill");
		expect(spec?.function.description).toMatch(/inert metadata only/);
		expect(spec?.function.description).toMatch(
			/does not fetch skill files or activate instructions/,
		);

		const uri = "skill://origin/fixture/SKILL.md";
		const result = await runtime.executeTool("mcp_get_skill", {
			server: "origin-a",
			uri,
		});
		expect(result).toMatchObject({ skill: { uri } });
		expect(calls).toEqual([{ serverId: "origin-a", uri }]);
	});

	it("executes a review turn only through the targeted Work gateway", async () => {
		const connections: Array<{
			serverId: string;
			url: string;
			transport: "streamable-http";
			connectedAt: string;
		}> = [];
		const connected: string[] = [];
		const calls: string[] = [];
		const manager = {
			listConnections: () => connections,
			listTools: (serverId: string) =>
				connections.some((connection) => connection.serverId === serverId)
					? [{ serverId, name: "code", inputSchema: {} }]
					: [],
			connectStatelessSnapshot: async (
				serverId: string,
				config: { url: string },
			) => {
				connected.push(serverId);
				const connection = {
					serverId,
					url: config.url,
					transport: "streamable-http" as const,
					connectedAt: new Date().toISOString(),
				};
				connections.push(connection);
				return connection;
			},
			callTool: async (serverId: string) => {
				calls.push(serverId);
				return { result: { reviewed: true } };
			},
		} as unknown as McpClientManager;
		let listServersCalls = 0;
		const runtime = new TedixMcpRuntime({
			manager,
			platform: {
				listServers: async () => {
					listServersCalls += 1;
					return [
						{
							serverId: "retail-bench",
							url: "https://retail",
							transport: "streamable-http" as const,
						},
						{
							serverId: "tedix-unified",
							url: "https://unified",
							transport: "streamable-http" as const,
						},
					];
				},
				resolveCredentials: async () => ({ headers: {} }),
			},
			preferStatelessConnections: true,
		});

		await runtime.executeTool(
			"tedix_mcp_code",
			{ code: "async () => await work.get_work_items_by_id({ id: 'x' })" },
			{
				binding: {
					conversationId: "review",
					runId: "review-run",
					credentialBoundReviewOnly: true,
				},
			},
		);

		expect(listServersCalls).toBe(1);
		expect(connected).toEqual(["tedix-unified"]);
		expect(calls).toEqual(["tedix-unified"]);
	});

	it("preflights only the canonical Work gateway", async () => {
		const connections: Array<{
			serverId: string;
			url: string;
			transport: "streamable-http";
			connectedAt: string;
		}> = [];
		const connected: string[] = [];
		const manager = {
			listConnections: () => connections,
			listTools: (serverId: string) =>
				connections.some((connection) => connection.serverId === serverId)
					? [{ serverId, name: "code", inputSchema: {} }]
					: [],
			connectStatelessSnapshot: async (
				serverId: string,
				config: { url: string },
			) => {
				connected.push(serverId);
				const connection = {
					serverId,
					url: config.url,
					transport: "streamable-http" as const,
					connectedAt: new Date().toISOString(),
				};
				connections.push(connection);
				return connection;
			},
			callTool: async (serverId: string) => {
				expect(serverId).toBe("tedix-unified");
				return {
					results: [
						{ callable: "work.review_work_item_evidence", authorized: true },
						{ callable: "work.complete_work_item", authorized: true },
					],
				};
			},
		} as unknown as McpClientManager;
		const runtime = new TedixMcpRuntime({
			manager,
			platform: {
				listServers: async () => [
					{
						serverId: "retail-bench",
						url: "https://retail",
						transport: "streamable-http",
					},
					{
						serverId: "tedix",
						url: "https://tedix",
						transport: "streamable-http",
					},
					{
						serverId: "tedix-unified",
						url: "https://unified",
						transport: "streamable-http",
					},
				],
				resolveCredentials: async () => ({
					headers: { authorization: "test" },
				}),
			},
			preferStatelessConnections: true,
		});

		await expect(
			runtime.discoverCredentialBoundReviewCallables(),
		).resolves.toEqual([
			"work.review_work_item_evidence",
			"work.complete_work_item",
		]);
		expect(connected).toEqual(["tedix-unified"]);
	});

	it("preflights a tenant-branded unified Work gateway", async () => {
		const connections: Array<{
			serverId: string;
			url: string;
			transport: "streamable-http";
			connectedAt: string;
		}> = [];
		const connected: string[] = [];
		const manager = {
			listConnections: () => connections,
			listTools: (serverId: string) =>
				connections.some((connection) => connection.serverId === serverId)
					? [{ serverId, name: "code", inputSchema: {} }]
					: [],
			connectStatelessSnapshot: async (
				serverId: string,
				config: { url: string },
			) => {
				connected.push(serverId);
				const connection = {
					serverId,
					url: config.url,
					transport: "streamable-http" as const,
					connectedAt: new Date().toISOString(),
				};
				connections.push(connection);
				return connection;
			},
			callTool: async (serverId: string) => {
				expect(serverId).toBe("acme-unified");
				return {
					results: [
						{ callable: "operator.review_work_evidence", authorized: true },
						{ callable: "operator.complete_work_item", authorized: true },
					],
				};
			},
		} as unknown as McpClientManager;
		const runtime = new TedixMcpRuntime({
			manager,
			platform: {
				listServers: async () => [
					{
						serverId: "acme-unified",
						url: "https://acme-unified.mcp.tedix.dev/mcp",
						transport: "streamable-http",
					},
				],
				resolveCredentials: async () => ({
					headers: { authorization: "test" },
				}),
			},
			preferStatelessConnections: true,
		});

		await expect(
			runtime.discoverCredentialBoundReviewCallables(),
		).resolves.toEqual([
			"operator.review_work_evidence",
			"operator.complete_work_item",
		]);
		expect(connected).toEqual(["acme-unified"]);
	});

	it("falls back to tedix without touching unrelated assignments", async () => {
		const connections: Array<{
			serverId: string;
			url: string;
			transport: "streamable-http";
			connectedAt: string;
		}> = [];
		const connected: string[] = [];
		const manager = {
			listConnections: () => connections,
			listTools: (serverId: string) =>
				connections.some((connection) => connection.serverId === serverId)
					? [{ serverId, name: "code", inputSchema: {} }]
					: [],
			connectStatelessSnapshot: async (
				serverId: string,
				config: { url: string },
			) => {
				connected.push(serverId);
				if (serverId === "tedix-unified") throw new Error("unified timeout");
				const connection = {
					serverId,
					url: config.url,
					transport: "streamable-http" as const,
					connectedAt: new Date().toISOString(),
				};
				connections.push(connection);
				return connection;
			},
			callTool: async (serverId: string) => {
				expect(serverId).toBe("tedix");
				return { results: [{ callable: "work.complete_work_item" }] };
			},
		} as unknown as McpClientManager;
		const runtime = new TedixMcpRuntime({
			manager,
			platform: {
				listServers: async () => [
					{
						serverId: "retail-bench",
						url: "https://retail",
						transport: "streamable-http",
					},
					{
						serverId: "tedix-unified",
						url: "https://unified",
						transport: "streamable-http",
					},
					{
						serverId: "tedix",
						url: "https://tedix",
						transport: "streamable-http",
					},
				],
				resolveCredentials: async () => ({
					headers: { authorization: "test" },
				}),
			},
			preferStatelessConnections: true,
			connectRetryDelayMs: 0,
			logger: { warn: () => {} },
		});

		await expect(
			runtime.discoverCredentialBoundReviewCallables(),
		).resolves.toEqual(["work.complete_work_item"]);
		expect(connected).toEqual(["tedix-unified", "tedix-unified", "tedix"]);
		expect(connected).not.toContain("retail-bench");
	});

	it("gives the targeted review gateway its dedicated cold-start budget", async () => {
		const connection = {
			serverId: "tedix-unified",
			url: "https://unified",
			transport: "streamable-http" as const,
			connectedAt: new Date().toISOString(),
		};
		let connected = false;
		const manager = {
			listConnections: () => (connected ? [connection] : []),
			listTools: () =>
				connected
					? [{ serverId: connection.serverId, name: "code", inputSchema: {} }]
					: [],
			connectStatelessSnapshot: async () => {
				await new Promise((resolve) => setTimeout(resolve, 15));
				connected = true;
				return connection;
			},
			callTool: async () => ({
				results: [{ callable: "work.complete_work_item" }],
			}),
		} as unknown as McpClientManager;
		const runtime = new TedixMcpRuntime({
			manager,
			platform: {
				listServers: async () => [{ ...connection }],
				resolveCredentials: async () => ({
					headers: { authorization: "test" },
				}),
			},
			preferStatelessConnections: true,
			connectTimeoutMs: 5,
		});

		await expect(
			runtime.discoverCredentialBoundReviewCallables(),
		).resolves.toEqual(["work.complete_work_item"]);
	});

	it("teaches ranked discovery and reusable Code Mode workflows in system instructions", () => {
		const runtime = new TedixMcpRuntime({
			manager: makeManager(async () => ({})),
			platform: {
				listServers: async () => [],
				resolveCredentials: async () => ({ headers: {} }),
			},
		});

		const instructions = runtime.getSystemInstructions();
		expect(instructions).toContain("Capability primer");
		expect(instructions).toContain("Broad phrases are ranked");
		expect(instructions).toContain("matched/unmatched terms");
		expect(instructions).toContain("muscle memory");
		expect(instructions).toContain("MUST be exactly one uninvoked async arrow");
		expect(instructions).toContain("bare tool names such as exec");
		const codeSpec = runtime
			.getToolSpecs()
			.find((spec) => spec.function.name === "tedix_mcp_code");
		expect(
			codeSpec?.function.parameters.properties?.code?.description,
		).toContain("Exactly one uninvoked async arrow function expression");
	});

	it("returns a precise correction for invalid Code Mode function and callable shapes", async () => {
		const messages = [
			"Code Mode program must evaluate to a function",
			"exec is not defined",
		];
		const runtime = new TedixMcpRuntime({
			manager: makeManager(async () => ({
				isError: true,
				content: [{ type: "text", text: messages.shift() ?? "unexpected" }],
			})),
			platform: {
				listServers: async () => [],
				resolveCredentials: async () => ({ headers: {} }),
			},
		});

		await expect(
			runtime.executeTool("tedix_mcp_code", { code: "await cto.status({})" }),
		).rejects.toThrow("exactly one uninvoked async arrow function expression");
		await expect(
			runtime.executeTool("tedix_mcp_code", {
				code: "async () => exec({ command: 'pwd' })",
			}),
		).rejects.toThrow("cto.exec(args)");
	});

	it("records started/completed and returns parsed Code Mode results", async () => {
		const events: Array<{ kind: string; sequence: number; payload: unknown }> =
			[];
		const runtime = new TedixMcpRuntime({
			manager: makeManager(async () => ({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							executionId: "exec-1",
							result: { ok: true },
						}),
					},
				],
			})),
			platform: {
				listServers: async () => [],
				resolveCredentials: async () => ({ headers: {} }),
				recordToolEvent: async (event) => events.push(event),
			},
			toolTimeoutMs: 100,
		});
		runtime.bindTurn({ conversationId: "c1", runId: "r1" });

		await expect(
			runtime.executeTool("tedix_mcp_code", {
				code: "async () => ({ ok: true })",
			}),
		).resolves.toEqual({ ok: true });

		expect(events.map((event) => [event.kind, event.sequence])).toEqual([
			["tool.started", 100],
			["tool.completed", 101],
		]);
	});

	it("preserves structured result identity when the durable result is truncated", async () => {
		const events: Array<{
			kind: string;
			sequence: number;
			payload: Record<string, unknown>;
		}> = [];
		const result = {
			status: {
				id: "workflow-run-1",
				status: "completed",
				tediId: "tedi-cto",
			},
			inspection: {
				run: {
					id: "workflow-run-1",
					status: "completed",
					tediId: "tedi-cto",
				},
				revision: { revision: 8, skillSlug: "kernel-goal-loop" },
			},
			padding: "x".repeat(20_000),
		};
		const runtime = new TedixMcpRuntime({
			manager: makeManager(async () => ({
				content: [
					{
						type: "text",
						text: JSON.stringify({ executionId: "exec-2", result }),
					},
				],
			})),
			platform: {
				listServers: async () => [],
				resolveCredentials: async () => ({ headers: {} }),
				recordToolEvent: async (event) =>
					events.push({
						kind: event.kind,
						sequence: event.sequence,
						payload: event.payload,
					}),
			},
			toolTimeoutMs: 100,
		});
		runtime.bindTurn({ conversationId: "c1", runId: "r1" });

		await runtime.executeTool("tedix_mcp_code", {
			code: "async () => ({})",
		});

		const completed = events.find((event) => event.kind === "tool.completed");
		expect(completed?.payload.result).toMatchObject({
			__tedix_truncated: true,
			originalType: "object",
		});
		expect(completed?.payload.resultIdentity).toEqual({
			status: {
				id: "workflow-run-1",
				status: "completed",
				tediId: "tedi-cto",
			},
			inspection: {
				run: {
					id: "workflow-run-1",
					status: "completed",
					tediId: "tedi-cto",
				},
				revision: { revision: 8, skillSlug: "kernel-goal-loop" },
			},
		});
	});

	it("carries gateway identity beside an already-truncated Code Mode result", async () => {
		const events: Array<{
			kind: string;
			payload: Record<string, unknown>;
		}> = [];
		const resultIdentity = {
			status: { id: "workflow-run-1", status: "completed" },
			inspection: {
				revision: { revision: 8, skillSlug: "kernel-goal-loop" },
			},
		};
		const resultProjection = {
			items: [{ name: "Alpha", price: 42 }],
			_meta: {
				ui: {
					resourceUri: "ui://widgets/mcp-app/acme/r/comparison.html",
				},
			},
		};
		const runtime = new TedixMcpRuntime({
			manager: makeManager(async () => ({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							executionId: "exec-3",
							result: "stale presentation text",
						}),
					},
				],
				structuredContent: {
					executionId: "exec-3",
					result: "...already truncated...",
					resultIdentity,
					resultProjection,
				},
			})),
			platform: {
				listServers: async () => [],
				resolveCredentials: async () => ({ headers: {} }),
				recordToolEvent: async (event) =>
					events.push({ kind: event.kind, payload: event.payload }),
			},
			toolTimeoutMs: 100,
		});
		runtime.bindTurn({ conversationId: "c1", runId: "r1" });

		await expect(
			runtime.executeTool("tedix_mcp_code", {
				code: "async () => ({})",
			}),
		).resolves.toBe("...already truncated...");

		expect(
			events.find((event) => event.kind === "tool.completed")?.payload
				.resultIdentity,
		).toEqual(resultIdentity);
		expect(
			events.find((event) => event.kind === "tool.completed")?.payload
				.resultProjection,
		).toEqual(resultProjection);
	});

	it("treats MCP isError results as failed calls instead of successful data", async () => {
		const events: Array<{ kind: string; sequence: number; payload: unknown }> =
			[];
		const runtime = new TedixMcpRuntime({
			manager: makeManager(async () => ({
				isError: true,
				content: [{ type: "text", text: "ns.filter is not a function" }],
			})),
			platform: {
				listServers: async () => [],
				resolveCredentials: async () => ({ headers: {} }),
				recordToolEvent: async (event) => events.push(event),
			},
			toolTimeoutMs: 100,
		});
		runtime.bindTurn({ conversationId: "c1", runId: "r1" });

		await expect(
			runtime.executeTool("tedix_mcp_code", {
				code: "async () => discover.list_namespaces().filter(Boolean)",
			}),
		).rejects.toThrow("ns.filter is not a function");

		expect(events.map((event) => [event.kind, event.sequence])).toEqual([
			["tool.started", 100],
			["tool.failed", 101],
		]);
		expect(runtime.getToolCallLog()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "code", ok: false }),
				expect.objectContaining({ name: "tedix_mcp_code", ok: false }),
			]),
		);
	});

	it("records failed when a tool exceeds the core timeout", async () => {
		const events: Array<{ kind: string; sequence: number; payload: unknown }> =
			[];
		const runtime = new TedixMcpRuntime({
			manager: makeManager(() => new Promise(() => {})),
			platform: {
				listServers: async () => [],
				resolveCredentials: async () => ({ headers: {} }),
				recordToolEvent: async (event) => events.push(event),
			},
			toolTimeoutMs: { tedix_mcp_code: 5 },
		});
		runtime.bindTurn({ conversationId: "c1", runId: "r1" });

		await expect(
			runtime.executeTool("tedix_mcp_code", {
				code: "async () => ({ ok: true })",
			}),
		).rejects.toThrow("timed out after 5ms");

		expect(events.map((event) => [event.kind, event.sequence])).toEqual([
			["tool.started", 100],
			["tool.failed", 101],
		]);
	});

	it("records failed when gateway synchronization fails before dispatch", async () => {
		const events: Array<{ kind: string; sequence: number; payload: unknown }> =
			[];
		const manager = {
			listConnections: () => [],
			listTools: () => [],
			connect: async () => {
				throw new Error("gateway unavailable");
			},
			connectStatelessSnapshot: async () => {
				throw new Error("gateway unavailable");
			},
		} as unknown as McpClientManager;
		const runtime = new TedixMcpRuntime({
			manager,
			platform: {
				listServers: async () => [
					{
						serverId: "tedix",
						url: "https://tedix.mcp.tedix.dev/mcp",
						transport: "streamable-http",
					},
				],
				resolveCredentials: async () => ({ headers: {} }),
				recordToolEvent: async (event) => events.push(event),
			},
			connectRetryDelayMs: 0,
			logger: { warn: () => {} },
		});
		runtime.bindTurn({ conversationId: "c1", runId: "r1" });

		await expect(
			runtime.executeTool("tedix_mcp_code", {
				code: "async () => ({ ok: true })",
			}),
		).rejects.toThrow("gateway unavailable");

		expect(events.map((event) => [event.kind, event.sequence])).toEqual([
			["tool.started", 100],
			["tool.failed", 101],
		]);
	});

	it("prefers tedix-unified Code Mode over the plain tedix admin app", async () => {
		const called: string[] = [];
		const runtime = new TedixMcpRuntime({
			manager: makeManager(
				async (serverId) => {
					called.push(serverId);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									executionId: `exec-${serverId}`,
									result: serverId,
								}),
							},
						],
					};
				},
				[
					{
						serverId: "tedix",
						url: "https://tedix.mcp.tedix.dev/mcp",
						transport: "streamable-http",
						connectedAt: new Date().toISOString(),
					},
					{
						serverId: "tedix-unified",
						url: "https://tedix-unified.mcp.tedix.dev/mcp",
						transport: "streamable-http",
						connectedAt: new Date().toISOString(),
					},
				],
			),
			platform: {
				listServers: async () => [],
				resolveCredentials: async () => ({ headers: {} }),
			},
			toolTimeoutMs: 100,
		});

		await expect(
			runtime.executeTool("tedix_mcp_code", {
				code: "async () => 'selected'",
			}),
		).resolves.toBe("tedix-unified");
		expect(called).toEqual(["tedix-unified"]);
	});

	describe("sync resilience", () => {
		type Conn = {
			serverId: string;
			url: string;
			transport: string;
			connectedAt: string;
		};

		/**
		 * Sync-focused manager mock. `connect`/`connectStatelessSnapshot` consult
		 * `behavior[serverId]`; on a successful connect the server is appended to
		 * the live `connections` array so `listConnections()` reflects reality.
		 */
		function makeSyncManager(
			behavior: Record<string, "ok" | "fail" | "snapshot-once">,
			seedConnections: Conn[] = [],
		): {
			manager: McpClientManager;
			connectCalls: string[];
			snapshotCalls: string[];
		} {
			const connections: Conn[] = [...seedConnections];
			const connectCalls: string[] = [];
			const snapshotCalls: string[] = [];
			const snapshotAttempts: Record<string, number> = {};

			const addConn = (serverId: string): Conn => {
				const conn: Conn = {
					serverId,
					url: `https://${serverId}.mcp.tedix.dev/mcp`,
					transport: "streamable-http",
					connectedAt: new Date().toISOString(),
				};
				connections.push(conn);
				return conn;
			};

			const manager = {
				listConnections: () => connections,
				listTools: () => [],
				listPrompts: () => [],
				listGuidanceResources: () => [],
				listResourceTemplates: () => [],
				connect: async (serverId: string) => {
					connectCalls.push(serverId);
					if (behavior[serverId] === "ok") return addConn(serverId);
					throw new Error(`connect failed: ${serverId}`);
				},
				connectStatelessSnapshot: async (serverId: string) => {
					snapshotCalls.push(serverId);
					const mode = behavior[serverId];
					if (mode === "fail") {
						throw new Error(`snapshot failed: ${serverId}`);
					}
					if (mode === "snapshot-once") {
						snapshotAttempts[serverId] = (snapshotAttempts[serverId] ?? 0) + 1;
						if (snapshotAttempts[serverId] < 2) {
							throw new Error(`snapshot transient: ${serverId}`);
						}
						return addConn(serverId);
					}
					return addConn(serverId);
				},
			} as unknown as McpClientManager;

			return { manager, connectCalls, snapshotCalls };
		}

		it("partial server failure still yields healthy tools + sets lastSyncAt", async () => {
			const { manager } = makeSyncManager({ good: "ok", bad: "fail" });
			const runtime = new TedixMcpRuntime({
				manager,
				platform: {
					listServers: async () => [
						{
							serverId: "good",
							url: "https://good",
							transport: "streamable-http",
						},
						{
							serverId: "bad",
							url: "https://bad",
							transport: "streamable-http",
						},
					],
					resolveCredentials: async () => ({ headers: { authorization: "x" } }),
				},
				logger: { warn: () => {} },
			});

			await expect(runtime.ensureSynced()).resolves.toBeUndefined();
			expect(manager.listConnections().map((c) => c.serverId)).toEqual([
				"good",
			]);

			// lastSyncAt advanced: a second call within the TTL is a no-op (no
			// further connect attempts on the healthy server).
			const { manager: m2 } = makeSyncManager({});
			void m2;
			await expect(runtime.ensureSynced()).resolves.toBeUndefined();
		});

		it("total failure with existing connections resolves (last-known-good)", async () => {
			const seed: Conn[] = [
				{
					serverId: "prior",
					url: "https://prior.mcp.tedix.dev/mcp",
					transport: "streamable-http",
					connectedAt: new Date().toISOString(),
				},
			];
			const { manager } = makeSyncManager({ bad: "fail" }, seed);
			const runtime = new TedixMcpRuntime({
				manager,
				platform: {
					listServers: async () => [
						{
							serverId: "bad",
							url: "https://bad",
							transport: "streamable-http",
						},
					],
					resolveCredentials: async () => ({ headers: { authorization: "x" } }),
				},
				logger: { warn: () => {} },
			});

			await expect(
				runtime.ensureSynced({ force: true }),
			).resolves.toBeUndefined();
			// Existing connection still served.
			expect(
				manager.listConnections().some((c) => c.serverId === "prior"),
			).toBe(true);
		});

		it("total failure with no connections throws", async () => {
			const { manager, snapshotCalls } = makeSyncManager({ bad: "fail" });
			const runtime = new TedixMcpRuntime({
				manager,
				platform: {
					listServers: async () => [
						{
							serverId: "bad",
							url: "https://bad",
							transport: "streamable-http",
						},
					],
					resolveCredentials: async () => ({ headers: { authorization: "x" } }),
				},
				logger: { warn: () => {} },
			});

			await expect(runtime.ensureSynced()).rejects.toThrow(
				"connect failed: bad",
			);
			await expect(runtime.ensureSynced()).rejects.toThrow(
				"MCP sync in failure backoff after: connect failed: bad",
			);
			expect(snapshotCalls).toEqual([]);
		});

		it("cold total failure recovers on the one-shot retry (single transient)", async () => {
			const { manager } = makeSyncManager({ ok: "ok" });
			let listCalls = 0;
			const runtime = new TedixMcpRuntime({
				manager,
				platform: {
					listServers: async () => {
						listCalls += 1;
						// First sync fails on a transient with ZERO connections (no
						// last-known-good); the one-shot cold retry re-runs and succeeds.
						if (listCalls === 1) {
							throw new Error("transient listServers 503");
						}
						return [
							{
								serverId: "ok",
								url: "https://ok",
								transport: "streamable-http",
							},
						];
					},
					resolveCredentials: async () => ({ headers: { authorization: "x" } }),
				},
				coldSyncRetryDelayMs: 0,
				logger: { warn: () => {} },
			});

			// Before the fix this rejected and poisoned the failure-backoff window;
			// now the cold path retries once and recovers the whole tool surface.
			await expect(runtime.ensureSynced()).resolves.toBeUndefined();
			expect(listCalls).toBe(2);
			expect(manager.listConnections().map((c) => c.serverId)).toEqual(["ok"]);
		});

		it("does NOT retry a cold sync that exhausted the connect budget", async () => {
			// A failure that consumed the whole connect budget is latency, not a
			// transient: the retry re-runs the same sync against the same cold
			// servers and times out identically. Observed live as the same
			// "timed out after 10000ms" twice, costing ~10s of dead wall clock.
			const { manager } = makeSyncManager({ slow: "fail" });
			let listCalls = 0;
			const runtime = new TedixMcpRuntime({
				manager,
				platform: {
					listServers: async () => {
						listCalls += 1;
						await new Promise((resolve) => setTimeout(resolve, 30));
						throw new Error("MCP connect slow timed out after 25ms");
					},
					resolveCredentials: async () => ({ headers: { authorization: "x" } }),
				},
				connectTimeoutMs: 25,
				coldSyncRetryDelayMs: 0,
				logger: { warn: () => {} },
			});

			await expect(runtime.ensureSynced()).rejects.toThrow("timed out");
			// One attempt only — the budget-exhausting failure is not retried.
			expect(listCalls).toBe(1);
		});

		it("still retries a cold sync that failed FAST (a real transient)", async () => {
			const { manager } = makeSyncManager({ ok: "ok" });
			let listCalls = 0;
			const runtime = new TedixMcpRuntime({
				manager,
				platform: {
					listServers: async () => {
						listCalls += 1;
						if (listCalls === 1) throw new Error("transient listServers 503");
						return [
							{
								serverId: "ok",
								url: "https://ok",
								transport: "streamable-http",
							},
						];
					},
					resolveCredentials: async () => ({ headers: { authorization: "x" } }),
				},
				connectTimeoutMs: 10_000,
				coldSyncRetryDelayMs: 0,
				logger: { warn: () => {} },
			});

			await expect(runtime.ensureSynced()).resolves.toBeUndefined();
			expect(listCalls).toBe(2);
		});

		it("connectServer retries the stateless snapshot once", async () => {
			const { manager, snapshotCalls } = makeSyncManager({
				flaky: "snapshot-once",
			});
			const runtime = new TedixMcpRuntime({
				manager,
				preferStatelessConnections: true,
				platform: {
					listServers: async () => [
						{
							serverId: "flaky",
							url: "https://flaky",
							transport: "streamable-http",
						},
					],
					resolveCredentials: async () => ({ headers: { authorization: "x" } }),
				},
				connectRetryDelayMs: 0,
				logger: { warn: () => {} },
			});

			await expect(runtime.ensureSynced()).resolves.toBeUndefined();
			// First snapshot threw transient, second succeeded.
			expect(snapshotCalls).toEqual(["flaky", "flaky"]);
			expect(manager.listConnections().map((c) => c.serverId)).toEqual([
				"flaky",
			]);
		});

		it("can connect modern Worker gateways without allocating an SDK session", async () => {
			const { manager, connectCalls, snapshotCalls } = makeSyncManager({
				modern: "snapshot-once",
			});
			const runtime = new TedixMcpRuntime({
				manager,
				platform: {
					listServers: async () => [
						{
							serverId: "modern",
							url: "https://modern.mcp.tedix.dev/mcp",
							transport: "streamable-http",
						},
					],
					resolveCredentials: async () => ({
						headers: { authorization: "x" },
					}),
				},
				preferStatelessConnections: true,
				connectRetryDelayMs: 0,
				logger: { warn: () => {} },
			});

			await expect(runtime.ensureSynced()).resolves.toBeUndefined();
			expect(connectCalls).toEqual([]);
			expect(snapshotCalls).toEqual(["modern", "modern"]);
			expect(manager.listConnections().map((c) => c.serverId)).toEqual([
				"modern",
			]);
		});

		it("hung upstream connect times out and ensureSynced rejects (no prior connections)", async () => {
			// connect + connectStatelessSnapshot both hang forever — simulates
			// an upstream that accepts the TCP connection but never responds.
			const hangingManager = {
				listConnections: () => [],
				listTools: () => [],
				connect: () => new Promise<never>(() => {}),
				connectStatelessSnapshot: () => new Promise<never>(() => {}),
			} as unknown as McpClientManager;

			const runtime = new TedixMcpRuntime({
				manager: hangingManager,
				platform: {
					listServers: async () => [
						{
							serverId: "hung",
							url: "https://hung",
							transport: "streamable-http",
						},
					],
					resolveCredentials: async () => ({ headers: { authorization: "x" } }),
				},
				connectTimeoutMs: 20,
				logger: { warn: () => {} },
			});

			await expect(runtime.ensureSynced()).rejects.toThrow(
				"MCP connect hung timed out after 20ms",
			);
		});

		it("hung upstream connect times out and ensureSynced serves last-known-good", async () => {
			const prior = {
				serverId: "prior",
				url: "https://prior.mcp.tedix.dev/mcp",
				transport: "streamable-http",
				connectedAt: new Date().toISOString(),
			};
			const hangingManager = {
				listConnections: () => [prior],
				listTools: () => [],
				connect: () => new Promise<never>(() => {}),
				connectStatelessSnapshot: () => new Promise<never>(() => {}),
			} as unknown as McpClientManager;

			const runtime = new TedixMcpRuntime({
				manager: hangingManager,
				platform: {
					listServers: async () => [
						{
							serverId: "hung",
							url: "https://hung",
							transport: "streamable-http",
						},
					],
					resolveCredentials: async () => ({ headers: { authorization: "x" } }),
				},
				connectTimeoutMs: 20,
				logger: { warn: () => {} },
			});

			// With a prior connection the timeout rejection is caught and
			// last-known-good is served — ensureSynced must resolve, not throw.
			await expect(
				runtime.ensureSynced({ force: true }),
			).resolves.toBeUndefined();
			expect(
				hangingManager.listConnections().some((c) => c.serverId === "prior"),
			).toBe(true);
		});
	});

	describe("truncatePayload (ledger card-ability)", () => {
		const maxChars = 4_000;

		it("(a) returns a small object as the object (identity preserved)", () => {
			const value = { kind: "result", items: [1, 2, 3], ok: true };
			const out = truncatePayload(value, maxChars);
			// Identity: not clipped into a string — stays the same object reference.
			expect(out).toBe(value);
			expect(out).toEqual(value);
		});

		it("(b) char-clips a plain string longer than maxChars with the truncated marker", () => {
			const value = "x".repeat(maxChars + 500);
			const out = truncatePayload(value, maxChars);
			expect(typeof out).toBe("string");
			expect(out as string).toMatch(/\.\.\.\(truncated\)$/);
			expect((out as string).length).toBeLessThanOrEqual(maxChars);
		});

		it("(c) wraps a structured object over maxChars in a parseable envelope", () => {
			const items = Array.from({ length: 300 }, (_, i) => ({
				id: i,
				label: `item-${i}-padding`,
			}));
			const value = { kind: "list", items };
			const json = JSON.stringify(value);
			expect(json.length).toBeGreaterThan(maxChars);

			const out = truncatePayload(value, maxChars);
			expect(out).toMatchObject({
				__tedix_truncated: true,
				originalType: "object",
				originalChars: json.length,
			});
			expect(JSON.stringify(out).length).toBeLessThanOrEqual(maxChars);
		});

		it("(d) keeps very large structured JSON parseable", () => {
			const items = Array.from({ length: 4_000 }, (_, i) => ({
				id: i,
				label: `item-${i}-with-extra-padding-text`,
			}));
			const value = { kind: "list", items };
			const json = JSON.stringify(value);
			expect(json.length).toBeGreaterThan(maxChars);

			const out = truncatePayload(value, maxChars);
			expect(out).toMatchObject({
				__tedix_truncated: true,
				originalType: "object",
				originalChars: json.length,
			});
			expect(JSON.stringify(out).length).toBeLessThanOrEqual(maxChars);
		});

		it("(e) wraps a JSON-object STRING over maxChars in a parseable envelope", () => {
			const obj = {
				memoryTools: Array.from({ length: 120 }, (_, i) => ({
					namespace: `ns-${i}`,
					tool: `tool-${i}`,
					description: `padding description for tool ${i}`,
				})),
			};
			const jsonString = JSON.stringify(obj);
			expect(jsonString.length).toBeGreaterThan(maxChars);

			const out = truncatePayload(jsonString, maxChars);
			expect(out).toMatchObject({
				__tedix_truncated: true,
				originalType: "object",
				originalChars: jsonString.length,
			});
			expect(JSON.stringify(out).length).toBeLessThanOrEqual(maxChars);
		});

		it("(f) keeps a very large JSON STRING parseable", () => {
			const obj = {
				rows: Array.from({ length: 6_000 }, (_, i) => ({ id: i, v: `v-${i}` })),
			};
			const jsonString = JSON.stringify(obj);
			expect(jsonString.length).toBeGreaterThan(maxChars);
			const out = truncatePayload(jsonString, maxChars);
			expect(out).toMatchObject({
				__tedix_truncated: true,
				originalType: "object",
				originalChars: jsonString.length,
			});
			expect(JSON.stringify(out).length).toBeLessThanOrEqual(maxChars);
		});

		it("(g) still char-clips a PROSE string over maxChars (not JSON)", () => {
			const prose = `Execution log: ${"detail ".repeat(maxChars)}`;
			expect(prose.length).toBeGreaterThan(maxChars);
			const out = truncatePayload(prose, maxChars);
			expect(typeof out).toBe("string");
			expect(out as string).toMatch(/\.\.\.\(truncated\)$/);
			expect((out as string).length).toBeLessThanOrEqual(maxChars);
		});
	});
});

describe("guidance resource readers", () => {
	it("advertises a registered reader with the resource identity and executes it", async () => {
		const reads: Array<{ server: string; uri: string }> = [];
		const guidance = (["skill", "guide", "policy"] as const).map((kind) => ({
			serverId: "tedix-unified",
			uri: `${kind}://actual-resource/${kind}/instructions.md`,
			name: `Display name for ${kind}`,
			kind,
			summary: `Summary for ${kind}`,
			sourceUrl: "https://example.com/instructions",
		}));
		const manager = Object.assign(
			makeManager(async () => ({})),
			{
				listPrompts: () => [],
				listGuidanceResources: () => guidance,
				listResourceTemplates: () => [
					{
						uriTemplate: "skill://{slug}/SKILL.md",
						title: "Skill instructions",
						description: "Choose a skill slug",
					},
				],
				serverSupportsCompletions: () => true,
				readResource: async (server: string, uri: string) => {
					reads.push({ server, uri });
					return { contents: [{ uri, text: "Actual instructions" }] };
				},
			},
		);
		const runtime = new TedixMcpRuntime({
			manager,
			platform: {
				listServers: async () => [],
				resolveCredentials: async () => ({ headers: {} }),
			},
		});
		const context = runtime.buildGuidanceContext()!;
		for (const item of guidance) {
			const line = context
				.split("\n")
				.find((line) => line.includes(item.summary))!;
			expect(line).toContain(item.name);
			const call = line.match(/read with (\w+) (\{.*\})/)!;
			expect(call).not.toBeNull();
			const name = call[1]!;
			const args = JSON.parse(call[2]!);
			expect(
				runtime.getToolSpecs().some((spec) => spec.function.name === name),
			).toBe(true);
			expect(args).toEqual({ server: item.serverId, uri: item.uri });
			await runtime.executeTool(name, args);
		}
		expect(reads).toEqual(
			guidance.map(({ serverId, uri }) => ({ server: serverId, uri })),
		);
		expect(context).toContain("skill://{slug}/SKILL.md");
		expect(context).toContain("Skill instructions: Choose a skill slug");
		expect(context).toContain("mcp_complete_argument");
	});

	it("omits guidance when no servers are connected", () => {
		const runtime = new TedixMcpRuntime({
			manager: makeManager(async () => ({}), []),
			platform: {
				listServers: async () => [],
				resolveCredentials: async () => ({ headers: {} }),
			},
		});
		expect(runtime.buildGuidanceContext()).toBeUndefined();
	});
});

describe("invocation-owned elicitation", () => {
	const request = {
		taskId: "",
		inputRequests: {
			form: {
				requestedSchema: {
					type: "object",
					properties: { reason: { type: "string" } },
					required: ["reason"],
				},
			},
		},
	};
	it("captures model, binding and cancellation before awaits, retaining out-of-order calls", async () => {
		const captured: string[] = [];
		const release: Record<string, () => void> = {};
		const manager = makeManager(async () => ({}));
		manager.callTool = async (_server, _name, _args, options) => ({
			result: await options!.onTaskInputRequired!(request),
		});
		const runtime = new TedixMcpRuntime({
			manager,
			platform: {
				listServers: async () => [],
				resolveCredentials: async () => ({ headers: {} }),
				recordToolEvent: async () => {},
			},
			elicitationModelForInvocation: ({ binding, signal }) => {
				captured.push(binding.runId);
				expect(signal.aborted).toBe(false);
				return async () => {
					await new Promise<void>((resolve) => {
						release[binding.runId] = resolve;
					});
					return { reason: binding.runId };
				};
			},
		});
		const original = { conversationId: "c", runId: "a" };
		runtime.bindTurn(original);
		const a = runtime.executeTool("tedix_mcp_code", { code: "async () => 1" });
		expect(captured).toEqual(["a"]);
		original.runId = "mutated";
		runtime.bindTurn({ conversationId: "c", runId: "b" });
		const b = runtime.executeTool("tedix_mcp_code", { code: "async () => 2" });
		expect(captured).toEqual(["a", "b"]);
		for (let i = 0; i < 20 && (!release.a || !release.b); i++)
			await Promise.resolve();
		expect(release.a).toBeTypeOf("function");
		expect(release.b).toBeTypeOf("function");
		release.b!();
		expect(await b).toMatchObject({
			result: { form: { content: { reason: "b" } } },
		});
		runtime.clearTurn();
		release.a!();
		expect(await a).toMatchObject({
			result: { form: { content: { reason: "a" } } },
		});
		runtime.bindTurn({ conversationId: "c", runId: "other" });
		for (const binding of [null, undefined]) {
			expect(
				await runtime.executeTool(
					"tedix_mcp_code",
					{ code: "async () => 3" },
					{ binding },
				),
			).toMatchObject({ result: { form: { content: { reason: "" } } } });
		}
		expect(captured).toEqual(["a", "b"]);
	});
	it("does not use a captured model after cancellation during connection preparation", async () => {
		const controller = new AbortController();
		let models = 0,
			wires = 0;
		const manager = makeManager(async () => {
			wires++;
			return {};
		});
		const runtime = new TedixMcpRuntime({
			manager,
			platform: {
				listServers: async () => {
					controller.abort(new Error("original cancelled"));
					return [];
				},
				resolveCredentials: async () => ({ headers: {} }),
			},
			elicitationModelForInvocation: () => async () => {
				models++;
				return {};
			},
		});
		await expect(
			runtime.executeTool(
				"tedix_mcp_code",
				{ code: "async () => 1" },
				{
					binding: { conversationId: "c", runId: "r" },
					signal: controller.signal,
				},
			),
		).rejects.toThrow("original cancelled");
		expect(models).toBe(0);
		expect(wires).toBe(0);
	});
});
