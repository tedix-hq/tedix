import { privateInferenceOriginGuard } from "./runtime-inference-origin";
import assert from "node:assert/strict";
import {
	selectChatModelForTurn,
	selectJudgeModelForTurn,
} from "./turn-model-selection";
import type { AzureChatEnv } from "./llm";

const azureEnv: AzureChatEnv = {
	AZURE_OPENAI_API_VERSION: "test",
	AZURE_CHAT_DEPLOYMENT: "default-chat",
	AZURE_OPENAI_RESOURCE: "test-resource",
	AI_GATEWAY_ACCOUNT_ID: "test-account",
	AI_GATEWAY_LLM_ID: "test-gateway",
	CF_AI_GATEWAY_TOKEN: "test-token",
	TEDI_JUDGE_MODEL_REF: "azure-openai/gpt-5.6-terra",
};

const selected = selectJudgeModelForTurn(azureEnv);
assert.deepEqual(
	selected.identity,
	{ provider: "azure-openai", model: "gpt-5.6-terra" },
	"the judge pin must override the ordinary chat selection",
);

const quickChat = selectChatModelForTurn(
	{ ...azureEnv, AI: {} } as AzureChatEnv,
	{
		modelRef: "workers-ai/@cf/openai/gpt-oss-120b",
	},
);
assert.deepEqual(quickChat.identity, {
	provider: "workers-ai",
	model: "@cf/openai/gpt-oss-120b",
});

const fixedFallback = selectChatModelForTurn(azureEnv, {
	modelRef: "cloudflare/auto",
});
assert.deepEqual(
	fixedFallback.identity,
	{ provider: "workers-ai", model: "cloudflare/auto" },
	"authorized Auto selection applies to parent/operator turns without utility classification",
);
const adaptiveCron = selectChatModelForTurn(
	azureEnv,
	{ modelRef: "cloudflare/auto" },
	{ orgId: "org", source: "cron:objective-review" },
	undefined,
	{
		surface: "cron",
		authority: "ordinary",
		reproducibility: "adaptive",
		sovereignty: "unconstrained",
	},
);
assert.deepEqual(adaptiveCron.identity, {
	provider: "workers-ai",
	model: "cloudflare/auto",
});
assert.equal(
	(adaptiveCron.model as { provider: string }).provider,
	"cloudflare-auto",
);

assert.throws(
	() =>
		selectJudgeModelForTurn({
			...azureEnv,
			TEDI_JUDGE_MODEL_REF: "azure-openai/not-in-the-catalog",
		}),
	/Invalid TEDI_JUDGE_MODEL_REF/,
	"a typoed verifier pin must fail closed instead of selecting the chat default",
);

console.log("turn-model-selection judge selection OK");

assert.notEqual(typeof selected.model, "string");
assert.equal(
	(selected.model as { provider: string }).provider,
	"azure.responses",
);
const primary = selectChatModelForTurn(azureEnv, {
	modelRef: "azure-openai/gpt-5.6-terra",
});
assert.equal(
	(primary.model as { provider: string }).provider,
	"azure.responses",
);
assert.equal((primary.model as { modelId: string }).modelId, "gpt-5.6-terra");

assert.throws(
	() =>
		selectChatModelForTurn(
			azureEnv,
			{ modelRef: "cloudflare/auto" },
			undefined,
			undefined,
			{
				surface: "judgment",
				authority: "authority-sensitive",
				reproducibility: "fixed-model-required",
				sovereignty: "unconstrained",
			},
		),
	/fixed-model or residency/,
);
assert.equal(
	selectJudgeModelForTurn({ ...azureEnv, TEDI_JUDGE_MODEL_REF: undefined })
		.identity.model,
	"cloudflare/auto",
);

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
const { generateText } = await import("ai");

