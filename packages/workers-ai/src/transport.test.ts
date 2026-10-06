/**
 * Union of the two app transport suites that preceded this package
 * (`apps/api/src/rpc/routers/kernel/workers-ai-transport.test.ts` and
 * `apps/tedi-runtime/src/workers-ai-transport.test.ts`), plus the two seams the
 * shared transport introduces: a REQUIRED authorizer and pre-normalized
 * attribution.
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	callWorkersAi,
	recoverBareJsonToolCallText,
	recoverInlineToolCallTokens,
	usingWorkersAiGateway,
	type WorkersAiAuthorize,
	type WorkersAiTransportEnv,
	type WorkersAiTransportResult,
	workersAiGatewayTransport,
} from "./transport";

function result(
	text: string,
	toolCalls: WorkersAiTransportResult["toolCalls"] = [],
): WorkersAiTransportResult {
	return {
		text,
		toolCalls,
		usage: { promptTokens: null, completionTokens: null },
	};
}

/** The explicit no-op a caller with no billing plane must pass. */
const passthrough: WorkersAiAuthorize = async (input) => ({
	attribution: input.attribution,
});

/** Fully configured HTTPS gateway: the request leaves through the GLOBAL fetch. */
const GATEWAY_ENV: WorkersAiTransportEnv = {
	AI_GATEWAY_ACCOUNT_ID: "acct-1",
	AI_GATEWAY_LLM_ID: "llm-gw",
	CF_AI_GATEWAY_TOKEN: "aig-token",
	CF_WORKERS_AI_TOKEN: "byok-token",
};

/**
 * Allowlisted binding gateway: the request leaves through `env.AI.fetch`, which
 * is what most tests below spy on. The ALLOWLIST, not the presence of the `AI`
 * binding, selects this path.
 */
const BINDING_GATEWAY_ENV: WorkersAiTransportEnv = {
	AI_GATEWAY_ACCOUNT_ID: "account",
	AI_GATEWAY_LLM_ID: "llm-gw",
	AI_GATEWAY_BINDING_PROVIDERS: "workers-ai",
};

