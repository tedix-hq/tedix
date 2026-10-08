import { privateInferenceOriginGuard } from "./runtime-inference-origin";
import assert from "node:assert/strict";
import { observerCompletion } from "./observer-llm";

const controller = new AbortController();
let fallbackCalls = 0;
const options = {
	modelRef: "workers-ai/@cf/openai/gpt-oss-120b",
	env: {
		AI: {
			run: async () => {
				fallbackCalls++;
				return { response: "{}" };
			},
		},
	},
	messages: [{ role: "user", content: "Remember my lasting preference." }],
	signal: controller.signal,
};
controller.abort(new Error("learning deadline"));
await assert.rejects(observerCompletion(options as never), /learning deadline/);
assert.equal(
	fallbackCalls,
	0,
	"expired turns never call even a forced fallback provider",
);

const duringAdmission = new AbortController();
await assert.rejects(
	observerCompletion({
		modelRef: "azure-openai/gpt-5.6-terra",
		env: {
			AZURE_OPENAI_RESOURCE: "fixture",
			AZURE_OPENAI_API_VERSION: "2025-01-01",
			AZURE_OBSERVER_DEPLOYMENT: "fixture-model",
			AI_GATEWAY_ACCOUNT_ID: "fixture-account",
			AI_GATEWAY_LLM_ID: "fixture-gateway",
			CF_AI_GATEWAY_TOKEN: "fixture-token",
			SECRETS_MASTER_KEY: "fixture-signing-secret",
			TEDIX_BILLING_SETTLEMENT_MODE: "managed",
			AI: {
				run: async () => {
					fallbackCalls++;
					return { response: "{}" };
				},
			},
			API_SERVICE: {
				fetch: async () => {
					duringAdmission.abort(new Error("learning deadline during request"));
					throw new Error("transport interrupted");
				},
			},
		},
		beforeDispatch: privateCapturedGuard(() => {}, "fixture-org"),
		metadata: {
			orgId: "fixture-org",
			tediId: "fixture-tedi",
			source: "observer:post-turn",
		},
		messages: [{ role: "user", content: "Remember my lasting preference." }],
		signal: duringAdmission.signal,
	} as never),
	/learning deadline during request/,
);
assert.equal(
	fallbackCalls,
	0,
	"cancellation does not become provider failover",
);
console.log("PASS: observer cancellation never starts provider fallback");

const originalFetch = globalThis.fetch;
let azureCalls = 0;
let azureBody = "";
try {
	globalThis.fetch = async (_url, init) => {
		azureCalls++;
		azureBody = String(init?.body ?? "");
		return new Response("provider unavailable", { status: 503 });
	};
	await assert.rejects(
		observerCompletion({
			env: {
				AZURE_OPENAI_RESOURCE: "fixture",
				AZURE_OPENAI_API_VERSION: "test",
				AZURE_OBSERVER_DEPLOYMENT: "fixture",
				AI_GATEWAY_ACCOUNT_ID: "account",
				AI_GATEWAY_LLM_ID: "gateway",
				CF_AI_GATEWAY_TOKEN: "token",
				AI: options.env.AI,
				SECRETS_MASTER_KEY: "fixture-signing-secret",
				TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
				API_SERVICE: {
					fetch: async () =>
						Response.json({
							json: {
								allowed: true,
								settlementMode: "disabled",
								attributionVersion: 3,
								executionId: "12345678-1234-4123-8123-123456789abc",
								sendBefore: "2099-01-01T00:00:00.000Z",
								reservationId: null,
								expiresAt: null,
								estimatedChargeMicros: null,
							},
						}),
				},
			},
			beforeDispatch: privateCapturedGuard(() => {}, "fixture"),
			metadata: { orgId: "fixture", tediId: "fixture-tedi" },
			messages: [{ role: "user", content: "source" }],
		} as never),
		/503/,
	);
	assert.ok(azureCalls > 0);
	assert.match(
		azureBody,
		/Respond with a single JSON object/,
		"json_object mode always names JSON, or Azure returns 400",
	);
	assert.equal(
		fallbackCalls,
		0,
		"provider errors never switch to an unselected provider",
	);
} finally {
	globalThis.fetch = originalFetch;
}
console.log("PASS: provider errors propagate without fallback");

