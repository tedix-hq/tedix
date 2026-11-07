import { expect, it, vi } from "vite-plus/test";
import { IdenticalFailureBudget } from "@tedix/tedi-codemode-core/failure-budget";
import { unwrapJsonRpcToolResult } from "@tedix/mcp-shared/tool-result";
import { buildAggregateTediTools } from "./aggregate-tedis";
import {
	buildNamespaceGroups,
	type CodeModeExecutionRefs,
} from "./codemode-execution";
import { ToolHandler } from "./handler";
import type { ServerContext } from "./server-context";

it.each([false, true])(
	"retains a bounded failed boundary receipt through gateway/Code Mode/workflow parser, malformed=%s",
	async (malformed) => {
		const calls: unknown[] = [];
		const env = {
			MCP_URL: "https://mcp.tedix.dev",
			ENVIRONMENT: "test",
			GIT_SHA: "gateway-fixture",
			TEDI_SERVICE: {
				fetch: vi.fn(async (_url: string, init: RequestInit) => {
					const request = JSON.parse(String(init.body));
					calls.push(request);
					return Response.json({
						jsonrpc: "2.0",
						id: request.id,
						result: {
							resultType: "complete",
							content: [
								{
									type: "text",
									text: JSON.stringify({
										ok: false,
										error: "not_found",
										content: "must remain private",
										evaluationReadBoundary: {
											version: malformed
												? { privateBody: "must remain private" }
												: 1,
											runtimeSource: malformed
												? { privateBody: "must remain private" }
												: "runtime-fixture",
											environment: malformed
												? "must remain private".repeat(2000)
												: "test",
											tediId: "fixture-tedi",
											slug: "fixture",
											evaluationInstructionsPresent: malformed
												? { privateBody: "must remain private" }
												: false,
											evaluationInstructions: false,
											privateBody: "must remain private",
										},
									}),
								},
							],
						},
					});
				}),
			},
			API_SERVICE: { fetch: vi.fn(async () => Response.json({ json: {} })) },
		} as unknown as CloudflareEnv;
		const tool = buildAggregateTediTools(
			[
				{
					slug: "fixture",
					namespace: "fixture",
					surface: "full",
					tediId: "fixture-tedi",
					organizationId: "fixture-org",
					runtimeKind: "agent",
				},
			],
			env,
		).find((tool) => tool.toolId === "fixture__artifact_read_file")!;
		expect(tool).toBeDefined();
		const context = {
			env,
			ctx: { waitUntil: vi.fn() },
			appId: "fixture-app",
			appSlug: "fixture-app",
			app: {
				id: "fixture-app",
				slug: "fixture-app",
				name: "Fixture",
				organizationId: "fixture-org",
			},
			appMetadata: {
				mcpConfig: {
					authMode: "public",
					codeMode: true,
					enforcePolicies: false,
				},
			},
			appCapabilities: {},
			apiClient: {},
			toolHandler: new ToolHandler(),
			traceId: "fixture-trace",
			callerIdentity: {
				authType: "service",
				tediId: "fixture-tedi",
				organizationId: "fixture-org",
				scopes: ["mcp:tools.call", "tedi:config.read", "connections.execute"],
			},
			loadedTools: new Map([[tool.toolId, tool]]),
			registeredTools: new Map(),
			registeredResources: new Map(),
			registeredPrompts: new Map(),
			toolOutputTemplates: new Map(),
			toolSkillMap: new Map(),
			appToolIds: new Set(),
			appResourceIds: new Set(),
			authRequiredTools: new Set(),
		} as unknown as ServerContext;
		const refs: CodeModeExecutionRefs = {
			authorizationDenial: undefined,
			approvalResult: undefined,
			approvalExtra: undefined,
			approvalSource: undefined,
			replayUnsafeBuiltinCalls: 0,
			executionId: "fixture-execution",
			paymentExtra: undefined,
			paymentResponses: [],
			rpcCallCount: 0,
			rpcNamespaces: new Set(),
			sideEffectQueue: Promise.resolve(),
			failureBudget: new IdenticalFailureBudget(),
			discoverCalls: 0,
			discoverParameterRequests: 0,
			toolReceipts: [],
			trust: { untrusted: new Set(), trusted: new Set() },
			skillWorkflowRunIds: new Set(),
			readObservations: [],
			collectionReads: [],
			ownerHostSession: undefined,
		};
		let failure: Error | undefined;
		try {
			await buildNamespaceGroups(context, undefined, refs, new Set()).get(
				"fixture",
			)!.fns.artifact_read_file!({
				path: "AGENTS.md",
				maxChars: 80000,
				evaluationInstructions: true,
			});
		} catch (error) {
			failure = error as Error;
		}
		expect(failure).toBeDefined();
		expect(calls, failure?.message).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			method: "tools/call",
			params: {
				arguments: { path: "AGENTS.md", evaluationInstructions: true },
			},
		});
		expect(refs.toolReceipts[0]?.status).toBe("failed");
		// This is the same JSON-RPC error envelope and parser used by the workflow bridge.
		let workflowFailure: Error | undefined;
		try {
			unwrapJsonRpcToolResult(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					result: {
						isError: true,
						content: [{ type: "text", text: `Execution error: ${failure}` }],
					},
				}),
				"code",
			);
		} catch (error) {
			workflowFailure = error as Error;
		}
		expect(workflowFailure?.name).toBe("McpToolError");
		const persisted = JSON.parse(
			JSON.stringify({
				error: {
					name: workflowFailure?.name,
					message: workflowFailure?.message,
				},
			}),
		);
		const message = persisted.error.message as string;
		expect(message).not.toContain("must remain private");
		const diagnostic = JSON.parse(message.slice(message.indexOf("{")));
		expect(diagnostic.code).toBe("EVALUATION_READ_BOUNDARY_UNCONFIRMED");
		expect(diagnostic.evaluationTransportReceipt).toMatchObject({
			gatewaySource: "gateway-fixture",
			transport: "TEDI_SERVICE",
			evaluationInstructions: true,
			configuredTarget: {
				origin: "https://fixture.tedi.tedix.dev",
				path: "/mcp",
			},
			toolInputSchemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			runtime: {
				runtimeSource: malformed ? null : "runtime-fixture",
				evaluationInstructionsPresent: malformed ? null : false,
				evaluationInstructions: false,
			},
		});
		expect(message.length).toBeLessThan(2000);
	},
);
