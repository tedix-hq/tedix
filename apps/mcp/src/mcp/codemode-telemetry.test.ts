import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { TediSchema } from "@tedix/api-contract/schemas/tedi";
import { enteredSpans } from "../../test/stubs/cloudflare-workers";

const executorBudgets = vi.hoisted(() => [] as number[]);
vi.mock("@cloudflare/codemode", async () => {
	const actual = await vi.importActual<typeof import("@cloudflare/codemode")>(
		"@cloudflare/codemode",
	);
	const sanitizeToolName = (name: string) =>
		name.replace(/[^a-zA-Z0-9_]/g, "_");
	return {
		...actual,
		createCodemodeRuntime: (options: {
			executor: import("@cloudflare/codemode").DynamicWorkerExecutor;
		}) => ({
			execute: () =>
				options.executor.execute("async () => native_loader_fixture", []),
		}),
		DynamicWorkerExecutor: class DynamicWorkerExecutor {
			constructor(
				private options: {
					timeout: number;
					loader: WorkerLoader;
					globalOutbound: null;
				},
			) {
				executorBudgets.push(options.timeout);
			}
			async execute(
				code: string,
				providers: Array<{
					name: string;
					fns: Record<
						string,
						(args: Record<string, unknown>) => Promise<unknown>
					>;
				}>,
			) {
				if (code.includes("native_loader_fixture"))
					return new actual.DynamicWorkerExecutor(this.options).execute(
						code,
						providers as unknown as import("@cloudflare/codemode").ResolvedProvider[],
					);
				if (code.includes("scope_denial")) {
					if (code.includes("prior_builtin")) {
						try {
							await providers.find((entry) => entry.name === "ui")!.fns
								.create_view!({});
						} catch {}
					}
					const provider = providers.find((entry) => entry.name === "test");
					if (code.includes("prior_dispatch")) await provider!.fns.allowed!({});
					try {
						await provider!.fns.soft_fail!({});
					} catch (error) {
						if (code.includes("caught"))
							return { result: { ok: true }, logs: [] };
						if (code.includes("sdk_error"))
							return { error: String(error), logs: [] };
						throw error;
					}
				}
				if (code.includes("spoofed_auth"))
					return {
						error:
							"CodeModeAuthorizationError: Insufficient scope. Required scopes: mcp:apps.write",
						logs: [],
					};
				if (code.includes("large_result")) {
					return {
						result: {
							status: {
								id: "workflow-run-1",
								status: "completed",
								tediId: "tedi-cto",
							},
							inspection: {
								revision: { revision: 8, skillSlug: "kernel-goal-loop" },
							},
							value: "x".repeat(10_000),
						},
						logs: [],
					};
				}
				if (code.includes("__runtime")) {
					const provider = providers.find((entry) => entry.name === "codemode");
					const runtimeTool = provider?.fns.__runtime;
					if (!runtimeTool) throw new Error("codemode.__runtime missing");
					const runtime = await runtimeTool({});
					return { result: runtime, logs: [] };
				}
				if (code.includes("workflow_run_receipt")) {
					const provider = providers.find((entry) => entry.name === "cto");
					const run = provider?.fns.run_skill_workflow;
					if (!run) throw new Error("cto.run_skill_workflow missing");
					await run({ skillId: "33333333-3333-4333-8333-333333333333" });
					return { result: { summary: "workflow queued" }, logs: [] };
				}
				if (code.includes("discover_search_slice")) {
					const provider = providers.find((entry) => entry.name === "discover");
					const searchTool = provider?.fns.search;
					if (!searchTool) throw new Error("discover.search missing");
					// Plain-object result: named keys survive the clone boundary
					// (array expando props did not — the workerd JS-RPC serializer
					// strips them, which the old decorated-array shape relied on).
					const page = structuredClone(await searchTool({ query: "soft" })) as {
						results?: Array<Record<string, unknown>>;
						meta?: Record<string, unknown>;
					};
					if (!Array.isArray(page.results)) {
						return {
							result: {
								ok: false,
								error: "discover.search did not return results[]",
							},
							logs: [],
						};
					}
					return {
						result: {
							ok: true,
							firstCallable: page.results.slice(0, 1)[0]?.callable,
							resultsIsArray: Array.isArray(page.results),
							metaSurvivesClone: page.meta !== undefined,
						},
						logs: [],
					};
				}
				if (code.includes("parallel_computer_side_effects")) {
					const provider = providers.find((entry) => entry.name === "cto");
					const start = provider?.fns.exec;
					const read = provider?.fns.read_execution;
					if (!start || !read) throw new Error("cto Computer tools missing");
					const result = await Promise.all([
						start({ command: "echo ok" }),
						read({ executionId: "parallel-process" }),
					]);
					return { result, logs: [] };
				}
				if (code.includes("repeated_tedi_lookup")) {
					const getter = providers.find((entry) => entry.name === "tedis")?.fns
						.get_tedi;
					if (!getter) throw new Error("tedis.get_tedi missing");
					const result = [];
					for (let i = 0; i < 3; i++) {
						const raw = await getter({
							tediId: "11111111-1111-4111-8111-111111111111",
						});
						const value = raw as Record<string, unknown>;
						result.push({
							id: value.id,
							status: value.status,
							completionEvidence: value.completionEvidence,
						});
					}
					return { result, logs: [] };
				}
				if (code.includes("repeated_soft_fail")) {
					const provider = providers.find((entry) => entry.name === "test");
					const tool = provider?.fns.soft_fail;
					if (!tool) throw new Error("test.soft_fail missing");
					const result = [
						await tool({ value: "same" }),
						await tool({ value: "same" }),
						await tool({ value: "same" }),
					];
					return { result, logs: [] };
				}
				const provider = providers.find((entry) => entry.name === "test");
				const tool = provider?.fns.soft_fail;
				if (!tool) throw new Error("test.soft_fail missing");
				const result = await tool({});
				return { result, logs: [] };
			}
		},
		resolveProvider: (provider: {
			name?: string;
			tools: Record<
				string,
				{ execute: (...args: unknown[]) => Promise<unknown> }
			>;
		}) => ({
			name: provider.name ?? "codemode",
			fns: Object.fromEntries(
				Object.entries(provider.tools).map(([name, tool]) => [
					name,
					tool.execute,
				]),
			),
		}),
		sanitizeToolName,
		truncateResult: (value: unknown) => {
			if (
				value &&
				typeof value === "object" &&
				"surface" in value &&
				(value as { surface?: unknown }).surface === "mcp-gateway"
			) {
				return value;
			}
			const serialized = JSON.stringify(value, null, 2);
			if (!serialized || serialized.length <= 5_000) return value;
			return `${serialized.slice(0, 5_000)}\n\n--- TRUNCATED ---`;
		},
	};
});

