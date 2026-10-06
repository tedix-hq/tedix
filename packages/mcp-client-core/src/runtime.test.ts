import { describe, expect, it } from "vite-plus/test";
import {
	credentialBoundDiscoveryCode,
	extractCredentialBoundCallables,
	truncatePayload,
} from "./runtime.js";

describe("Code Mode server selection", () => {
	it("prefers a tenant unified gateway when an embedded gateway connects first", async () => {
		const { TedixMcpRuntime } = await import("./runtime");
		const calledServers: string[] = [];
		const manager = {
			listConnections: () => [
				{ serverId: "embedded-gateway-tenant" },
				{ serverId: "tenant-unified" },
			],
			listTools: () => [{ name: "code" }],
			callTool: async (serverId: string) => {
				calledServers.push(serverId);
				return { content: [{ type: "text", text: '{"ok":true}' }] };
			},
		};
		const runtime = new TedixMcpRuntime({
			manager: manager as never,
			platform: {
				listServers: async () => [],
				resolveCredentials: async () => ({ headers: {} }),
			},
		});
		runtime.ensureSynced = async () => {};
		await runtime.executeTool(
			"tedix_mcp_code",
			{ code: "async () => true" },
			{ binding: { conversationId: "conversation", runId: "run" } },
		);
		expect(calledServers).toEqual(["tenant-unified"]);
	});
});

describe("extractCredentialBoundCallables", () => {
	it("accepts normal, enveloped, and objectified Code Mode arrays", () => {
		expect(
			extractCredentialBoundCallables([
				"work.complete_work_item",
				{ callable: "work.review_work_item_evidence" },
			]),
		).toEqual(["work.complete_work_item", "work.review_work_item_evidence"]);
		expect(
			extractCredentialBoundCallables({
				result: {
					0: "cto.review_work_evidence",
					1: "cto.complete_work_item",
					length: 2,
				},
			}),
		).toEqual(["cto.review_work_evidence", "cto.complete_work_item"]);
	});
});

describe("credentialBoundDiscoveryCode", () => {
	it("passes the search query as the positional discovery argument", () => {
		expect(credentialBoundDiscoveryCode("review_work_evidence")).toBe(
			'async () => (await discover.search("review_work_evidence", { limit: 25, includeParameters: false })).filter((hit) => hit.authorized !== false && typeof hit.callable === "string").map((hit) => hit.callable).slice(0, 25)',
		);
	});
});

describe("truncatePayload", () => {
	it("keeps oversized structured results parseable and detectable", () => {
		const result = truncatePayload({ rows: ["x".repeat(20_000)] }, 1_000);
		expect(result).toMatchObject({
			__tedix_truncated: true,
			originalType: "object",
		});
		expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_000);
		expect(JSON.stringify(result).length).toBeLessThan(1_500);
	});

	it("preserves completionEvidence outside the truncated preview", () => {
		const result = truncatePayload(
			{
				rows: ["x".repeat(20_000)],
				nested: {
					completionEvidence: {
						status: "succeeded",
						supportedClaims: ["deployment readback matched"],
					},
				},
			},
			1_000,
		);
		expect(result).toMatchObject({
			__tedix_truncated: true,
			completionEvidence: {
				status: "succeeded",
				supportedClaims: ["deployment readback matched"],
			},
		});
		expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_000);
	});
});