const wireGuardAdmission = () =>
	Response.json({
		json: {
			allowed: true,
			settlementMode: "disabled",
			attributionVersion: 3,
			executionId: "12345678-1234-4123-8123-123456789abc",
			sendBefore: "2099-01-01T00:00:00.000Z",
			reservationId: null,
			expiresAt: null,
			estimatedChargeMicros: null,
		},
	});

function privateCapturedGuard(recheck: () => void, orgId = "org"): () => void {
	const owner = {
		orgId,
		tediId: "fixture-tedi",
		objectId: "a".repeat(64),
	};
	return privateInferenceOriginGuard(
		{
			kind: "unselected_native",
			root: {
				owner,
				objectName: "fixture-root",
				className: "AgentTediDO",
				path: [],
				generation: 0,
			},
			selected: {
				owner,
				className: "AgentTediDO",
				identityName: "fixture-root",
				facetName: null,
				path: [],
				generation: 0,
			},
			configurationHash: "b".repeat(64),
		},
		recheck,
	);
}
// Real adapter and service-bound billing, with no provider or financial writes.
for (const route of [
	"azure-https",
	"azure-binding",
	"workers-run",
	"workers-https",
	"workers-binding",
	"auto",
] as const) {
	const savedFetch = globalThis.fetch;
	let sends = 0,
		admissions = 0,
		active = true,
		release!: () => void,
		entered!: () => void;
	const barrier = new Promise<void>((r) => {
		release = r;
	});
	const started = new Promise<void>((r) => {
		entered = r;
	});
	const wire = async (_input?: unknown, init?: RequestInit) => {
		sends++;
		assert.ok(!JSON.stringify(init).includes("beforeDispatch"));
		throw new Error("controlled-wire-reached");
	};
	const env = {
		AZURE_OPENAI_RESOURCE: "fixture",
		AZURE_OPENAI_API_VERSION: "test",
		AZURE_CHAT_DEPLOYMENT: "gpt-5.6-terra",
		AZURE_OBSERVER_DEPLOYMENT: "gpt-5.6-terra",
		AI_GATEWAY_ACCOUNT_ID: "account",
		AI_GATEWAY_LLM_ID: "gateway",
		SECRETS_MASTER_KEY: "fixture-signing-secret",
		TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
		...(route !== "workers-run"
			? { CF_AI_GATEWAY_TOKEN: "token", CF_WORKERS_AI_TOKEN: "token" }
			: {}),
		...(route.endsWith("binding")
			? {
					AI_GATEWAY_BINDING_PROVIDERS: route.startsWith("azure")
						? "azure-openai"
						: "workers-ai",
				}
			: {}),
		AI: { fetch: wire, run: wire },
		API_SERVICE: {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const body = await new Request(input, init).text();
				assert.ok(!body.includes("beforeDispatch"));
				admissions++;
				entered();
				await barrier;
				return wireGuardAdmission();
			},
		},
	};
	globalThis.fetch = wire;
	const guard = () => {
		if (!active) throw new Error("revoked");
	};
	const invoke = async (guard: () => void, signal?: AbortSignal) => {
		return observerCompletion({
			env: env as never,
			modelRef: route.startsWith("workers")
				? "workers-ai/@cf/openai/gpt-oss-120b"
				: route === "auto"
					? "cloudflare/auto"
					: "azure-openai/gpt-5.6-terra",
			metadata: { orgId: "org", tediId: "fixture-tedi" },
			messages: [{ role: "user", content: "fixture" }],
			beforeDispatch: guard,
			signal,
		});
	};
	try {
		const pending = invoke(privateCapturedGuard(guard));
		await started;
		assert.equal(sends, 0);
		active = false;
		release();
		await assert.rejects(pending, {
			name: "ProviderDispatchGuardError",
			phase: "before_dispatch",
			providerRequestSent: false,
		});
		assert.equal(sends, 0);
		active = true;
		await assert.rejects(
			invoke(privateCapturedGuard(guard)),
			/controlled-wire-reached/,
		);
		assert.equal(sends, 1, route + " positive adapter reaches selected wire");
		active = false;
		await assert.rejects(invoke(privateCapturedGuard(guard)), {
			phase: "before_dispatch",
		});
		assert.equal(sends, 1);
		await assert.rejects(invoke(privateCapturedGuard(async () => {})), {
			phase: "before_dispatch",
		});
		assert.equal(sends, 1);
		const cancelled = new AbortController();
		env.API_SERVICE.fetch = async () => {
			admissions++;
			cancelled.abort(new Error("cancelled-after-billing"));
			return wireGuardAdmission();
		};
		active = true;
		await assert.rejects(invoke(privateCapturedGuard(guard), cancelled.signal));
		assert.equal(
			sends,
			1,
			route + " successful billing does not bypass cancellation",
		);
		assert.ok(admissions >= 3);
		// A future API receipt cannot extend the original capture, even through Auto Router.
		const originalNow = Date.now,
			time = originalNow();
		Date.now = () => time;
		const expiredGuard = privateCapturedGuard(guard);
		env.API_SERVICE.fetch = async () => {
			admissions++;
			Date.now = () => time + 600_001;
			return wireGuardAdmission();
		};
		try {
			await assert.rejects(invoke(expiredGuard), { phase: "before_dispatch" });
			assert.equal(sends, 1);
		} finally {
			Date.now = originalNow;
		}
	} finally {
		globalThis.fetch = savedFetch;
	}
}
console.log("PASS: selected adapter private wire authority");