vi.mock("./tool-execution", () => ({
	executeTool: vi.fn(),
}));

import { executeCatalogOperation, registerCodeModeTools } from "./codemode";
import { ToolHandler, type ToolExecutionContext } from "./handler";
import { registerCodeModeTools as registerStateless } from "@tedix/tedi-codemode-core/register-codemode-tools";

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { AppTool, ServerContext } from "./server-context";
import { executeTool } from "./tool-execution";

const tediRecord = {
	id: "11111111-1111-4111-8111-111111111111",
	organizationId: "22222222-2222-4222-8222-222222222222",
	ownerUserId: null,
	scope: "organization" as const,
	name: "Fixture worker",
	slug: "fixture-worker",
	displayName: null,
	externalRef: null,
	tags: null,
	personality: null,
	avatar: null,
	timezone: null,
	language: null,
	installedSkills: null,
	installedPlugins: null,
	status: "active" as const,
	billingState: null,
	workerName: null,
	r2BucketName: null,
	runtimeStatus: "unknown" as const,
	lastSeenAt: null,
	lastSyncAt: null,
	createdAt: null,
	updatedAt: null,
};

function tool(overrides: Partial<AppTool> = {}): AppTool {
	return {
		id: "tool-row-id",
		toolId: "test__soft_fail",
		title: "Soft Fail",
		description: "Returns an MCP isError result",
		toolTypeId: "rpc",
		inputSchema: { type: "object", properties: {} },
		outputSchema: null,
		config: null,
		icons: null,
		executionTaskSupport: null,
		annotations: null,
		meta: null,
		invocationStatus: null,
		fileParams: null,
		adapterScope: null,
		resultStrategy: null,
		outputTemplate: null,
		widgetKey: null,
		widgetRoute: null,
		widgetAccessible: null,
		visibility: null,
		widgetDescription: null,
		widgetPrefersBorder: null,
		widgetDomain: null,
		schemaDialect: null,
		schemaSource: null,
		schemaSourceRef: null,
		schemaSourceHash: null,
		schemaSyncedAt: null,
		sortOrder: null,
		enabled: true,
		createdAt: null,
		updatedAt: null,
		...overrides,
	};
}

