import { createRouterClient, os } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import {
	approveTediCodeExecution,
	dispatchTediDurableCode,
	getTediCodeExecution,
	listTediCodeExecutions,
	rejectTediCodeExecution,
	rollbackTediCodeExecution,
	recoverTediCodeExecution,
	runTediDurableCode,
} from "./durable-code";
import {
	verifyDurableCodeDelegation,
	DURABLE_CODE_DELEGATION_HEADER,
} from "@tedix/mcp-shared/auth/durable-code-delegation";
import { MCP_MODERN_PROTOCOL_VERSION } from "@tedix/mcp-shared/protocol";
import { validateModernProtocolHeaders } from "@tedix/mcp-shared/transport";

const { lookup, membership, fetcher } = vi.hoisted(() => ({
	lookup: vi.fn(),
	membership: vi.fn(),
	fetcher: vi.fn(),
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediByIdForOrganization: lookup,
}));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getMemberByUserId: membership,
}));
// Fixtures represent the owning auth layer's verified context; real RBAC and
// operation scope guards remain enabled below.
vi.mock("../../orpc", async (original) => ({
	...(await original<typeof import("../../orpc")>()),
	withAuth: os
		.$context<BaseContext>()
		.middleware(({ context, next }) => next({ context })),
}));
const ORG = "11111111-1111-4111-8111-111111111111";
const TEDI = "22222222-2222-4222-8222-222222222222";
const EXECUTION = "exec_123_33333333-3333-4333-8333-333333333333";
function context(overrides: Partial<BaseContext> = {}): BaseContext {
	return {
		db: {},
		env: { TEDI_SERVICE: { fetch: fetcher } },
		authType: "user",
		organizationId: ORG,
		userRole: "owner",
		user: {
			sub: "operator-subject",
			email: "operator@example.com",
			scopes: ["mcp:tedis.read", "mcp:tedis.write", "mcp:tedis.admin"],
			roles: [],
			permissions: [],
			iss: "issuer",
			exp: 9999999999,
			iat: 1,
		},
		headers: new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Caller-Type": "mcp-edge-user",
		}),
		url: new URL("https://api.example.com/rpc/tedis/listTediCodeExecutions"),
		...overrides,
	} as unknown as BaseContext;
}
function client(ctx = context()) {
	return createRouterClient(
		{
			runTediDurableCode,
			listTediCodeExecutions,
			getTediCodeExecution,
			approveTediCodeExecution,
			rejectTediCodeExecution,
			rollbackTediCodeExecution,
			recoverTediCodeExecution,
		},
		{ context: ctx },
	);
}
function result(value: unknown) {
	return Response.json({
		jsonrpc: "2.0",
		id: 1,
		result: { structuredContent: value },
	});
}
beforeEach(() => {
	vi.clearAllMocks();
	lookup.mockResolvedValue({
		id: TEDI,
		organizationId: ORG,
		slug: "test-worker",
	});
	membership.mockResolvedValue({ status: "active", role: "owner" });
	fetcher.mockResolvedValue(result({ executions: [] }));
});
describe("organization-fenced durable code projection", () => {
	it("defaults and binds list arguments, preserving actual operator identity", async () => {
		expect(await client().listTediCodeExecutions({ tediId: TEDI })).toEqual({
			executions: [],
		});
		expect(lookup).toHaveBeenCalledWith(expect.anything(), TEDI, ORG);
		const [url, options] = fetcher.mock.calls[0]!;
		expect(url).toBe("https://test-worker.tedi.tedix.dev/mcp");
		expect(options.headers["X-Tedix-Host"]).toBe("test-worker.tedi.tedix.dev");
		const request = JSON.parse(options.body);
		expect(request.params).toMatchObject({
			name: "list_code_executions",
			arguments: { limit: 20 },
		});
		const envelope = JSON.parse(
			options.headers[DURABLE_CODE_DELEGATION_HEADER],
		);
		expect(envelope.operator.subject).toBe("operator-subject");
		expect(
			(
				await verifyDurableCodeDelegation({
					tediId: TEDI,
					organizationId: ORG,
					operation: "list_code_executions",
					arguments: { limit: 20 },
					envelope,
					transport: "trusted-service-binding",
					now: Date.now(),
				})
			).ok,
		).toBe(true);
	});
	it("routes the trusted binding by the organization-fenced target, ignoring incoming host overrides", async () => {
		const ctx = context();
		ctx.headers.set("X-Tedix-Host", "another-worker.tedi.tedix.dev");
		ctx.headers.set("Host", "another-worker.tedi.tedix.dev");
		lookup.mockResolvedValue({
			id: TEDI,
			organizationId: ORG,
			slug: "selected-worker",
		});
		await client(ctx).listTediCodeExecutions({ tediId: TEDI });
		const [url, options] = fetcher.mock.calls[0]!;
		expect(url).toBe("https://selected-worker.tedi.tedix.dev/mcp");
		// The tedi edge resolves named service bindings from this header, not URL.hostname.
		expect(new Headers(options.headers).get("X-Tedix-Host")).toBe(
			new URL(url).hostname,
		);
		expect(new Headers(options.headers).get("Host")).toBeNull();
	});
	it("binds the outbound operation to the current MCP transport contract", async () => {
		await client().listTediCodeExecutions({ tediId: TEDI });
		const [, options] = fetcher.mock.calls[0]!;
		const request = JSON.parse(options.body);
		const headers = new Headers(options.headers);
		expect(headers.get("MCP-Protocol-Version")).toBe(
			MCP_MODERN_PROTOCOL_VERSION,
		);
		expect(headers.get("Mcp-Method")).toBe("tools/call");
		expect(headers.get("Mcp-Name")).toBe(request.params.name);
		expect(validateModernProtocolHeaders({ headers, ...request })).toBeNull();
		headers.set("Mcp-Name", "get_code_execution");
		expect(validateModernProtocolHeaders({ headers, ...request })?.code).toBe(
			-32020,
		);
		headers.set("Mcp-Name", request.params.name);
		delete request.params._meta;
		expect(validateModernProtocolHeaders({ headers, ...request })?.code).toBe(
			-32602,
		);
	});
	it("denies a target outside the selected organization before contacting runtime", async () => {
		lookup.mockResolvedValue(null);
		await expect(
			client().listTediCodeExecutions({ tediId: TEDI }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("denies stale organization membership", async () => {
		membership.mockResolvedValue({ status: "disabled" });
		await expect(
			client().listTediCodeExecutions({ tediId: TEDI }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("requires OAuth operation scope even when RBAC permits", async () => {
		const ctx = context();
		ctx.user!.scopes = ["mcp:tedis.read"];
		await expect(
			client(ctx).runTediDurableCode({ tediId: TEDI, code: "1" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("enforces RBAC separately from the approved OAuth scope", async () => {
		await expect(
			client(context({ userRole: "viewer" })).runTediDurableCode({
				tediId: TEDI,
				code: "1",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(fetcher).not.toHaveBeenCalled();
	});
	it.each([
		{ headers: new Headers() },
		{
			headers: new Headers({
				"X-Service-Binding": "true",
				"X-Tedix-Caller-Type": "mcp-edge-external-agent",
			}),
			externalAgentPrincipalId: "agent-id",
		},
		{
			authType: "apikey" as const,
			apiKey: {
				id: "key",
				organizationId: ORG,
				name: "key",
				scopes: ["mcp:tedis.admin"],
			},
		},
		{
			authType: "tedi" as const,
			tediId: TEDI,
			tediScopes: ["mcp:tedis.admin"],
		},
	])(
		"never classifies another caller as a human operator",
		async (overrides) => {
			await expect(
				dispatchTediDurableCode(
					context(overrides),
					TEDI,
					"approve_code_execution",
					{ execution_id: EXECUTION },
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(fetcher).not.toHaveBeenCalled();
		},
	);
	it("preserves missing execution and rejection false outcomes", async () => {
		fetcher.mockResolvedValueOnce(
			result({
				ok: false,
				error: "execution_not_found",
				execution_id: EXECUTION,
			}),
		);
		expect(
			await client().getTediCodeExecution({
				tediId: TEDI,
				executionId: EXECUTION,
			}),
		).toEqual({
			ok: false,
			error: "execution_not_found",
			execution_id: EXECUTION,
		});
		fetcher.mockResolvedValueOnce(
			result({ ok: false, execution_id: EXECUTION, seq: 4 }),
		);
		expect(
			await client().rejectTediCodeExecution({
				tediId: TEDI,
				executionId: EXECUTION,
				seq: 4,
			}),
		).toEqual({ ok: false, execution_id: EXECUTION, seq: 4 });
	});
	it.each(["run", "approve", "rollback"])(
		"routes %s through its exact native operation",
		async (verb) => {
			fetcher.mockResolvedValue(
				result(
					verb === "rollback"
						? { ok: true, execution_id: EXECUTION }
						: { status: "completed", executionId: EXECUTION, result: 1 },
				),
			);
			if (verb === "run")
				await client().runTediDurableCode({ tediId: TEDI, code: "1" });
			else if (verb === "approve")
				await client().approveTediCodeExecution({
					tediId: TEDI,
					executionId: EXECUTION,
				});
			else
				await client().rollbackTediCodeExecution({
					tediId: TEDI,
					executionId: EXECUTION,
				});
			const { name, arguments: args } = JSON.parse(
				fetcher.mock.calls[0]![1].body,
			).params;
			expect({ name, arguments: args }).toEqual(
				verb === "run"
					? { name: "run_durable_code", arguments: { code: "1" } }
					: {
							name: `${verb}_code_execution`,
							arguments: { execution_id: EXECUTION },
						},
			);
		},
	);
	it("rejects a runtime protocol error instead of treating it as success", async () => {
		fetcher.mockResolvedValue(
			Response.json({
				jsonrpc: "2.0",
				id: 1,
				error: { code: -32603, message: "denied" },
			}),
		);
		await expect(
			client().listTediCodeExecutions({ tediId: TEDI }),
		).rejects.toMatchObject({ code: "BAD_GATEWAY" });
	});
	it.each([
		{
			status: 400,
			payload: {
				id: null,
				error: { code: -32022, message: "secret-runtime-message" },
			},
			detail: "HTTP 400, http_rejected, RPC -32022",
		},
		{
			status: 403,
			payload: {
				error: "durable_code_delegation_invalid",
				reason: "binding_mismatch",
			},
			detail: "HTTP 403, http_rejected, binding_mismatch",
		},
		{
			status: 403,
			payload: {
				error: "durable_code_delegation_invalid",
				reason: "secret-runtime-message",
			},
			detail: "HTTP 403, http_rejected",
		},
		{
			status: 400,
			payload: {
				error: {
					code: "secret-runtime-message",
					message: "secret-runtime-message",
				},
			},
			detail: "HTTP 400, http_rejected",
		},
		{
			status: 400,
			payload: { error: { code: -32022.5 } },
			detail: "HTTP 400, http_rejected",
		},
		{
			status: 400,
			payload: { error: { code: Number.MAX_SAFE_INTEGER + 1 } },
			detail: "HTTP 400, http_rejected",
		},
		{
			status: 200,
			payload: { id: 1, error: { message: "secret-runtime-message" } },
			detail: "HTTP 200, rpc_error",
		},
		{
			status: 200,
			payload: { id: "secret-runtime-message", result: {} },
			detail: "HTTP 200, id_mismatch",
		},
		{
			status: 200,
			payload: {
				id: 1,
				result: { isError: true, content: "secret-runtime-message" },
			},
			detail: "HTTP 200, tool_error",
		},
		{
			status: 200,
			payload: { id: 1, result: "secret-runtime-message" },
			detail: "HTTP 200, invalid_result",
		},
	])(
		"reports only safe runtime failure diagnostics ($detail)",
		async ({ status, payload, detail }) => {
			fetcher.mockResolvedValue(
				Response.json(payload, {
					status,
					headers: { "X-Secret": "secret-runtime-message" },
				}),
			);
			await expect(
				client().listTediCodeExecutions({ tediId: TEDI }),
			).rejects.toMatchObject({
				code: "BAD_GATEWAY",
				message: `Tedi runtime declined the durable code operation (${detail})`,
			});
		},
	);
	it.each([
		[
			'Error: Invalid codemode runtime name "private-worker:secret" — use letters, digits, "_", "-" or "."',
			"runtime_name_invalid",
		],
		[
			'CodemodeRuntime is not exported from this Worker entry. Add the @cloudflare/codemode/vite plugin to your Vite config, or manually export { CodemodeRuntime } from "@cloudflare/codemode".',
			"runtime_export_missing",
		],
		[
			"Error: LOADER binding unavailable for durable Code Mode",
			"loader_unavailable",
		],
		["MCP runtime unavailable", "mcp_unavailable"],
		["MCP runtime unavailable for durable Code Mode", "mcp_unavailable"],
		["Bearer secret user-provided code and messages", null],
		["user code: MCP runtime unavailable", null],
		["MCP runtime unavailable" + "secret".repeat(300), null],
	])(
		"classifies only bounded known native tool errors",
		async (text, classification) => {
			fetcher.mockResolvedValue(
				Response.json({
					id: 1,
					result: { isError: true, content: [{ type: "text", text }] },
				}),
			);
			await expect(
				client().listTediCodeExecutions({ tediId: TEDI }),
			).rejects.toMatchObject({
				code: "BAD_GATEWAY",
				message: `Tedi runtime declined the durable code operation (HTTP 200, tool_error${classification ? `, ${classification}` : ""})`,
			});
		},
	);
	it("does not classify known text outside an actual native tool error", async () => {
		fetcher.mockResolvedValue(
			Response.json({
				id: "secret",
				result: {
					isError: true,
					content: [{ type: "text", text: "MCP runtime unavailable" }],
				},
			}),
		);
		await expect(
			client().listTediCodeExecutions({ tediId: TEDI }),
		).rejects.toMatchObject({
			message:
				"Tedi runtime declined the durable code operation (HTTP 200, id_mismatch)",
		});
	});
	it.each([
		{
			authType: "service-binding" as const,
			headers: new Headers({
				"X-Service-Binding": "true",
				"X-Tedix-Caller-Type": "mcp-edge-external-agent",
			}),
			externalAgentPrincipalId: "agent-principal",
			externalAgentSessionId: "session",
			externalAgentClientRecordId: "client-record",
			tediScopes: ["mcp:tedis.read", "mcp:tedis.write", "mcp:tedis.admin"],
		},
		{
			authType: "tedi" as const,
			tediId: TEDI,
			tediScopes: ["mcp:tedis.read", "mcp:tedis.write", "mcp:tedis.admin"],
		},
		{
			authType: "apikey" as const,
			apiKey: {
				id: "key",
				organizationId: ORG,
				name: "key",
				scopes: ["mcp:tedis.read", "mcp:tedis.write", "mcp:tedis.admin"],
			},
		},
		{
			authType: "m2m" as const,
			serviceAccount: {
				clientId: "service-client",
				scope: "mcp:tedis.read mcp:tedis.write mcp:tedis.admin",
			},
		},
		{
			authType: "service-binding" as const,
			serviceAccount: { clientId: "named-service" },
			tediScopes: ["mcp:tedis.read", "mcp:tedis.write", "mcp:tedis.admin"],
		},
	])(
		"preserves machine read/write identity and denies lifecycle management",
		async (overrides) => {
			const ctx = context(overrides);
			await client(ctx).listTediCodeExecutions({ tediId: TEDI });
			let envelope = JSON.parse(
				fetcher.mock.calls[0]![1].headers[DURABLE_CODE_DELEGATION_HEADER],
			);
			expect(envelope.operator.classification).not.toBe("human");
			expect(envelope.operator.email).toBeUndefined();
			expect(membership).not.toHaveBeenCalled();
			fetcher.mockResolvedValueOnce(
				result({ status: "completed", executionId: EXECUTION, result: 1 }),
			);
			await client(ctx).runTediDurableCode({ tediId: TEDI, code: "1" });
			envelope = JSON.parse(
				fetcher.mock.calls[1]![1].headers[DURABLE_CODE_DELEGATION_HEADER],
			);
			expect(envelope.capability).toBe("mcp:tedis.write");
			for (const call of [
				() =>
					client(ctx).recoverTediCodeExecution({
						tediId: TEDI,
						executionId: EXECUTION,
					}),
				() =>
					client(ctx).approveTediCodeExecution({
						tediId: TEDI,
						executionId: EXECUTION,
					}),
				() =>
					client(ctx).rejectTediCodeExecution({
						tediId: TEDI,
						executionId: EXECUTION,
						seq: 0,
					}),
				() =>
					client(ctx).rollbackTediCodeExecution({
						tediId: TEDI,
						executionId: EXECUTION,
					}),
			])
				await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(fetcher).toHaveBeenCalledTimes(2);
		},
	);
	it("rejects unnamed service transport and missing machine capability", async () => {
		await expect(
			client(
				context({ authType: "service-binding", user: undefined }),
			).listTediCodeExecutions({ tediId: TEDI }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client(
				context({
					authType: "apikey",
					user: undefined,
					apiKey: { id: "key", organizationId: ORG, name: "key", scopes: [] },
				}),
			).listTediCodeExecutions({ tediId: TEDI }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("rejects arbitrary organization and runtime routing input", async () => {
		await expect(
			client().listTediCodeExecutions({
				tediId: TEDI,
				organizationId: ORG,
			} as never),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("rejects malformed runtime projection as a gateway failure", async () => {
		fetcher.mockResolvedValue(result({ executions: "not-an-array" }));
		await expect(
			client().listTediCodeExecutions({ tediId: TEDI }),
		).rejects.toMatchObject({ code: "BAD_GATEWAY" });
	});
});

describe("human recovery projection", () => {
	beforeEach(() => {
		lookup.mockResolvedValue({ id: TEDI, organizationId: ORG, slug: "worker" });
		membership.mockResolvedValue({ status: "active" });
		fetcher.mockReset();
	});
	it("projects human-only recovery with exact id and no public revision override", async () => {
		fetcher.mockResolvedValueOnce(
			result({
				recovered: true,
				execution_id: EXECUTION,
				execution_status: "error",
				completion: "unconfirmed",
				effects_may_have_occurred: true,
			}),
		);
		expect(
			await client().recoverTediCodeExecution({
				tediId: TEDI,
				executionId: EXECUTION,
			}),
		).toMatchObject({
			recovered: true,
			execution_status: "error",
			completion: "unconfirmed",
		});
		const [, options] = fetcher.mock.calls[0]!;
		const body = JSON.parse(options.body);
		expect(body.params.name).toBe("recover_code_execution");
		expect(body.params.arguments).toEqual({ execution_id: EXECUTION });
		const envelope = JSON.parse(
			options.headers[DURABLE_CODE_DELEGATION_HEADER],
		);
		expect(envelope.capability).toBe("mcp:tedis.admin");
		expect(envelope.operator.classification).toBe("human");
		expect(
			(
				await verifyDurableCodeDelegation({
					tediId: TEDI,
					organizationId: ORG,
					operation: "recover_code_execution",
					arguments: { execution_id: EXECUTION },
					envelope,
					transport: "trusted-service-binding",
					now: Date.now(),
				})
			).ok,
		).toBe(true);
	});
});