// Real adapter and service-bound billing, with no provider or financial writes.
for (const route of [
	"azure-https",
	"azure-binding",
	"workers-run",
	"workers-https",
	"workers-binding",
	"auto",
	"judge-azure",
	"judge-workers",
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
	const invoke = async (recheck: () => void, signal?: AbortSignal) => {
		const guard = fixtureOriginGuard("org", recheck);
		const chosen = route.startsWith("judge")
			? selectJudgeModelForTurn(
					{
						...env,
						TEDI_JUDGE_MODEL_REF:
							route === "judge-workers"
								? "workers-ai/@cf/openai/gpt-oss-120b"
								: "azure-openai/gpt-5.6-terra",
					} as never,
					{ orgId: "org", tediId: "fixture-tedi" },
					guard,
				)
			: selectChatModelForTurn(
					env as never,
					{
						modelRef: route.startsWith("workers")
							? "workers-ai/@cf/openai/gpt-oss-120b"
							: route === "auto"
								? "cloudflare/auto"
								: "azure-openai/gpt-5.6-terra",
					},
					{ orgId: "org", tediId: "fixture-tedi" },
					undefined,
					undefined,
					guard,
				);
		return generateText({
			model: chosen.model,
			prompt: "fixture",
			maxRetries: 0,
			abortSignal: signal,
		});
	};
	try {
		const pending = invoke(guard);
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
		await assert.rejects(invoke(guard), /controlled-wire-reached/);
		assert.equal(sends, 1, route + " positive adapter reaches selected wire");
		active = false;
		await assert.rejects(invoke(guard), { phase: "before_dispatch" });
		assert.equal(sends, 1);
		await assert.rejects(
			invoke(async () => {}),
			{ phase: "before_dispatch" },
		);
		assert.equal(sends, 1);
		const cancelled = new AbortController();
		env.API_SERVICE.fetch = async () => {
			admissions++;
			cancelled.abort(new Error("cancelled-after-billing"));
			return wireGuardAdmission();
		};
		active = true;
		await assert.rejects(invoke(guard, cancelled.signal));
		assert.equal(
			sends,
			1,
			route + " successful billing does not bypass cancellation",
		);
		assert.ok(admissions >= 3);
	} finally {
		globalThis.fetch = savedFetch;
	}
}
console.log("PASS: selected adapter private wire authority");

// A real SDK retry revisits the final guard after an actual transient provider response.
{
	const saved = globalThis.fetch;
	let active = true,
		sends = 0,
		checks = 0,
		admissions = 0;
	const env = {
		...azureEnv,
		API_SERVICE: {
			fetch: async () => {
				admissions++;
				return wireGuardAdmission();
			},
		},
		SECRETS_MASTER_KEY: "fixture-signing-secret",
		TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
	};
	globalThis.fetch = async () => {
		sends++;
		active = false;
		return new Response(JSON.stringify({ error: { message: "temporary" } }), {
			status: 503,
			headers: { "content-type": "application/json" },
		});
	};
	try {
		const selected = selectChatModelForTurn(
			env as never,
			{ modelRef: "azure-openai/gpt-5.6-terra" },
			{ orgId: "org", tediId: "fixture-tedi" },
			undefined,
			undefined,
			fixtureOriginGuard("org", () => {
				checks++;
				if (!active) throw new Error("revoked-on-retry");
			}),
		);
		await assert.rejects(
			generateText({ model: selected.model, prompt: "fixture", maxRetries: 1 }),
			(error: unknown) => {
				const retry = error as {
					name: string;
					lastError: { phase: string; providerRequestSent: boolean };
					errors: unknown[];
				};
				assert.equal(retry.name, "AI_RetryError");
				assert.equal(retry.lastError.phase, "before_dispatch");
				assert.equal(retry.lastError.providerRequestSent, false);
				assert.equal(retry.errors.length, 2);
				return true;
			},
		);
		assert.equal(sends, 1);
		assert.ok(checks >= 2);
		assert.equal(admissions, 1);
	} finally {
		globalThis.fetch = saved;
	}
}

// Scripted fixture assertion; this is not evidence of a production Durable Object.
function fixtureOriginGuard(orgId = "org", recheck: () => void = () => {}) {
	const owner = { orgId, tediId: "fixture-tedi", objectId: "a".repeat(64) };
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