function makeServerCtx(
	loadedTools = new Map([["test__soft_fail", tool()]]),
	writeDataPoint?: (point: {
		blobs?: string[];
		doubles?: number[];
		indexes?: string[];
	}) => void,
): ServerContext {
	return {
		env: {
			LOADER: {},
			ENVIRONMENT: "test",
			...(writeDataPoint && {
				CODEMODE_ANALYTICS: { writeDataPoint },
			}),
		} as unknown as CloudflareEnv,
		ctx: { waitUntil: vi.fn() },
		appId: "app-uuid",
		appSlug: "test-app",
		app: { organizationId: "org-uuid" },
		appMetadata: {
			mcpConfig: {
				authMode: "public",
				codeMode: true,
				enforcePolicies: false,
				toolScopes: { soft_fail: [] },
			},
		},
		appCapabilities: {},
		apiClient: {},
		toolHandler: {},
		callerIdentity: {
			userId: "user-uuid",
			tediId: "tedi-uuid",
			authType: "tedi",
			scopes: [],
		},
		traceId: "trace-uuid",
		loadedTools,
		registeredTools: new Map(),
		registeredResources: new Map(),
		catalogResources: [],
		catalogResourceTemplates: [],
		appToolIds: new Set(),
		appResourceIds: new Set(),
		authRequiredTools: new Set(),
		registeredPrompts: new Map(),
		toolOutputTemplates: new Map(),
		toolSkillMap: new Map(),
		getServerVersion: () => "0.0.1",
		getWidgetDomain: () => "https://widget.test",
		buildAppCsp: vi.fn(),
		fetchWidgetHtml: vi.fn(),
		fetchWidgetHtmlForAppSlug: vi.fn(),
	} as unknown as ServerContext;
}