// No model ref (the observer policy's "unset", including a resolved
// `cloudflare/auto`) runs the env default Azure deployment, never the Auto Router.
{
	const savedFetch = globalThis.fetch;
	const urls: string[] = [];
	let workersCalls = 0;
	try {
		globalThis.fetch = async (input: RequestInfo | URL) => {
			urls.push(String(input instanceof Request ? input.url : input));
			return Response.json({
				choices: [{ message: { content: '{"observations":[]}' } }],
			});
		};
		const result = await observerCompletion({
			modelRef: null,
			env: {
				AZURE_OPENAI_RESOURCE: "fixture",
				AZURE_OPENAI_API_VERSION: "test",
				AZURE_OBSERVER_DEPLOYMENT: "fixture-observer-default",
				AI_GATEWAY_ACCOUNT_ID: "account",
				AI_GATEWAY_LLM_ID: "gateway",
				CF_AI_GATEWAY_TOKEN: "token",
				SECRETS_MASTER_KEY: "fixture-signing-secret",
				TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
				AI: {
					run: async () => {
						workersCalls++;
						return { response: "{}" };
					},
					fetch: async () => {
						workersCalls++;
						return Response.json({});
					},
				},
				API_SERVICE: { fetch: async () => wireGuardAdmission() },
			},
			beforeDispatch: privateCapturedGuard(() => {}, "fixture"),
			metadata: { orgId: "fixture", tediId: "fixture-tedi" },
			messages: [{ role: "user", content: "source" }],
		} as never);
		assert.equal(result, '{"observations":[]}');
		assert.equal(workersCalls, 0, "no Workers AI / Auto Router call");
		assert.ok(
			urls.some((url) => url.includes("fixture-observer-default")),
			`Azure env default deployment was called: ${urls.join(", ")}`,
		);
	} finally {
		globalThis.fetch = savedFetch;
	}
}
console.log("PASS: unset observer model uses the Azure env default deployment");