describe("recoverable oversized results", () => {
	it("retains once and returns a scoped handle without re-invoking the provider", async () => {
		const { TedixMcpRuntime } = await import("./runtime");
		let providerCalls = 0;
		const retained: unknown[] = [];
		const manager = {
			listConnections: () => [{ serverId: "provider" }],
			listTools: () => [{ serverId: "provider", name: "large" }],
			readResource: async () => {
				providerCalls++;
				return { content: [{ type: "text", text: "x".repeat(5000) }] };
			},
		};
		const runtime = new TedixMcpRuntime({
			manager: manager as never,
			maxToolResultChars: 1000,
			platform: {
				listServers: async () => [],
				resolveCredentials: async () => ({ headers: {} }),
			},
			retainToolResult: async (input) => {
				retained.push(input);
				return {
					resultId: "00000000-0000-4000-8000-000000000001",
					totalChars: 5000,
				};
			},
		});
		runtime.ensureSynced = async () => {};
		const result = await runtime.executeTool(
			"mcp_read_resource",
			{ server: "provider", uri: "data://large" },
			{
				binding: { conversationId: "conversation-a", runId: "run-a" },
			},
		);
		expect(result).toMatchObject({
			retained: true,
			providerCallReturned: true,
			doNotRetryProvider: true,
		});
		expect(providerCalls).toBe(1);
		expect(retained).toHaveLength(1);
	});

	it("keeps provider success explicit when retention fails", async () => {
		const manager = {
			listConnections: () => [{ serverId: "provider" }],
			listTools: () => [{ serverId: "provider", name: "large" }],
			readResource: async () => ({
				content: [{ type: "text", text: "x".repeat(5000) }],
				completionEvidence: { status: "failed", reason: "provider rejected" },
			}),
		};
		const { TedixMcpRuntime } = await import("./runtime");
		const runtime = new TedixMcpRuntime({
			manager: manager as never,
			maxToolResultChars: 1000,
			platform: {
				listServers: async () => [],
				resolveCredentials: async () => ({ headers: {} }),
			},
			retainToolResult: async () => {
				throw new Error("disk unavailable");
			},
		});
		runtime.ensureSynced = async () => {};
		const result = await runtime.executeTool(
			"mcp_read_resource",
			{ server: "provider", uri: "data://large" },
			{
				binding: { conversationId: "conversation-a", runId: "run-a" },
			},
		);
		expect(result).toMatchObject({
			retained: false,
			providerCallReturned: true,
			doNotRetryProvider: true,
			retentionError: "disk unavailable",
			completionEvidence: { status: "failed", reason: "provider rejected" },
		});
		expect(JSON.stringify(result)).not.toContain("execution succeeded");
		expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_000);
	});

	it("bounds JSON-escaped structured previews by serialized size", () => {
		const projected = truncatePayload(
			{ rows: [`\\\"\n`.repeat(5_000)] },
			1_000,
		);
		expect(JSON.stringify(projected).length).toBeLessThanOrEqual(1_000);
	});
});