describe("Code Mode tail telemetry", () => {
	const executeToolMock = vi.mocked(executeTool);
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		enteredSpans.length = 0;
		executeToolMock.mockResolvedValue({
			content: [{ type: "text", text: "soft fail" }],
			structuredContent: null,
			_meta: {},
			isError: true,
		});
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		executeToolMock.mockReset();
	});

	it.each(["scope_denial", "scope_denial_sdk_error", "scope_denial_caught"])(
		"challenges trusted denial before dispatch even when the SDK masks it: %s",
		async (code) => {
			const registered = new Map<string, (args: unknown) => Promise<any>>();
			const server = {
				registerTool: (name: string, _config: unknown, handler: any) =>
					registered.set(name, handler),
			};
			const ctx = makeServerCtx();
			ctx.appMetadata!.mcpConfig!.toolScopes = {
				soft_fail: ["mcp:apps.write"],
			};
			await registerCodeModeTools(server as never, ctx);
			const result = await registered.get("code")!({
				code: `async () => ${code}`,
			});
			expect(result.isError).toBe(true);
			expect(result._meta["mcp/www_authenticate"][0]).toContain(
				'scope="mcp:apps.write"',
			);
			expect(result.structuredContent.dispatchedCalls).toBe(0);
			expect(executeToolMock).not.toHaveBeenCalled();
		},
	);
	it.each([
		["public", [{ type: "noauth" }]],
		["authenticated", [{ type: "oauth2" }]],
		["hybrid", [{ type: "noauth" }, { type: "oauth2" }]],
	])(
		"registered code advertises %s auth independently of inner tool scopes",
		async (authMode, securitySchemes) => {
			const registerTool = vi.fn();
			const ctx = makeServerCtx();
			ctx.appMetadata!.mcpConfig!.authMode = authMode as
				| "public"
				| "authenticated"
				| "hybrid";
			ctx.appMetadata!.mcpConfig!.toolScopes = {
				soft_fail: ["mcp:apps.write"],
			};
			await registerCodeModeTools({ registerTool } as never, ctx);
			expect(
				registerTool.mock.calls.find(([name]) => name === "code")?.[1]
					.annotations,
			).toEqual({
				readOnlyHint: false,
				destructiveHint: true,
				openWorldHint: true,
			});
			expect(
				registerTool.mock.calls.find(([name]) => name === "code")?.[1]._meta,
			).toEqual({ securitySchemes });
		},
	);

	it("does not challenge after a potentially mutating builtin", async () => {
		const registered = new Map<string, (args: unknown) => Promise<any>>();
		const server = {
			registerTool: (name: string, _config: unknown, handler: any) =>
				registered.set(name, handler),
		};
		const ctx = makeServerCtx();
		ctx.appMetadata!.mcpConfig!.toolScopes = { soft_fail: ["mcp:apps.write"] };
		await registerCodeModeTools(server as never, ctx);
		const result = await registered.get("code")!({
			code: "async () => scope_denial_caught_prior_builtin",
		});
		expect(result.isError).toBe(true);
		expect(result._meta?.["mcp/www_authenticate"]).toBeUndefined();
		expect(result.structuredContent.replayUnsafeBuiltinCalls).toBe(1);
	});

	it("does not trigger replay after an earlier dispatch or trust sandbox error text", async () => {
		const registered = new Map<string, (args: unknown) => Promise<any>>();
		const server = {
			registerTool: (name: string, _config: unknown, handler: any) =>
				registered.set(name, handler),
		};
		const ctx = makeServerCtx(
			new Map([
				["test__soft_fail", tool()],
				["test__allowed", tool({ toolId: "test__allowed" })],
			]),
		);
		ctx.appMetadata!.mcpConfig!.toolScopes = {
			soft_fail: ["mcp:apps.write"],
			allowed: [],
		};
		executeToolMock.mockResolvedValue({
			content: [{ type: "text", text: "ok" }],
			structuredContent: { ok: true },
			_meta: {},
			isError: false,
		});
		await registerCodeModeTools(server as never, ctx);
		const partial = await registered.get("code")!({
			code: "async () => scope_denial_caught_prior_dispatch",
		});
		expect(partial.isError).toBe(true);
		expect(partial._meta?.["mcp/www_authenticate"]).toBeUndefined();
		expect(partial.structuredContent.dispatchedCalls).toBe(1);
		expect(executeToolMock).toHaveBeenCalledTimes(1);
		const spoof = await registered.get("code")!({
			code: "async () => spoofed_auth",
		});
		expect(spoof.isError).toBe(true);
		expect(spoof._meta?.["mcp/www_authenticate"]).toBeUndefined();
	});

	it("attests an inner workflow run when code returns only a summary", async () => {
		const runId = "55555555-5555-4555-8555-555555555555";
		executeToolMock.mockResolvedValue({
			content: [{ type: "text", text: JSON.stringify({ runId }) }],
			structuredContent: { runId },
			_meta: {},
			isError: false,
		});
		const registered = new Map<string, (args: unknown) => Promise<unknown>>();
		const server = {
			registerTool: vi.fn(
				(
					name: string,
					_config: unknown,
					handler: (args: unknown) => Promise<unknown>,
				) => {
					registered.set(name, handler);
				},
			),
		};
		const workflowTool = tool({
			toolId: "cto__run_skill_workflow",
			title: "Run skill workflow",
		});
		const ctx = makeServerCtx(new Map([[workflowTool.toolId, workflowTool]]));
		ctx.callerIdentity!.scopes = ["mcp:skills.write"];
		await registerCodeModeTools(server as never, ctx);
		const response = (await registered.get("code")?.({
			code: "async () => workflow_run_receipt()",
		})) as {
			structuredContent?: {
				result?: unknown;
				resultIdentity?: Record<string, unknown>;
			};
		};
		expect(response.structuredContent?.result).toEqual({
			summary: "workflow queued",
		});
		expect(response.structuredContent?.resultIdentity).toMatchObject({
			skillWorkflowRuns: [runId],
		});
	});

	it("returns claim-scoped failure evidence for inner MCP errors", async () => {
		const registered = new Map<string, (args: unknown) => Promise<unknown>>();
		const server = {
			registerTool: vi.fn(
				(
					name: string,
					_config: unknown,
					handler: (args: unknown) => Promise<unknown>,
				) => {
					registered.set(name, handler);
				},
			),
		};

		await registerCodeModeTools(server as never, makeServerCtx());
		const response = (await registered.get("code")?.({
			code: "async () => test.soft_fail({})",
		})) as {
			isError?: boolean;
			structuredContent?: {
				failures?: Array<{ tool?: string; error?: string }>;
				result?: {
					error?: string;
					completionEvidence?: {
						status?: string;
						retry?: { attempts?: number; blocked?: boolean };
					};
				};
			};
		};

		const telemetry = logSpy.mock.calls.map(([message]: unknown[]) =>
			typeof message === "string" && message.startsWith('{"_cm"')
				? (JSON.parse(message) as Record<string, unknown>)
				: null,
		);
		const rpcLog = telemetry.find(
			(entry: Record<string, unknown> | null) => entry?._cm === "rpc",
		);
		const execLog = telemetry.find(
			(entry: Record<string, unknown> | null) => entry?._cm === "exec",
		);

		expect(rpcLog).toMatchObject({
			_cm: "rpc",
			appId: "app-uuid",
			appSlug: "test-app",
			orgId: "org-uuid",
			userId: "user-uuid",
			tediId: "tedi-uuid",
			authType: "tedi",
			traceId: "trace-uuid",
			ns: "test",
			tool: "soft_fail",
			success: false,
		});
		expect(rpcLog?.executionId).toEqual(expect.any(String));
		expect(execLog).toMatchObject({ _cm: "exec", success: true });
		expect(response.isError).toBeUndefined();
		expect(response.structuredContent?.result).toMatchObject({
			error: "soft fail",
			completionEvidence: {
				status: "failed",
				retry: { attempts: 1, blocked: false },
			},
		});
		// Failed inner calls surface by name and cause on the OUTER result —
		// audits must never need to stringify inner envelopes to find a denial.
		expect(response.structuredContent?.failures).toEqual([
			{ tool: "test.soft_fail", error: expect.stringContaining("soft fail") },
		]);
		const codeSpan = enteredSpans.find(
			(span) => span.name === "tedix.mcp.code_exec",
		);
		expect(codeSpan).toMatchObject({
			attributes: {
				"tedix.trace_id": "trace-uuid",
				"tedix.app_id": "app-uuid",
				"tedix.execution_id": expect.any(String),
			},
		});
		expect(JSON.stringify(codeSpan)).not.toContain("async () =>");
	});

	it("uses the shared tool-result normalizer for Code Mode values", async () => {
		const registered = new Map<string, (args: unknown) => Promise<unknown>>();
		const server = {
			registerTool: vi.fn(
				(
					name: string,
					_config: unknown,
					handler: (args: unknown) => Promise<unknown>,
				) => {
					registered.set(name, handler);
				},
			),
		};
		executeToolMock.mockResolvedValue({
			content: [
				{ type: "text", text: '{"rows":' },
				{ type: "text", text: "[1,2]}" },
			],
			structuredContent: null,
			_meta: {},
			isError: false,
		});

		await registerCodeModeTools(server as never, makeServerCtx());
		const response = (await registered.get("code")?.({
			code: "async () => test.soft_fail({})",
		})) as { structuredContent?: { result?: unknown } };

		expect(response.structuredContent?.result).toMatchObject({ rows: [1, 2] });
	});

	it.each([
		["active", {}, "succeeded", 3, [0, 0, 0]],
		["provisioning", {}, "succeeded", 3, [0, 0, 0]],
		["active", { error: "explicit failure" }, "failed", 2, [1, 2, 2]],
		["active", { id: "invalid" }, "partial", 2, [1, 2, 2]],
		["active", { running: true }, "pending", 3, [0, 0, 0]],
	] as const)(
		"accounts repeated typed lookup %s %j honestly",
		async (status, flags, expected, dispatches, attempts) => {
			const record = { ...tediRecord, status, ...flags };
			if (!("id" in flags))
				expect(TediSchema.safeParse(record).success).toBe(true);
			executeToolMock.mockResolvedValue({
				content: [{ type: "text", text: JSON.stringify(record) }],
				structuredContent: record,
				_meta: {},
				isError: false,
			});
			const getter = tool({
				toolId: "tedis__get_tedi",
				title: "Get fixture worker",
				annotations: { readOnlyHint: true },
				config: { endpoint: "tedis/get" },
			});
			const ctx = makeServerCtx(new Map([[getter.toolId, getter]]));
			ctx.callerIdentity!.scopes = ["mcp:tedis.read"];
			const registered = new Map<string, (args: unknown) => Promise<unknown>>();
			await registerCodeModeTools(
				{
					registerTool: (
						name: string,
						_config: unknown,
						handler: (args: unknown) => Promise<unknown>,
					) => registered.set(name, handler),
				} as never,
				ctx,
			);
			const response = (await registered.get("code")!({
				code: "async () => repeated_tedi_lookup()",
			})) as {
				structuredContent: {
					result: Array<{
						id?: string;
						status?: string;
						completionEvidence: {
							status: string;
							providerConfirmation: string;
							retry: { attempts: number; blocked: boolean };
						};
					}>;
					completionEvidence: { status: string; unsupportedClaims: string[] };
				};
			};
			expect(executeToolMock).toHaveBeenCalledTimes(dispatches);
			const rows = response.structuredContent.result;
			expect(rows).toHaveLength(3);
			expect(rows.map((row) => row.completionEvidence.retry.attempts)).toEqual(
				attempts,
			);
			expect(
				rows.slice(0, dispatches).map((row) => row.completionEvidence.status),
			).toEqual(Array(dispatches).fill(expected));
			expect(rows[0]?.status).toBe(status);
			if (dispatches === 3) {
				expect(rows.every((row) => !row.completionEvidence.retry.blocked)).toBe(
					true,
				);
				expect(
					rows.every(
						(row) => row.completionEvidence.providerConfirmation === "unknown",
					),
				).toBe(true);
			} else expect(rows[2]?.completionEvidence.retry.blocked).toBe(true);
			expect(response.structuredContent.completionEvidence.status).toBe(
				expected === "succeeded"
					? "succeeded"
					: expected === "pending" || expected === "partial"
						? "partial"
						: "failed",
			);
			expect(
				response.structuredContent.completionEvidence.unsupportedClaims,
			).toContain("the delegated task's goal was achieved");
		},
	);

	it("blocks the third identical failed call within one execution", async () => {
		const registered = new Map<string, (args: unknown) => Promise<unknown>>();
		const server = {
			registerTool: vi.fn(
				(
					name: string,
					_config: unknown,
					handler: (args: unknown) => Promise<unknown>,
				) => {
					registered.set(name, handler);
				},
			),
		};

		await registerCodeModeTools(server as never, makeServerCtx());
		const response = (await registered.get("code")?.({
			code: "async () => repeated_soft_fail()",
		})) as {
			structuredContent?: {
				result?: Array<{
					completionEvidence?: {
						retry?: { attempts?: number; blocked?: boolean };
					};
				}>;
			};
		};

		expect(executeToolMock).toHaveBeenCalledTimes(2);
		expect(response.structuredContent?.result).toHaveLength(3);
		expect(
			response.structuredContent?.result?.map(
				(item) => item.completionEvidence?.retry,
			),
		).toEqual([
			expect.objectContaining({ attempts: 1, blocked: false }),
			expect.objectContaining({ attempts: 2, blocked: false }),
			expect.objectContaining({ attempts: 2, blocked: true }),
		]);
	});

	it("writes rpc and exec telemetry directly to Analytics Engine", async () => {
		const writeDataPoint = vi.fn();
		const registered = new Map<string, (args: unknown) => Promise<unknown>>();
		const server = {
			registerTool: vi.fn(
				(
					name: string,
					_config: unknown,
					handler: (args: unknown) => Promise<unknown>,
				) => {
					registered.set(name, handler);
				},
			),
		};

		await registerCodeModeTools(
			server as never,
			makeServerCtx(undefined, writeDataPoint),
		);
		await registered.get("code")?.({ code: "async () => test.soft_fail({})" });

		expect(writeDataPoint).toHaveBeenCalledTimes(2);
		const [rpc, exec] = writeDataPoint.mock.calls.map(([point]) => point);
		expect(rpc.blobs.slice(0, 5)).toEqual([
			"rpc",
			"app-uuid",
			"test-app",
			"org-uuid",
			"test.soft_fail",
		]);
		expect(rpc.indexes).toEqual(["app-uuid"]);
		expect(rpc.doubles[0]).toBe(0);
		expect(exec.blobs.slice(0, 5)).toEqual([
			"exec",
			"app-uuid",
			"test-app",
			"org-uuid",
			"code",
		]);
		expect(exec.indexes).toEqual(["app-uuid"]);
		expect(exec.doubles[0]).toBe(1);
		expect(exec.doubles[2]).toBe("async () => test.soft_fail({})".length);
		expect(exec.doubles[3]).toBe(1);
		expect(exec.doubles[4]).toBe(1);
	});

	it("bounds oversized successful code results before returning them to the model", async () => {
		const registered = new Map<string, (args: unknown) => Promise<unknown>>();
		const server = {
			registerTool: vi.fn(
				(
					name: string,
					_config: unknown,
					handler: (args: unknown) => Promise<unknown>,
				) => {
					registered.set(name, handler);
				},
			),
		};

		await registerCodeModeTools(server as never, makeServerCtx());
		const response = (await registered.get("code")?.({
			code: "async () => large_result()",
		})) as {
			content: Array<{ text: string }>;
			structuredContent: {
				result: unknown;
				resultIdentity?: Record<string, unknown>;
			};
		};

		// The oversized result is bounded via the detectable `__tedix_truncated`
		// envelope — never the old bare clipped string that downstream parsers
		// silently treated as an empty result.
		expect(response.content[0]?.text).toContain("__tedix_truncated");
		const truncatedResult = response.structuredContent.result as Record<
			string,
			unknown
		>;
		expect(typeof truncatedResult).not.toBe("string");
		expect(truncatedResult.__tedix_truncated).toBe(true);
		expect(truncatedResult.marker).toBe("--- TRUNCATED ---");
		expect(typeof truncatedResult.preview).toBe("string");
		expect(truncatedResult.guidance).toContain("Narrow the projection");
		expect(response.structuredContent.resultIdentity).toEqual({
			status: {
				id: "workflow-run-1",
				status: "completed",
				tediId: "tedi-cto",
			},
			inspection: {
				revision: { revision: 8, skillSlug: "kernel-goal-loop" },
			},
		});
	});

	it("exposes the direct gateway runtime context inside the sandbox", async () => {
		const registered = new Map<string, (args: unknown) => Promise<unknown>>();
		const server = {
			registerTool: vi.fn(
				(
					name: string,
					_config: unknown,
					handler: (args: unknown) => Promise<unknown>,
				) => {
					registered.set(name, handler);
				},
			),
		};

		await registerCodeModeTools(server as never, makeServerCtx());
		const response = (await registered.get("code")?.({
			code: "async () => codemode.__runtime()",
		})) as {
			structuredContent: {
				executionId: string;
				result: {
					appId: string;
					appSlug: string;
					executionId: string;
					mode: string;
					namespaceCount: number;
					surface: string;
					toolCount: number;
					executionSurface: {
						kind: string;
						participantIds: string[];
						sessionIds: string[];
						surfaceId: string;
					};
				};
			};
		};

		expect(response.structuredContent.result).toMatchObject({
			appId: "app-uuid",
			appSlug: "test-app",
			executionId: response.structuredContent.executionId,
			mode: "stateless",
			surface: "mcp-gateway",
			// 1 app tool + 5 ui + 1 codemode + 4 flow built-ins.
			toolCount: 12,
			namespaceCount: 4,
			executionSurface: {
				kind: "mcp-gateway",
				surfaceId: "mcp-gateway:app-uuid",
				participantIds: ["tedi-uuid", "user-uuid"],
				sessionIds: [response.structuredContent.executionId],
			},
		});
	});

	it("keeps discover.search results and meta intact across the worker clone boundary", async () => {
		const registered = new Map<string, (args: unknown) => Promise<unknown>>();
		const server = {
			registerTool: vi.fn(
				(
					name: string,
					_config: unknown,
					handler: (args: unknown) => Promise<unknown>,
				) => {
					registered.set(name, handler);
				},
			),
		};

		await registerCodeModeTools(server as never, makeServerCtx());
		const response = (await registered.get("code")?.({
			code: "async () => discover_search_slice",
		})) as {
			structuredContent: {
				result: {
					firstCallable?: string;
					ok: boolean;
					resultsIsArray: boolean;
				};
			};
		};

		expect(response.structuredContent.result).toEqual({
			ok: true,
			firstCallable: "test.soft_fail",
			resultsIsArray: true,
			metaSurvivesClone: true,
		});
	});

	it("serializes side-effectful Computer calls inside one Code Mode execution", async () => {
		const registered = new Map<string, (args: unknown) => Promise<unknown>>();
		const server = {
			registerTool: vi.fn(
				(
					name: string,
					_config: unknown,
					handler: (args: unknown) => Promise<unknown>,
				) => {
					registered.set(name, handler);
				},
			),
		};
		const loadedTools = new Map([
			[
				"cto__exec",
				tool({
					toolId: "cto__exec",
					title: "Start Process",
					description: "Execute a Computer command",
				}),
			],
			[
				"cto__read_execution",
				tool({
					toolId: "cto__read_execution",
					title: "Read Process",
					description: "Read a workstation process",
				}),
			],
		]);
		const calls: string[] = [];
		executeToolMock.mockImplementation(async (_serverCtx, appTool) => {
			calls.push(`start:${appTool.toolId}`);
			await new Promise((resolve) => setTimeout(resolve, 10));
			calls.push(`end:${appTool.toolId}`);
			return {
				content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
				structuredContent: { ok: true, toolId: appTool.toolId },
				_meta: {},
				isError: false,
			};
		});
		const serverCtx = makeServerCtx(loadedTools);
		(serverCtx.appMetadata!.mcpConfig as Record<string, unknown>).toolScopes = {
			read_execution: [],
			exec: [],
		};

		await registerCodeModeTools(server as never, serverCtx);
		await registered.get("code")?.({
			code: "async () => parallel_computer_side_effects",
		});

		expect(calls).toEqual([
			"start:cto__exec",
			"end:cto__exec",
			"start:cto__read_execution",
			"end:cto__read_execution",
		]);
	});
});

