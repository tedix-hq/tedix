/** Inject faults at the real Azure gateway fetch boundary. Explicit provider
 * selection stays fixed across failures, bounded retries, stream cuts and recovery. */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type { KernelContext } from "../rpc/routers/kernel/context-assembly";
import { type KernelEnv, kernelModel } from "../rpc/routers/kernel/llm";
import { planKernelRoute } from "../rpc/routers/kernel/route-planner";
import type { KernelRouteDecision } from "../rpc/routers/kernel/route-schema";

vi.mock(
	"../rpc/routers/kernel/billing-reservation",
	async (importOriginal) => ({
		// Keep the REAL billingPolicyDenialCode classifier: the planner consults it
		// in every catch to distinguish deterministic billing denials from the
		// provider faults this suite injects — stubbing it would blind that seam.
		...(await importOriginal<
			typeof import("../rpc/routers/kernel/billing-reservation")
		>()),
		reserveKernelBilling: async (
			_env: unknown,
			input: { context?: string | Record<string, unknown> },
		) => ({
			...(typeof input.context === "string"
				? { organizationId: input.context }
				: (input.context ?? {})),
			billingReservationId: "reservation-test",
		}),
	}),
);

const EMPTY_CONTEXT: KernelContext = {
	tedis: [],
	apps: [],
	workflows: [],
	workItems: [],
	facts: [],
	rationale: [],
	speaker: null,
	history: [],
};

/** Distinct answers so result provenance (fallback vs Azure) is content-provable. */
const FALLBACK_DECISION: KernelRouteDecision = {
	routeKind: "answer_in_home",
	rationale: "covered by the Workers AI fallback while Azure is down",
	risk: "low",
	confidence: 0.8,
	effortClass: "single_read",
	answer: "Covered by the Workers AI fallback.",
	targetTediId: null,
	targetTediLabel: null,
	targetActivityId: null,
	plannedToolIds: [],
	toolIntent: null,
	workflowHint: null,
	clarifyingQuestion: null,
	evidenceExpectation: null,
};

const AZURE_DECISION: KernelRouteDecision = {
	routeKind: "answer_in_home",
	rationale: "served by the primary Azure provider",
	risk: "low",
	confidence: 0.9,
	effortClass: "single_read",
	answer: "Served by Azure.",
	targetTediId: null,
	targetTediLabel: null,
	targetActivityId: null,
	plannedToolIds: [],
	toolIntent: null,
	workflowHint: null,
	clarifyingQuestion: null,
	evidenceExpectation: null,
};

const AZURE_DEPLOYMENT = "gpt-5-kernel";
// The gateway rewrite of the SDK-built Azure URL — asserting it on the spy
// proves the counted fetches ARE the Azure request (not some other traffic).
const AZURE_GATEWAY_URL_MARKER = `/azure-openai/kernel-test-resource/openai/v1/responses`;

/**
 * Full Azure config (authenticated AI Gateway BYOK) + the token-free `env.AI`
 * binding as the fallback. CF_WORKERS_AI_TOKEN is deliberately
 * ABSENT so the Workers AI transport uses the binding (`run`) — zero fetches.
 */
function azureEnv(run: (...args: unknown[]) => Promise<unknown>): KernelEnv {
	return {
		AZURE_OPENAI_RESOURCE: "kernel-test-resource",
		AZURE_CHAT_DEPLOYMENT: AZURE_DEPLOYMENT,
		KERNEL_MODEL_REF: `azure-openai/${AZURE_DEPLOYMENT}`,
		AI_GATEWAY_ACCOUNT_ID: "acct-test",
		AI_GATEWAY_LLM_ID: "tedix-llm-test",
		CF_AI_GATEWAY_TOKEN: "gw-token",
		AI: { run } as unknown as Ai,
	};
}

/** Binding-shaped fallback success: `callViaBinding` reads `{ response }`. */
function fallbackRun() {
	return vi.fn(async () => ({ response: JSON.stringify(FALLBACK_DECISION) }));
}