const realFetch = globalThis.fetch;
beforeEach(() => {
	globalThis.fetch = realFetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

function okJson(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function chatResponse(
	content: string | null,
	toolCalls?: Array<{ id?: string; name: string; args: string }>,
): Response {
	return okJson({
		choices: [
			{
				message: {
					content,
					...(toolCalls
						? {
								tool_calls: toolCalls.map((tc) => ({
									id: tc.id,
									type: "function",
									function: { name: tc.name, arguments: tc.args },
								})),
							}
						: {}),
				},
			},
		],
		usage: { prompt_tokens: 11, completion_tokens: 7 },
	});
}

// ── transport resolution ─────────────────────────────────────────────────────

describe("workersAiGatewayTransport", () => {
	it("resolves the HTTPS path when account + both tokens are present", () => {
		const transport = workersAiGatewayTransport(GATEWAY_ENV);
		expect(transport?.kind).toBe("https");
		expect(transport?.providerRoot).toBe(
			"https://gateway.ai.cloudflare.com/v1/acct-1/llm-gw/workers-ai",
		);
		expect(usingWorkersAiGateway(GATEWAY_ENV)).toBe(true);
	});

	it("refuses the HTTPS path without the Workers-AI BYOK token", () => {
		expect(
			workersAiGatewayTransport({
				...GATEWAY_ENV,
				CF_WORKERS_AI_TOKEN: "   ",
			}),
		).toBeNull();
	});

	it("is null without a gateway id (→ the env.AI binding fallback)", () => {
		expect(
			workersAiGatewayTransport({ ...GATEWAY_ENV, AI_GATEWAY_LLM_ID: " " }),
		).toBeNull();
		expect(usingWorkersAiGateway({})).toBe(false);
	});

	it("prefers the binding host when workers-ai is allowlisted — no BYOK token needed", () => {
		const transport = workersAiGatewayTransport({
			AI_GATEWAY_ACCOUNT_ID: "account",
			AI: { fetch: async () => new Response("") } as unknown as Ai,
			AI_GATEWAY_LLM_ID: "llm-gw",
			AI_GATEWAY_BINDING_PROVIDERS: "workers-ai",
		});
		expect(transport?.kind).toBe("binding");
		expect(transport?.providerRoot).toBe(
			"https://workers-binding.ai/ai-gateway/gateways/llm-gw/workers-ai",
		);
	});
});

// ── authorization seam ───────────────────────────────────────────────────────

describe("authorization", () => {
	it("runs the authorizer BEFORE any request leaves the Worker", async () => {
		const order: string[] = [];
		const fetchSpy = vi.fn(async () => {
			order.push("fetch");
			return chatResponse("hi");
		});
		const authorize = vi.fn(async () => {
			order.push("authorize");
			return {};
		});
		await callWorkersAi(
			{
				env: {
					AI_GATEWAY_ACCOUNT_ID: "account",
					AI_GATEWAY_LLM_ID: "gateway",
					...BINDING_GATEWAY_ENV,
					AI: { fetch: fetchSpy } as unknown as Ai,
				},
				authorize,
			},
			"@cf/openai/gpt-oss-120b",
			{ messages: [{ role: "user", content: "hi" }] },
		);
		expect(order).toEqual(["authorize", "fetch"]);
	});

	it("passes the model and the exact serialized payload to the authorizer", async () => {
		const authorize = vi.fn(async () => ({}));
		const fetchSpy = vi.fn(async () => chatResponse("ok"));
		await callWorkersAi(
			{
				env: {
					AI_GATEWAY_ACCOUNT_ID: "account",
					AI_GATEWAY_LLM_ID: "gateway",
					...BINDING_GATEWAY_ENV,
					AI: { fetch: fetchSpy } as unknown as Ai,
				},
				authorize,
			},
			"@cf/openai/gpt-oss-120b",
			{
				messages: [{ role: "user", content: "hi" }],
				tools: [{ type: "function" }],
				max_tokens: 64,
			},
		);
		expect(authorize).toHaveBeenCalledWith({
			execution: {
				provider: "workers-ai",
				requestModel: "@cf/openai/gpt-oss-120b",
				gatewayAccountId: "account",
				gatewayId: "llm-gw",
				transportKind: "gateway-binding",
				apiKind: "workers-ai-chat",
				providerResource: null,
				providerOrigin: null,
				deployment: null,
			},
			model: "@cf/openai/gpt-oss-120b",
			body: JSON.stringify({
				model: "@cf/openai/gpt-oss-120b",
				messages: [{ role: "user", content: "hi" }],
				tools: [{ type: "function" }],
				max_tokens: 64,
			}),
			attribution: undefined,
			signal: undefined,
		});
	});

	it("propagates an authorizer refusal instead of sending the request", async () => {
		const fetchSpy = vi.fn(async () => chatResponse("ok"));
		await expect(
			callWorkersAi(
				{
					env: {
						AI_GATEWAY_ACCOUNT_ID: "account",
						AI_GATEWAY_LLM_ID: "gateway",
						...BINDING_GATEWAY_ENV,
						AI: { fetch: fetchSpy } as unknown as Ai,
					},
					authorize: async () => {
						throw new Error("inference entitlement exhausted");
					},
				},
				"@cf/openai/gpt-oss-120b",
				{ messages: [] },
			),
		).rejects.toThrow("inference entitlement exhausted");
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

// ── attribution seam ─────────────────────────────────────────────────────────

describe("attribution", () => {
	async function headersFor(
		attribution: Record<string, string> | undefined,
		authorize: WorkersAiAuthorize = passthrough,
	): Promise<Record<string, string>> {
		let seen: Record<string, string> = {};
		const fetchSpy = vi.fn(async (_url: unknown, init?: RequestInit) => {
			seen = (init?.headers ?? {}) as Record<string, string>;
			return chatResponse("ok");
		});
		await callWorkersAi(
			{
				env: {
					AI_GATEWAY_ACCOUNT_ID: "account",
					AI_GATEWAY_LLM_ID: "gateway",
					...BINDING_GATEWAY_ENV,
					AI: { fetch: fetchSpy } as unknown as Ai,
				},
				authorize,
			},
			"@cf/openai/gpt-oss-120b",
			{ messages: [], ...(attribution ? { attribution } : {}) },
		);
		return seen;
	}

	it("serializes a pre-normalized record verbatim, key order preserved", async () => {
		const headers = await headersFor({
			surface: "kernel",
			orgId: "org-1",
			source: "kernel:route",
		});
		expect(headers["cf-aig-metadata"]).toBe(
			'{"surface":"kernel","orgId":"org-1","source":"kernel:route"}',
		);
	});

	it("emits NO header when there is no attribution", async () => {
		expect(await headersFor(undefined)).not.toHaveProperty("cf-aig-metadata");
	});

	it("emits NO header for an empty record — a blank tag attributes nothing", async () => {
		expect(await headersFor({})).not.toHaveProperty("cf-aig-metadata");
	});

	it("sends what the AUTHORIZER returns, not what the caller passed", async () => {
		const headers = await headersFor({ surface: "kernel" }, async () => ({
			attribution: {
				surface: "kernel",
				attribution: '{"v":2,"b":"reservation-1"}',
			},
		}));
		expect(headers["cf-aig-metadata"]).toBe(
			'{"surface":"kernel","attribution":"{\\"v\\":2,\\"b\\":\\"reservation-1\\"}"}',
		);
	});

	it("tags the binding fallback with the same record", async () => {
		const run = vi.fn(async () => ({ response: "ok" }));
		await callWorkersAi(
			{
				env: {
					AI: { run } as unknown as Ai,
					AI_GATEWAY_ACCOUNT_ID: "acct-1",
					AI_GATEWAY_LLM_ID: "llm-gw",
				},
				authorize: passthrough,
			},
			"@cf/openai/gpt-oss-120b",
			{ messages: [], attribution: { surface: "isolate" } },
		);
		expect(run.mock.calls[0]?.[2]).toEqual({
			gateway: { id: "llm-gw", metadata: { surface: "isolate" } },
		});
	});

	it("omits binding metadata entirely when there is none", async () => {
		const run = vi.fn(async () => ({ response: "ok" }));
		await callWorkersAi(
			{
				env: {
					AI: { run } as unknown as Ai,
					AI_GATEWAY_ACCOUNT_ID: "acct-1",
					AI_GATEWAY_LLM_ID: "llm-gw",
				},
				authorize: passthrough,
			},
			"@cf/openai/gpt-oss-120b",
			{ messages: [] },
		);
		expect(run.mock.calls[0]?.[2]).toEqual({ gateway: { id: "llm-gw" } });
	});
});

// ── gateway call shape + errors ──────────────────────────────────────────────

describe("callWorkersAi over the gateway", () => {
	it("sends the OpenAI-shaped body and normalizes the response", async () => {
		let sent: unknown;
		const fetchSpy = vi.fn(async (url: unknown, init?: RequestInit) => {
			sent = JSON.parse(String(init?.body));
			expect(String(url)).toBe(
				"https://gateway.ai.cloudflare.com/v1/acct-1/llm-gw/workers-ai/v1/chat/completions",
			);
			return chatResponse("hello", [
				{ id: "call_x", name: "list_skills", args: '{"limit":3}' },
			]);
		});
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		const out = await callWorkersAi(
			{
				env: {
					AI_GATEWAY_ACCOUNT_ID: "account",
					AI_GATEWAY_LLM_ID: "gateway",
					...GATEWAY_ENV,
					AI: undefined,
				},
				authorize: passthrough,
			},
			"@cf/openai/gpt-oss-120b",
			{
				messages: [{ role: "user", content: "hi" }],
				tools: [{ type: "function" }],
				tool_choice: "auto",
				max_tokens: 32,
				temperature: 0.2,
				response_format: { type: "json_object" },
			},
		);
		expect(sent).toEqual({
			model: "@cf/openai/gpt-oss-120b",
			messages: [{ role: "user", content: "hi" }],
			tools: [{ type: "function" }],
			tool_choice: "auto",
			max_tokens: 32,
			temperature: 0.2,
			response_format: { type: "json_object" },
		});
		expect(out.text).toBe("hello");
		expect(out.toolCalls).toEqual([
			{ id: "call_x", name: "list_skills", arguments: { limit: 3 } },
		]);
		expect(out.usage).toEqual({ promptTokens: 11, completionTokens: 7 });
		expect(fetchSpy).toHaveBeenCalledOnce();
	});

	it("works with NO AI binding at all — the HTTPS path needs none", async () => {
		globalThis.fetch = (async () =>
			chatResponse("")) as unknown as typeof fetch;
		const out = await callWorkersAi(
			{ env: { ...GATEWAY_ENV }, authorize: passthrough },
			"@cf/openai/gpt-oss-120b",
			{ messages: [] },
		);
		expect(out.text).toBe("");
	});

	it("quotes the request-body head on a 4xx (AiError 8001 names nothing)", async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response("AiError: Invalid input", {
					status: 400,
					statusText: "Bad Request",
				}),
		) as unknown as typeof fetch;
		await expect(
			callWorkersAi(
				{ env: GATEWAY_ENV, authorize: passthrough },
				"@cf/openai/gpt-oss-120b",
				{ messages: [{ role: "user", content: "diagnose me" }] },
			),
		).rejects.toThrow(/sent body: \{"model":"@cf\/openai\/gpt-oss-120b"/);
	});

	it("omits the body head on a 5xx (the request was not the problem)", async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response("upstream exploded", {
					status: 503,
					statusText: "Service Unavailable",
				}),
		) as unknown as typeof fetch;
		const error = await callWorkersAi(
			{ env: GATEWAY_ENV, authorize: passthrough },
			"@cf/openai/gpt-oss-120b",
			{ messages: [] },
		).catch((e: Error) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("503 Service Unavailable");
		expect((error as Error).message).not.toContain("sent body:");
	});
});

// ── binding fallback ─────────────────────────────────────────────────────────

describe("callWorkersAi over the env.AI binding", () => {
	it("reads the OpenAI chat shape when `response` is absent", async () => {
		const out = await callWorkersAi(
			{
				env: {
					AI_GATEWAY_ACCOUNT_ID: "account",
					AI_GATEWAY_LLM_ID: "gateway",
					AI: {
						run: async () => ({
							choices: [{ message: { content: "from choices" } }],
							usage: { prompt_tokens: 3, completion_tokens: 4 },
						}),
					} as unknown as Ai,
				},
				authorize: passthrough,
			},
			"@cf/openai/gpt-oss-120b",
			{ messages: [] },
		);
		expect(out.text).toBe("from choices");
		expect(out.usage).toEqual({ promptTokens: 3, completionTokens: 4 });
	});

	it("normalizes binding tool calls with synthesized ids", async () => {
		const out = await callWorkersAi(
			{
				env: {
					AI_GATEWAY_ACCOUNT_ID: "account",
					AI_GATEWAY_LLM_ID: "gateway",
					AI: {
						run: async () => ({
							response: null,
							tool_calls: [{ name: "get_skill", arguments: { slug: "x" } }],
						}),
					} as unknown as Ai,
				},
				authorize: passthrough,
			},
			"@cf/openai/gpt-oss-120b",
			{ messages: [] },
		);
		expect(out.toolCalls).toEqual([
			{ id: "call_0_get_skill", name: "get_skill", arguments: { slug: "x" } },
		]);
	});

	it("rejects an already-aborted signal instead of hanging on the binding", async () => {
		const controller = new AbortController();
		controller.abort(new Error("turn cancelled"));
		await expect(
			callWorkersAi(
				{
					env: {
						AI_GATEWAY_ACCOUNT_ID: "account",
						AI_GATEWAY_LLM_ID: "gateway",
						AI: {
							run: () => new Promise(() => {}),
						} as unknown as Ai,
					},
					authorize: passthrough,
				},
				"@cf/openai/gpt-oss-120b",
				{ messages: [], signal: controller.signal },
			),
		).rejects.toThrow("turn cancelled");
	});

	it("fails loudly when neither a gateway nor the binding is available", async () => {
		await expect(
			callWorkersAi({ env: {}, authorize: passthrough }, "@cf/test", {
				messages: [],
			}),
		).rejects.toThrow("env.AI binding is missing");
	});
});

// ── inline tool-call token recovery (both app suites) ────────────────────────

describe("recoverInlineToolCallTokens", () => {
	it("passes through text without special tokens", () => {
		const input = result("Here are the skills you asked for.");
		expect(recoverInlineToolCallTokens(input)).toBe(input);
	});

	it("recovers a Kimi-K2-style inline tool call and strips it from the text", () => {
		const recovered = recoverInlineToolCallTokens(
			result(
				'<|tool_calls_section_begin|><|tool_call_begin|>functions.tedix_mcp_search_tools:0<|tool_call_argument_begin|>{"query": "skill list"}<|tool_call_end|><|tool_calls_section_end|>',
			),
		);
		expect(recovered.text).toBe("");
		expect(recovered.toolCalls).toEqual([
			{
				id: "call_0_tedix_mcp_search_tools",
				name: "tedix_mcp_search_tools",
				arguments: { query: "skill list" },
			},
		]);
	});

	it("keeps surrounding prose and recovers multiple calls", () => {
		const recovered = recoverInlineToolCallTokens(
			result(
				'Let me look that up.\n<|tool_calls_section_begin|><|tool_call_begin|>functions.list_skills:0<|tool_call_argument_begin|>{}<|tool_call_end|><|tool_call_begin|>get_skill:1<|tool_call_argument_begin|>{"slug":"deploy-worker"}<|tool_call_end|><|tool_calls_section_end|>',
			),
		);
		expect(recovered.text).toBe("Let me look that up.");
		expect(recovered.toolCalls.map((tc) => tc.name)).toEqual([
			"list_skills",
			"get_skill",
		]);
		expect(recovered.toolCalls[1]?.arguments).toEqual({
			slug: "deploy-worker",
		});
	});

	it("appends recovered calls after structured tool calls", () => {
		const recovered = recoverInlineToolCallTokens(
			result(
				'<|tool_call_begin|>functions.second:0<|tool_call_argument_begin|>{"n":2}<|tool_call_end|>',
				[{ id: "call_0_first", name: "first", arguments: {} }],
			),
		);
		expect(recovered.toolCalls.map((tc) => tc.name)).toEqual([
			"first",
			"second",
		]);
		expect(recovered.toolCalls[1]?.id).toBe("call_1_second");
	});

	it("tolerates unparseable arguments with an empty object", () => {
		const recovered = recoverInlineToolCallTokens(
			result(
				"<|tool_call_begin|>functions.broken:0<|tool_call_argument_begin|>not-json<|tool_call_end|>",
			),
		);
		expect(recovered.toolCalls).toEqual([
			{ id: "call_0_broken", name: "broken", arguments: {} },
		]);
		expect(recovered.text).toBe("");
	});
});

// ── bare-JSON tool-call recovery (the union; tedi's copy was ahead) ──────────

describe("recoverBareJsonToolCallText", () => {
	it("recovers a parseable bare-JSON tool call emitted as text", () => {
		const recovered = recoverBareJsonToolCallText(
			result('{"name": "tedix_mcp_code", "parameters": {"code": "1+1"}}'),
		);
		expect(recovered.text).toBe("");
		expect(recovered.toolCalls).toEqual([
			{
				id: "call_0_tedix_mcp_code",
				name: "tedix_mcp_code",
				arguments: { code: "1+1" },
			},
		]);
	});

	it("accepts the `arguments` key variant", () => {
		expect(
			recoverBareJsonToolCallText(
				result('{"name": "list_skills", "arguments": {}}'),
			).toolCalls.map((tc) => tc.name),
		).toEqual(["list_skills"]);
	});

	it('accepts the "tool"/"args" variant the kernel copy used to miss', () => {
		const recovered = recoverBareJsonToolCallText(
			result(
				'{"tool": "artifact_write_file", "args": {"path": "automation/state/x.json", "content": "{}"}}',
			),
		);
		expect(recovered.text).toBe("");
		expect(recovered.toolCalls).toEqual([
			{
				id: "call_0_artifact_write_file",
				name: "artifact_write_file",
				arguments: { path: "automation/state/x.json", content: "{}" },
			},
		]);
	});

	it("accepts the `input` key variant", () => {
		expect(
			recoverBareJsonToolCallText(
				result('{"tool": "get_skill", "input": {"slug": "x"}}'),
			).toolCalls[0]?.arguments,
		).toEqual({ slug: "x" });
	});

	it("recovers a markdown-fenced bare call", () => {
		expect(
			recoverBareJsonToolCallText(
				result('```json\n{"tool": "list_skills", "args": {}}\n```'),
			).toolCalls.map((tc) => tc.name),
		).toEqual(["list_skills"]);
	});

	it("strips a truncated attempted call to empty text", () => {
		const recovered = recoverBareJsonToolCallText(
			result('{"name": "tedix_mcp_code", "parameters": {"code": "async fu'),
		);
		expect(recovered.text).toBe("");
		expect(recovered.toolCalls).toEqual([]);
	});

	it("passes prose and non-tool-shaped JSON through untouched", () => {
		const prose = result("The weekly total is 4 invoices.");
		expect(recoverBareJsonToolCallText(prose)).toBe(prose);
		const dataJson = result('{"invoices": [], "total": 0}');
		expect(recoverBareJsonToolCallText(dataJson)).toBe(dataJson);
	});

	it("leaves a result that already has structured tool calls alone", () => {
		const withCalls = result('{"name": "x", "parameters": {}}', [
			{ id: "call_0_real", name: "real", arguments: {} },
		]);
		expect(recoverBareJsonToolCallText(withCalls)).toBe(withCalls);
	});

	it("is applied by callWorkersAi ONLY when the request offered tools", async () => {
		const env = {
			AI_GATEWAY_ACCOUNT_ID: "account",
			AI_GATEWAY_LLM_ID: "gateway",
			AI: {
				run: async () => ({
					response: '{"tool": "list_skills", "args": {}}',
				}),
			} as unknown as Ai,
		};
		const withoutTools = await callWorkersAi(
			{ env, authorize: passthrough },
			"@cf/test",
			{ messages: [] },
		);
		expect(withoutTools.toolCalls).toEqual([]);
		expect(withoutTools.text).toBe('{"tool": "list_skills", "args": {}}');

		const withTools = await callWorkersAi(
			{ env, authorize: passthrough },
			"@cf/test",
			{
				messages: [],
				tools: [{ type: "function" }],
			},
		);
		expect(withTools.toolCalls.map((tc) => tc.name)).toEqual(["list_skills"]);
		expect(withTools.text).toBe("");
	});
});

describe("lossless large requests", () => {
	for (const path of ["binding", "gateway-binding", "https"] as const) {
		it(`${path}: authorizes and dispatches the whole request above 90 KB`, async () => {
			const run = vi.fn(async () => ({ response: "ok" }));
			const dispatch = vi.fn(async () => chatResponse("ok"));
			globalThis.fetch = dispatch;
			const authorize = vi.fn(async () => ({}));
			const env: WorkersAiTransportEnv =
				path === "https"
					? GATEWAY_ENV
					: {
							AI_GATEWAY_ACCOUNT_ID: "account",
							AI_GATEWAY_LLM_ID: "gateway",
							...(path === "gateway-binding" ? BINDING_GATEWAY_ENV : {}),
							AI: { run, fetch: dispatch } as unknown as Ai,
						};
			const req = {
				messages: [
					{ role: "system", content: "authority".repeat(12_000) },
					{ role: "user", content: "源".repeat(40_000) },
				],
				tools: [
					{
						type: "function",
						function: {
							name: "exec",
							description: "schema".repeat(20_000),
							parameters: { type: "object" },
						},
					},
				],
				tool_choice: "auto",
				max_tokens: 100,
				temperature: 0.3,
				response_format: { type: "json_object" },
			};
			const before = structuredClone(req);
			await callWorkersAi({ env, authorize }, "@cf/fixture", req);
			const sent =
				path === "binding"
					? JSON.stringify(run.mock.calls[0]?.[1])
					: ((dispatch.mock.calls[0]![1] as RequestInit).body as string);
			expect(new TextEncoder().encode(sent).byteLength).toBeGreaterThan(90_000);
			expect(authorize.mock.calls[0]?.[0].body).toBe(sent);
			expect(JSON.parse(sent).messages).toEqual(req.messages);
			expect(JSON.parse(sent).tools).toEqual(req.tools);
			expect(req).toEqual(before);
		});
	}
});

it("forced AI.run binding forwards only authorizer-issued attribution", async () => {
	const issued = {
		orgId: "org",
		attribution: JSON.stringify({
			v: 3,
			r: "run",
			w: "work",
			e: "issued-execution",
			b: "issued-reservation",
		}),
	};
	const run = vi.fn(async () => ({ response: "ok" }));
	const authorize = vi.fn(async () => ({ attribution: issued }));
	await callWorkersAi(
		{
			env: {
				AI_GATEWAY_ACCOUNT_ID: "account",
				AI_GATEWAY_LLM_ID: "gateway",
				AI: { run } as unknown as Ai,
			},
			authorize,
		},
		"@cf/test",
		{
			messages: [{ role: "user", content: "offline fixture" }],
			attribution: { orgId: "forged", attribution: "caller-value" },
		},
	);
	expect(authorize).toHaveBeenCalledWith(
		expect.objectContaining({
			execution: expect.objectContaining({
				transportKind: "workers-ai-binding",
				gatewayAccountId: "account",
				requestModel: "@cf/test",
			}),
		}),
	);
	expect(run.mock.calls[0]?.[2]).toEqual(
		expect.objectContaining({
			gateway: expect.objectContaining({ metadata: issued }),
		}),
	);
});

describe("reasoning and detailed usage", () => {
	it("preserves gateway reasoning separately from prose and token totals", async () => {
		globalThis.fetch = vi.fn(async () =>
			okJson({
				choices: [
					{ message: { content: "answer", reasoning_content: "analysis" } },
				],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 8,
					completion_tokens_details: { reasoning_tokens: 5 },
					prompt_tokens_details: { cached_tokens: 0 },
				},
			}),
		);
		const out = await callWorkersAi(
			{ env: GATEWAY_ENV, authorize: passthrough },
			"@cf/test",
			{ messages: [] },
		);
		expect(out.text).toBe("answer");
		expect(out.reasoning).toBe("analysis");
		expect(out.usage).toEqual({
			promptTokens: 10,
			completionTokens: 8,
			reasoningTokens: 5,
			cachedInputTokens: 0,
		});
	});

	it.each([
		{ response: "answer", reasoning: "analysis" },
		{
			choices: [
				{ message: { content: "answer", reasoning_content: "analysis" } },
			],
		},
	])(
		"preserves reasoning in either binding response shape",
		async (response) => {
			const out = await callWorkersAi(
				{
					env: {
						AI_GATEWAY_ACCOUNT_ID: "account",
						AI_GATEWAY_LLM_ID: "gateway",
						AI: {
							run: async () => ({
								...response,
								usage: {
									prompt_tokens: 2,
									completion_tokens: 6,
									completion_tokens_details: { reasoning_tokens: 4 },
								},
							}),
						} as unknown as Ai,
					},
					authorize: passthrough,
				},
				"@cf/test",
				{ messages: [] },
			);
			expect(out.text).toBe("answer");
			expect(out.reasoning).toBe("analysis");
			expect(out.usage.reasoningTokens).toBe(4);
		},
	);
});

describe("cancellation before billable dispatch", () => {
	it.each([false, true])(
		"does not authorize or dispatch an already-aborted call (gateway %s)",
		async (gateway) => {
			const controller = new AbortController();
			controller.abort(new Error("cancelled before admission"));
			const run = vi.fn();
			const authorize = vi.fn(passthrough);
			const fetch = vi.fn();
			globalThis.fetch = fetch;
			await expect(
				callWorkersAi(
					{
						env: gateway
							? GATEWAY_ENV
							: {
									AI_GATEWAY_ACCOUNT_ID: "account",
									AI_GATEWAY_LLM_ID: "gateway",
									AI: { run } as unknown as Ai,
								},
						authorize,
					},
					"@cf/test",
					{ messages: [], signal: controller.signal },
				),
			).rejects.toThrow("cancelled before admission");
			expect(authorize).not.toHaveBeenCalled();
			expect(run).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it.each([false, true])(
		"does not dispatch after admission is cancelled (gateway %s)",
		async (gateway) => {
			const controller = new AbortController();
			const run = vi.fn();
			const fetch = vi.fn();
			globalThis.fetch = fetch;
			await expect(
				callWorkersAi(
					{
						env: gateway
							? GATEWAY_ENV
							: {
									AI_GATEWAY_ACCOUNT_ID: "account",
									AI_GATEWAY_LLM_ID: "gateway",
									AI: { run } as unknown as Ai,
								},
						authorize: async () => {
							controller.abort(new Error("cancelled during admission"));
							return {};
						},
					},
					"@cf/test",
					{ messages: [], signal: controller.signal },
				),
			).rejects.toThrow("cancelled during admission");
			expect(run).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it.each(["success", "failure", "abort"])(
		"removes a binding abort listener after %s",
		async (outcome) => {
			const controller = new AbortController();
			const add = vi.spyOn(controller.signal, "addEventListener");
			const remove = vi.spyOn(controller.signal, "removeEventListener");
			const run = vi.fn(async () => {
				if (outcome === "failure") throw new Error("binding failed");
				if (outcome === "abort") {
					controller.abort(new Error("turn cancelled"));
					return await new Promise<never>(() => {});
				}
				return { response: "done" };
			});
			const call = callWorkersAi(
				{
					env: {
						AI_GATEWAY_ACCOUNT_ID: "account",
						AI_GATEWAY_LLM_ID: "gateway",
						AI: { run } as unknown as Ai,
					},
					authorize: passthrough,
				},
				"@cf/test",
				{ messages: [], signal: controller.signal },
			);
			if (outcome === "success") expect((await call).text).toBe("done");
			else
				await expect(call).rejects.toThrow(
					outcome === "failure" ? "binding failed" : "turn cancelled",
				);
			expect(add).toHaveBeenCalledTimes(1);
			expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
		},
	);
});

describe("private wire authority", () => {
	it.each(["https", "gateway-binding", "ai-run"] as const)(
		"%s checks authority after delayed authorization and on each later invocation",
		async (route) => {
			const send = vi.fn(async () =>
				route === "ai-run"
					? { response: "ok" }
					: new Response(
							JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
						),
			);
			globalThis.fetch = send as typeof fetch;
			const env: WorkersAiTransportEnv =
				route === "https"
					? GATEWAY_ENV
					: route === "gateway-binding"
						? { ...BINDING_GATEWAY_ENV, AI: { fetch: send } as unknown as Ai }
						: {
								AI_GATEWAY_ACCOUNT_ID: "account",
								AI_GATEWAY_LLM_ID: "gateway",
								AI: { run: send } as unknown as Ai,
							};
			let release!: () => void,
				active = true;
			const admitted = new Promise<void>((resolve) => {
				release = resolve;
			});
			const authorize = vi.fn(async () => {
				await admitted;
				return { attribution: { reservation: "original-unresolved" } };
			});
			const beforeDispatch = vi.fn(() => {
				if (!active) throw new Error("held");
			});
			const client = { env, authorize, beforeDispatch };
			const pending = callWorkersAi(client, "@cf/test", { messages: [] });
			expect(authorize).toHaveBeenCalledTimes(1);
			expect(send).not.toHaveBeenCalled();
			active = false;
			release();
			await expect(pending).rejects.toMatchObject({
				name: "ProviderDispatchGuardError",
				phase: "before_dispatch",
				providerRequestSent: false,
			});
			expect(send).not.toHaveBeenCalled();
			active = true;
			expect(
				(await callWorkersAi(client, "@cf/test", { messages: [] })).text,
			).toBe("ok");
			expect(send).toHaveBeenCalledTimes(1);
			active = false;
			await expect(
				callWorkersAi(client, "@cf/test", { messages: [] }),
			).rejects.toMatchObject({ phase: "before_dispatch" });
			expect(send).toHaveBeenCalledTimes(1);
			expect(beforeDispatch).toHaveBeenCalledTimes(3);
		},
	);
	it.each(["https", "gateway-binding", "ai-run"] as const)(
		"%s rejects an async guard without sending",
		async (route) => {
			const send = vi.fn();
			globalThis.fetch = send;
			const env: WorkersAiTransportEnv =
				route === "https"
					? GATEWAY_ENV
					: route === "gateway-binding"
						? { ...BINDING_GATEWAY_ENV, AI: { fetch: send } as unknown as Ai }
						: {
								AI_GATEWAY_ACCOUNT_ID: "account",
								AI_GATEWAY_LLM_ID: "gateway",
								AI: { run: send } as unknown as Ai,
							};
			await expect(
				callWorkersAi(
					{
						env,
						authorize: passthrough,
						beforeDispatch: async () => {
							throw new Error("invalid async guard");
						},
					},
					"@cf/test",
					{ messages: [] },
				),
			).rejects.toMatchObject({
				name: "ProviderDispatchGuardError",
				providerRequestSent: false,
			});
			expect(send).not.toHaveBeenCalled();
		},
	);
});

describe("request-local authorization envelopes", () => {
	const routes = ["https", "gateway-binding", "ai-run"] as const;
	function fixture(route: (typeof routes)[number]) {
		const sent: Array<Record<string, string> | undefined> = [];
		const send = vi.fn(
			async (
				_input: unknown,
				init: unknown,
				options?: { gateway?: { metadata?: Record<string, string> } },
			) => {
				sent.push(
					route === "ai-run"
						? options?.gateway?.metadata
						: JSON.parse(
								new Headers((init as RequestInit).headers).get(
									"cf-aig-metadata",
								) ?? "null",
							),
				);
				return route === "ai-run"
					? { response: "ok" }
					: okJson({ choices: [{ message: { content: "ok" } }] });
			},
		);
		globalThis.fetch = send as typeof fetch;
		const env: WorkersAiTransportEnv =
			route === "https"
				? GATEWAY_ENV
				: route === "gateway-binding"
					? { ...BINDING_GATEWAY_ENV, AI: { fetch: send } as unknown as Ai }
					: {
							AI_GATEWAY_ACCOUNT_ID: "a",
							AI_GATEWAY_LLM_ID: "g",
							AI: { run: send } as unknown as Ai,
						};
		return { env, send, sent };
	}
	it.each(routes)(
		"%s keeps concurrent receipt guards and attribution isolated",
		async (route) => {
			const { env, send, sent } = fixture(route);
			const releases = new Map<string, () => void>();
			const checks: string[] = [];
			const authorize: WorkersAiAuthorize = async ({ attribution }) => {
				const id = attribution!.id!;
				await new Promise<void>((resolve) => releases.set(id, resolve));
				return {
					attribution: { issued: id },
					beforeDispatch: () => {
						checks.push(id);
						if (id === "denied") throw new Error("own receipt denied");
					},
				};
			};
			const beforeDispatch = vi.fn(() => {});
			const client = { env, authorize, beforeDispatch };
			const denied = callWorkersAi(client, "@cf/test", {
				messages: [],
				attribution: { id: "denied" },
			}).catch((error: unknown) => error);
			const allowed = callWorkersAi(client, "@cf/test", {
				messages: [],
				attribution: { id: "allowed" },
			});
			releases.get("allowed")!();
			await allowed;
			releases.get("denied")!();
			expect(await denied).toMatchObject({
				name: "ProviderDispatchGuardError",
				providerRequestSent: false,
			});
			expect(checks).toEqual(["allowed", "denied"]);
			expect(beforeDispatch).toHaveBeenCalledTimes(2);
			expect(send).toHaveBeenCalledOnce();
			expect(sent).toEqual([{ issued: "allowed" }]);
		},
	);
	for (const failure of [
		"during-billing",
		"client-aborts",
		"own-aborts",
		"async-own",
	] as const) {
		it.each(routes)(`%s sends nothing when ${failure}`, async (route) => {
			const { env, send } = fixture(route);
			const controller = new AbortController();
			let release!: () => void;
			const billing = new Promise<void>((resolve) => {
				release = resolve;
			});
			const own = vi.fn(() => {
				if (failure === "own-aborts") controller.abort(new Error("own abort"));
			});
			const authorize: WorkersAiAuthorize = async () => {
				await billing;
				return {
					attribution: { issued: "unknown-original" },
					signal: controller.signal,
					beforeDispatch: failure === "async-own" ? async () => {} : own,
				};
			};
			const clientGuard = vi.fn(() => {
				if (failure === "client-aborts")
					controller.abort(new Error("client abort"));
			});
			const pending = callWorkersAi(
				{ env, authorize, beforeDispatch: clientGuard },
				"@cf/test",
				{ messages: [] },
			).catch((error: unknown) => error);
			if (failure === "during-billing")
				controller.abort(new Error("billing abort"));
			release();
			const error = await pending;
			expect(error).toBeInstanceOf(Error);
			if (failure !== "during-billing")
				expect(error).toMatchObject({
					name: "ProviderDispatchGuardError",
					providerRequestSent: false,
				});
			expect(send).not.toHaveBeenCalled();
			if (failure !== "during-billing")
				expect(clientGuard).toHaveBeenCalledOnce();
		});
	}
	it.each(["caller", "receipt"] as const)(
		"binding %s abort stops only the wait for an already-dispatched call",
		async (source) => {
			const controller = new AbortController();
			const caller = new AbortController();
			let complete!: (value: { response: string }) => void;
			const provider = new Promise<{ response: string }>((resolve) => {
				complete = resolve;
			});
			let enter!: () => void;
			const entered = new Promise<void>((resolve) => {
				enter = resolve;
			});
			const run = vi.fn(() => {
				enter();
				return provider;
			});
			const pending = callWorkersAi(
				{
					env: {
						AI_GATEWAY_ACCOUNT_ID: "a",
						AI_GATEWAY_LLM_ID: "g",
						AI: { run } as unknown as Ai,
					},
					authorize: async () => ({ signal: controller.signal }),
				},
				"@cf/test",
				{ messages: [], signal: caller.signal },
			).catch((error: unknown) => error);
			await Promise.race([
				entered,
				pending.then((error) => {
					throw error;
				}),
			]);
			expect(run).toHaveBeenCalledOnce();
			(source === "receipt" ? controller : caller).abort(
				new Error("stop waiting"),
			);
			expect(await pending).toMatchObject({ message: "stop waiting" });
			complete({ response: "provider continued" });
			expect(await provider).toEqual({ response: "provider continued" });
		},
	);
});

describe("authorization signal reaches the original gateway fetch", () => {
	it.each(["https", "gateway-binding"] as const)(
		"%s combines caller and receipt cancellation",
		async (route) => {
			const caller = new AbortController(),
				receipt = new AbortController();
			let wireSignal: AbortSignal | undefined;
			const send = vi.fn(async (_url: unknown, init: RequestInit) => {
				wireSignal = init.signal ?? undefined;
				expect(wireSignal).toBeInstanceOf(AbortSignal);
				expect(wireSignal).not.toBe(caller.signal);
				expect(wireSignal).not.toBe(receipt.signal);
				return okJson({ choices: [{ message: { content: "ok" } }] });
			});
			globalThis.fetch = send as typeof fetch;
			const own = vi.fn(() => {}),
				existing = vi.fn(() => {});
			const env: WorkersAiTransportEnv =
				route === "https"
					? GATEWAY_ENV
					: { ...BINDING_GATEWAY_ENV, AI: { fetch: send } as unknown as Ai };
			await callWorkersAi(
				{
					env,
					beforeDispatch: existing,
					authorize: async () => ({
						signal: receipt.signal,
						beforeDispatch: own,
					}),
				},
				"@cf/test",
				{ messages: [], signal: caller.signal },
			);
			expect(send).toHaveBeenCalledOnce();
			expect(existing).toHaveBeenCalledOnce();
			expect(own).toHaveBeenCalledOnce();
			// Cancelling the caller still propagates; no claim about completed provider work.
			caller.abort(new Error("caller cancelled"));
			expect(wireSignal!.aborted).toBe(true);
			expect(wireSignal!.reason).toBe(caller.signal.reason);
		},
	);
});

describe("request cancellation at authorization", () => {
	it.each(["run", "binding", "https"] as const)(
		"%s forwards the exact signal and denies serialization cancellation before admission",
		async (route) => {
			const controller = new AbortController();
			const send = vi.fn();
			globalThis.fetch = send;
			const env = {
				AI_GATEWAY_ACCOUNT_ID: "account",
				AI_GATEWAY_LLM_ID: "gateway",
				AI: { fetch: send, run: send },
				...(route === "https"
					? { CF_AI_GATEWAY_TOKEN: "token", CF_WORKERS_AI_TOKEN: "token" }
					: {}),
				...(route === "binding"
					? { AI_GATEWAY_BINDING_PROVIDERS: "workers-ai" }
					: {}),
			} as unknown as WorkersAiTransportEnv;
			const authorize = vi.fn(
				async (input: Parameters<WorkersAiAuthorize>[0]) => {
					expect(input.signal).toBe(controller.signal);
					throw new Error("stopped at authorization");
				},
			);
			await expect(
				callWorkersAi({ env, authorize }, "@cf/test", {
					messages: [],
					signal: controller.signal,
				}),
			).rejects.toThrow("stopped at authorization");
			expect(authorize).toHaveBeenCalledOnce();
			authorize.mockClear();
			const request = { messages: [] as unknown[], signal: controller.signal };
			const message = {
				toJSON() {
					controller.abort(new Error("cancelled during serialization"));
					request.signal = new AbortController().signal;
					return { role: "user", content: "test" };
				},
			};
			request.messages = [message];
			await expect(
				callWorkersAi({ env, authorize }, "@cf/test", request),
			).rejects.toThrow("cancelled during serialization");
			expect(authorize).not.toHaveBeenCalled();
			expect(send).not.toHaveBeenCalled();
		},
	);
});