describe("Code Mode native executor budget", () => {
	it.each([undefined, 90000, 300000, 330000])(
		"uses the default or explicit pin %s",
		async (pin) => {
			executorBudgets.length = 0;
			const registered = new Map<string, (args: unknown) => Promise<any>>();
			const server = {
				registerTool: (name: string, _config: unknown, handler: any) =>
					registered.set(name, handler),
			};
			const ctx = makeServerCtx();
			if (pin !== undefined) ctx.appMetadata!.mcpConfig!.codeModeTimeout = pin;
			await registerCodeModeTools(server as never, ctx);
			await registered.get("code")!({ code: "async () => 1" });
			expect(executorBudgets).toEqual([pin ?? 330000]);
		},
	);
});

// These cases traverse production constructor wiring; the special mock branch
// delegates execution to the real pinned SDK and an owned fake native Loader.
describe("production loader host wiring", () => {
	afterEach(() => vi.restoreAllMocks());
	const fixtureLoader = () => {
		const load = vi.fn(
			() =>
				({
					getEntrypoint: () => ({
						evaluate: async () => ({ result: 1, logs: [] }),
					}),
				}) as unknown as WorkerStub,
		);
		return { load, get: vi.fn() } as WorkerLoader & {
			load: ReturnType<typeof vi.fn>;
		};
	};
	const loaderEvents = (spy: ReturnType<typeof vi.spyOn>) =>
		spy.mock.calls.flatMap(([s]: unknown[]) => {
			if (
				typeof s !== "string" ||
				!s.startsWith('{"event":"tedix.dynamic_worker.loader_call"')
			)
				return [];
			return [JSON.parse(s)];
		});
	const assertPair = (
		spy: ReturnType<typeof vi.spyOn>,
		surface: string,
		reason: string,
	) => {
		expect(loaderEvents(spy)).toEqual(
			["attempted", "returned"].map((phase) => ({
				event: "tedix.dynamic_worker.loader_call",
				version: 1,
				surface,
				reason,
				method: "load",
				identity: "anonymous",
				phase,
			})),
		);
	};
	it("gateway production constructor uses actual decorated SDK load", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const loader = fixtureLoader();
		const ctx = makeServerCtx();
		ctx.env.LOADER = loader;
		const callbacks = new Map<string, (args: unknown) => Promise<unknown>>();
		await registerCodeModeTools(
			{
				registerTool: (
					n: string,
					_c: unknown,
					h: (args: unknown) => Promise<unknown>,
				) => callbacks.set(n, h),
			} as never,
			ctx,
		);
		await callbacks.get("code")!({ code: "async () => native_loader_fixture" });
		expect(loader.load).toHaveBeenCalledTimes(1);
		assertPair(spy, "gateway_model_code", "gateway_model_authored_invocation");
	});
	it("stored transport constructor uses actual decorated SDK load", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const loader = fixtureLoader();
		const ctx = makeServerCtx();
		ctx.env.LOADER = loader;
		const config = {
			transport: "code" as const,
			endpoint: "fixture/run",
			codeModule: "() => 'native_loader_fixture'",
		};
		const result = await new ToolHandler().execute({}, {
			...ctx,
			app: { slug: "fixture", organizationId: "fictional-org" },
			env: ctx.env,
			config,
			toolId: "run_fixture",
			executionId: "fictional",
			requestId: "fictional",
		} as unknown as ToolExecutionContext<typeof config>);
		expect(result.status).toBe(200);
		expect(loader.load).toHaveBeenCalledTimes(1);
		assertPair(spy, "stored_tool_code", "stored_tool_authored_invocation");
	});
	it("stateless tedi registration constructor uses actual decorated SDK load", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const loader = fixtureLoader();
		const inner = new McpServer({ name: "fictional", version: "1" });
		inner.registerTool(
			"get_fixture",
			{ inputSchema: z.object({}) },
			async () => ({ content: [{ type: "text", text: "1" }] }),
		);
		const callbacks = new Map<string, (args: unknown) => Promise<unknown>>();
		expect(
			await registerStateless(
				{
					registerTool: (
						n: string,
						_c: unknown,
						h: (args: unknown) => Promise<unknown>,
					) => callbacks.set(n, h),
				} as never,
				inner,
				{ loader, tediId: "fictional" },
			),
		).toBe(true);
		await callbacks.get("code")!({ code: "async () => native_loader_fixture" });
		await inner.close();
		expect(loader.load).toHaveBeenCalledTimes(1);
		assertPair(
			spy,
			"tedi_stateless_mcp_code",
			"tedi_stateless_authored_invocation",
		);
	});
	it("durable tedi constructor passes its decorated loader to runtime", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const loader = fixtureLoader();
		// Runtime-only import keeps this Node fixture out of the MCP source type
		// graph. Runtime source is checked separately in its owning workspace.
		const { createTediDurableCodemode } = await vi.importActual<{
			createTediDurableCodemode: (
				input: Record<string, unknown>,
			) => Promise<{ execute: (input: { code: string }) => Promise<unknown> }>;
		}>("../../../tedi-runtime/src/durable-codemode");
		const runtime = await createTediDurableCodemode({
			ctx: {} as DurableObjectState,
			env: {} as Cloudflare.Env,
			loader,
			name: "fictional",
			mcpRuntime: {} as never,
			workspace: {} as never,
		});
		await runtime.execute({ code: "async () => native_loader_fixture" });
		expect(loader.load).toHaveBeenCalledTimes(1);
		assertPair(spy, "tedi_durable_code", "tedi_durable_authored_invocation");
	});
	it("configured native catalog handler and owning callback make no loader calls or events", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const loader = fixtureLoader();
		const ctx = makeServerCtx();
		ctx.env.LOADER = loader;
		const config = {
			transport: "catalog" as const,
			endpoint: "catalog/search" as const,
		};
		const result = await new ToolHandler().execute({ query: "soft" }, {
			...ctx,
			config,
			toolId: "search_catalog",
			catalogTransport: (
				...args: Parameters<
					import("@tedix/api-contract/schemas/tools").CatalogueTransportCallback
				>
			) => executeCatalogOperation(ctx, ...args),
		} as unknown as ToolExecutionContext<typeof config>);
		expect(result.status).toBe(200);
		expect(result.data).toHaveProperty("results");
		expect(loader.load).not.toHaveBeenCalled();
		expect(loader.get).not.toHaveBeenCalled();
		expect(loaderEvents(spy)).toEqual([]);
	});
});