describe("private embedded delegation", () => {
	const collectionRead = {
		version: 1,
		kind: "connected_collection_read",
		source: {
			appId: "00000000-0000-4000-8000-000000000003",
			appSlug: "google-gmail",
			toolName: "get_message",
			connectionProviderId: "google-gmail",
		},
		collection: "messages",
		observedAt: "2026-09-27T22:00:00.000Z",
	};

	it("persists host-side Code Mode observations beside a dropped program projection", async () => {
		const receipt = {
			version: 1,
			kind: "docs_file_observation",
			receiptId: "00000000-0000-4000-8000-000000000001",
			provider: { appSlug: "docs", toolName: "get_docs_file" },
			resource: {
				organizationSlug: "acme",
				siteId: "00000000-0000-4000-8000-000000000002",
				path: "index.md",
			},
			evidence: {
				contentSha256: "a".repeat(64),
				byteLength: 6,
				observedGitRevision: "b".repeat(40),
			},
			observedAt: "2026-09-22T12:00:00.000Z",
		};
		const events: Array<{ kind: string; payload: Record<string, unknown> }> =
			[];
		const runtime = new (await import("./runtime")).TedixMcpRuntime({
			manager: {
				listConnections: () => [{ serverId: "tedix-unified" }],
				listTools: () => [{ name: "code" }],
				callTool: async () => ({
					content: [
						{
							type: "text",
							text: JSON.stringify({
								executionId: "exec",
								result: { only: "projection" },
							}),
						},
					],
					structuredContent: {
						executionId: "exec",
						result: { only: "projection" },
					},
					_meta: {
						"io.tedix/readObservations": [{ innerCallId: "exec:0", receipt }],
						"io.tedix/readCollections": [
							{ innerCallId: "exec:1", observation: collectionRead },
						],
					},
				}),
			} as never,
			platform: {
				listServers: async () => [],
				resolveCredentials: async () => ({ headers: {} }),
				recordToolEvent: async (event) => {
					events.push(event);
				},
			},
		});
		runtime.ensureSynced = async () => {};
		expect(
			await runtime.executeTool(
				"tedix_mcp_code",
				{ code: "async () => ({ only: 'projection' })" },
				{ binding: { conversationId: "conversation", runId: "run" } },
			),
		).toEqual({ only: "projection" });
		expect(
			events.find((event) => event.kind === "tool.completed")?.payload
				.readObservations,
		).toEqual([{ innerCallId: "exec:0", receipt }]);
		expect(
			events.find((event) => event.kind === "tool.completed")?.payload
				.collectionReads,
		).toEqual([{ innerCallId: "exec:1", observation: collectionRead }]);
	});

	it("persists a successful read observation when the outer program later fails", async () => {
		const receipt = {
			version: 1,
			kind: "docs_file_observation",
			receiptId: "00000000-0000-4000-8000-000000000001",
			provider: { appSlug: "docs", toolName: "get_docs_file" },
			resource: {
				organizationSlug: "acme",
				siteId: "00000000-0000-4000-8000-000000000002",
				path: "index.md",
			},
			evidence: {
				contentSha256: "a".repeat(64),
				byteLength: 6,
				observedGitRevision: "b".repeat(40),
			},
			observedAt: "2026-09-22T12:00:00.000Z",
		};
		const events: Array<{ kind: string; payload: Record<string, unknown> }> =
			[];
		const runtime = new (await import("./runtime")).TedixMcpRuntime({
			manager: {
				listConnections: () => [{ serverId: "tedix-unified" }],
				listTools: () => [{ name: "code" }],
				callTool: async () => ({
					content: [{ type: "text", text: "Execution error: later failure" }],
					structuredContent: { executionId: "exec", error: "later failure" },
					isError: true,
					_meta: {
						"io.tedix/readObservations": [{ innerCallId: "exec:0", receipt }],
						"io.tedix/readCollections": [
							{ innerCallId: "exec:1", observation: collectionRead },
						],
					},
				}),
			} as never,
			platform: {
				listServers: async () => [],
				resolveCredentials: async () => ({ headers: {} }),
				recordToolEvent: async (event) => {
					events.push(event);
				},
			},
		});
		runtime.ensureSynced = async () => {};
		await expect(
			runtime.executeTool(
				"tedix_mcp_code",
				{
					code: "async () => { await docs.get_docs_file({}); throw new Error('later failure') }",
				},
				{ binding: { conversationId: "conversation", runId: "run" } },
			),
		).rejects.toThrow("later failure");
		expect(
			events.find((event) => event.kind === "tool.failed")?.payload
				.readObservations,
		).toEqual([{ innerCallId: "exec:0", receipt }]);
		expect(
			events.find((event) => event.kind === "tool.failed")?.payload
				.collectionReads,
		).toEqual([{ innerCallId: "exec:1", observation: collectionRead }]);
	});
	it("isolates concurrent invocation proofs and excludes proof from code and tool telemetry", async () => {
		const { TedixMcpRuntime } = await import("./runtime");
		const calls: Array<{ args: unknown; options: unknown }> = [];
		const events: unknown[] = [];
		const manager = {
			listConnections: () => [{ serverId: "tedix-unified" }],
			listTools: () => [{ name: "code" }],
			callTool: async (
				_server: string,
				_name: string,
				args: unknown,
				options: unknown,
			) => {
				calls.push({ args, options });
				await Promise.resolve();
				return { content: [{ type: "text", text: '{"ok":true}' }] };
			},
		};
		const runtime = new TedixMcpRuntime({
			manager: manager as never,
			platform: {
				listServers: async () => [],
				resolveCredentials: async () => ({ headers: {} }),
				recordToolEvent: async (event) => {
					events.push(event);
				},
			},
		});
		runtime.ensureSynced = async () => {};
		const first = {
			conversationId: "one",
			runId: "one",
			embeddedSessionToken: "proof-one",
		};
		const second = {
			conversationId: "two",
			runId: "two",
			embeddedSessionToken: "proof-two",
		};
		runtime.bindTurn(second);
		await Promise.all(
			[first, second].map((binding) =>
				runtime.executeTool(
					"tedix_mcp_call_tool",
					{ callable: "provider.read_record", args: { id: 1 } },
					{ binding },
				),
			),
		);
		await runtime.executeTool("tedix_mcp_call_tool", {
			callable: "provider.read_record",
			args: { id: 1 },
		});
		expect(
			calls.map(
				(call) =>
					(call.options as { embeddedSessionToken?: string })
						.embeddedSessionToken,
			),
		).toEqual(["proof-one", "proof-two", undefined]);
		expect(JSON.stringify(calls.map((call) => call.args))).not.toContain(
			"proof-",
		);
		expect(JSON.stringify(events)).not.toContain("proof-");
		expect(JSON.stringify(runtime.getToolCallLog())).not.toContain("proof-");
	});
});