/** A fresh Responses success carrying the decision JSON. */
function azureChatSuccess(decision: KernelRouteDecision): Response {
	return new Response(
		JSON.stringify({
			id: "resp-kernel-faults",
			object: "response",
			created_at: 1,
			model: AZURE_DEPLOYMENT,
			status: "completed",
			output: [
				{
					type: "message",
					id: "msg",
					role: "assistant",
					content: [
						{
							type: "output_text",
							text: JSON.stringify(decision),
							annotations: [],
						},
					],
				},
			],
			usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

/**
 * A fresh retryable Azure 500. `retry-after: 0` pins the SDK's single allowed
 * retry (maxRetries: 1) to a 0ms delay — deterministic and instant instead of
 * the 2s exponential-backoff default.
 */
function azure500(): Response {
	return new Response(
		JSON.stringify({
			error: { message: "simulated Azure outage", type: "server_error" },
		}),
		{
			status: 500,
			statusText: "Internal Server Error",
			headers: { "content-type": "application/json", "retry-after": "0" },
		},
	);
}

/**
 * An SSE response cut mid-stream: ONE valid chat chunk carrying a partial
 * JSON prefix, then the body CLOSES early — no more deltas, no finish_reason,
 * no `data: [DONE]`. This is the LB-idle-timeout / upstream-eviction cut
 * shape: the provider's stream flush emits a synthetic finish, the
 * accumulated partial JSON fails object validation, and `result.object`
 * rejects → the planner must fall through to generateObject.
 *
 * (The OTHER cut shape — the body ERRORING instead of closing — never emits a
 * finish chunk, so the SDK's `streamObject.object` promise would stay pending
 * forever; `streamRoutePlan`'s post-stream settle bound converts that into a
 * content failure. Covered by the severed-body test below.)
 */
function azureSseCut(): Response {
	const chunk = JSON.stringify({
		id: "chatcmpl-cut",
		object: "chat.completion.chunk",
		created: 1,
		model: AZURE_DEPLOYMENT,
		choices: [
			{
				index: 0,
				delta: { role: "assistant", content: '{"routeKind":"answer_in' },
				finish_reason: null,
			},
		],
	});
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
			controller.close();
		},
	});
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/**
 * The severed cut shape: one valid partial chunk, then the body ERRORS
 * (connection reset) instead of closing. The SDK routes the error to
 * `onError`, ends the partial stream, and never emits a finish chunk — the
 * shape that used to leave `result.object` pending forever.
 */
function azureSseSevered(): Response {
	const chunk = JSON.stringify({
		id: "chatcmpl-severed",
		object: "chat.completion.chunk",
		created: 1,
		model: AZURE_DEPLOYMENT,
		choices: [
			{
				index: 0,
				delta: { role: "assistant", content: '{"routeKind":"answer_in' },
				finish_reason: null,
			},
		],
	});
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
			controller.error(new Error("connection reset by peer"));
		},
	});
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

// The Azure circuit breaker is MODULE-GLOBAL state: several tests below trip
// it on purpose. Resetting before each test is what makes the suite
// order-independent — and every test whose first plan call asserts an Azure
// fetch happened would FAIL if this reset stopped working, because an earlier
// test's tripped circuit would silently reroute it onto the fallback.
beforeEach(() => {
	// Fault paths log deliberate warnings; keep the suite output clean.
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("planKernelRoute — selected provider faults", () => {
	const select = (env: KernelEnv) => {
		const model = kernelModel(env, {
			modelRef: `azure-openai/${AZURE_DEPLOYMENT}`,
		});
		if (!model) throw new Error("Expected explicit Azure model");
		return model;
	};
	it("network failure propagates and the next turn keeps the explicit provider", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("azure unreachable"));
		const run = fallbackRun();
		const env = azureEnv(run);
		const model = select(env);
		for (const content of ["first", "second"])
			await expect(
				planKernelRoute({ content, context: EMPTY_CONTEXT, model, env }),
			).rejects.toThrow("azure unreachable");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(run).not.toHaveBeenCalled();
		for (const call of fetchSpy.mock.calls)
			expect(String(call[0])).toContain(AZURE_GATEWAY_URL_MARKER);
	});
	it("retryable 500 permits one retry and never switches providers", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => azure500());
		const run = fallbackRun();
		const env = azureEnv(run);
		await expect(
			planKernelRoute({
				content: "status",
				context: EMPTY_CONTEXT,
				model: select(env),
				env,
			}),
		).rejects.toThrow();
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(run).not.toHaveBeenCalled();
	});
	it("recovery needs no circuit reset and retains real token provenance", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValueOnce(new Error("azure unreachable"))
			.mockImplementation(async () => azureChatSuccess(AZURE_DECISION));
		const run = fallbackRun();
		const env = azureEnv(run);
		const model = select(env);
		const plan = () =>
			planKernelRoute({
				content: "status",
				context: EMPTY_CONTEXT,
				model,
				env,
			});
		await expect(plan()).rejects.toThrow("azure unreachable");
		const recovered = await plan();
		expect(recovered?.answer).toBe("Served by Azure.");
		expect(recovered?.usage).toMatchObject({
			provider: "azure-openai",
			inputTokens: 11,
			outputTokens: 7,
		});
		expect(recovered?.routerVersion).toMatch(/^[0-9a-f]{12}$/);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(run).not.toHaveBeenCalled();
	});
	for (const [label, response] of [
		["cut", azureSseCut],
		["severed", azureSseSevered],
	] as const) {
		it(`stream ${label} fails within the settle bound without a second pass`, async () => {
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockImplementation(async () => response());
			const run = fallbackRun();
			const env = azureEnv(run);
			const started = Date.now();
			await expect(
				planKernelRoute({
					content: "status",
					context: EMPTY_CONTEXT,
					model: select(env),
					env,
					onAnswerDelta: () => {},
				}),
			).rejects.toThrow();
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(run).not.toHaveBeenCalled();
			expect(Date.now() - started).toBeLessThan(8000);
		});
	}
});
