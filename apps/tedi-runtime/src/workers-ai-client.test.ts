import assert from "node:assert/strict";
import { callWorkersAi } from "@tedix/workers-ai/transport";
import { verifyRuntimeInferenceOrigin } from "@tedix/auth/runtime-inference-origin";
import { decodeAiGatewayAttribution } from "@tedix/api-contract/schemas/ai-gateway-attribution";
import { workersAiClient } from "./workers-ai-client";
import { privateInferenceOriginGuard } from "./runtime-inference-origin";

const secret = "fixture-signing-secret";
function fixtureGuard() {
	const owner = { orgId: "org", tediId: "tedi", objectId: "a".repeat(64) };
	return privateInferenceOriginGuard(
		{
			kind: "unselected_native",
			root: {
				owner,
				objectName: "root",
				className: "AgentTediDO",
				path: [],
				generation: 0,
			},
			selected: {
				owner,
				className: "AgentTediDO",
				identityName: "root",
				facetName: null,
				path: [],
				generation: 0,
			},
			configurationHash: "b".repeat(64),
		},
		() => {},
	);
}
const admission = (
	executionId: string,
	sendBefore = "2099-01-01T00:00:00.000Z",
) =>
	Response.json({
		json: {
			allowed: true,
			settlementMode: "disabled",
			attributionVersion: 3,
			executionId,
			sendBefore,
			reservationId: null,
			expiresAt: null,
			estimatedChargeMicros: null,
		},
	});
for (const route of ["run", "binding", "https"] as const) {
	const savedFetch = globalThis.fetch;
	let bills = 0,
		wires = 0;
	const wireMetadata: string[] = [];
	const signedTokens: string[] = [];
	const wire = async (_input: unknown, init?: RequestInit) => {
		wires++;
		const metadata = new Headers(init?.headers).get("cf-aig-metadata") ?? "";
		wireMetadata.push(metadata);
		assert.ok(!metadata.includes("originToken"));
		assert.ok(!metadata.includes("configurationHash"));
		return Response.json({ choices: [{ message: { content: "ok" } }] });
	};
	const env = {
		SECRETS_MASTER_KEY: secret,
		TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
		AI_GATEWAY_ACCOUNT_ID: "account",
		AI_GATEWAY_LLM_ID: "gateway",
		...(route === "https"
			? { CF_AI_GATEWAY_TOKEN: "token", CF_WORKERS_AI_TOKEN: "token" }
			: {}),
		...(route === "binding"
			? { AI_GATEWAY_BINDING_PROVIDERS: "workers-ai" }
			: {}),
		AI: {
			fetch: wire,
			run: async (_model: unknown, _body: unknown, options: any) => {
				wires++;
				const metadata = JSON.stringify(options?.gateway?.metadata);
				wireMetadata.push(metadata);
				assert.ok(!metadata.includes("originToken"));
				return { response: "ok" };
			},
		},
		API_SERVICE: {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				bills++;
				const envelope = (await new Request(input, init).json()) as any;
				const { originToken, ...request } = envelope.json ?? envelope;
				signedTokens.push(originToken);
				const origin = await verifyRuntimeInferenceOrigin({
					secret,
					request,
					token: originToken,
				});
				assert.equal(origin.kind, "unselected_native");
				assert.equal(origin.root.generation, 0);
				assert.ok(!JSON.stringify(request).includes("private-prompt"));
				return admission(crypto.randomUUID());
			},
		},
	};
	globalThis.fetch = wire as typeof fetch;
	const invoke = (guard?: () => void) =>
		callWorkersAi(workersAiClient(env as never, guard), "@cf/test", {
			messages: [{ role: "user", content: "private-prompt" }],
			attribution: { orgId: "org", tediId: "tedi" },
		});
	try {
		await assert.rejects(invoke(), /private native origin capture/);
		await assert.rejects(
			invoke(() => {}),
			/private native origin capture/,
		);
		assert.equal(bills, 0);
		assert.equal(wires, 0);
		await invoke(fixtureGuard());
		assert.equal(bills, 1);
		assert.equal(wires, 1);
		assert.ok(
			wireMetadata.every(
				(m) =>
					!m.includes("objectId") &&
					signedTokens.every((token) => !m.includes(token)),
			),
		);
		// Expire while the actual API response is being produced; a future receipt cannot renew the local cap.
		const now = Date.now,
			captured = now();
		Date.now = () => captured;
		const guard = fixtureGuard();
		env.API_SERVICE.fetch = async () => {
			bills++;
			Date.now = () => captured + 600_001;
			return admission(crypto.randomUUID());
		};
		try {
			await assert.rejects(invoke(guard), { phase: "before_dispatch" });
			assert.equal(wires, 1);
		} finally {
			Date.now = now;
		}
	} finally {
		globalThis.fetch = savedFetch;
	}
}
// One reused factory: reverse admission completion and keep each execution attribution local.
{
	const responses = new Map<string, () => void>(),
		executions = new Map<string, string>(),
		sent = new Map<string, string>();
	const env = {
		SECRETS_MASTER_KEY: secret,
		TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
		AI_GATEWAY_ACCOUNT_ID: "account",
		AI_GATEWAY_LLM_ID: "gateway",
		AI: {
			run: async (_model: unknown, body: any, options: any) => {
				const label = body.messages[0].content;
				sent.set(
					label,
					decodeAiGatewayAttribution(options.gateway.metadata.attribution)!
						.executionId!,
				);
				return { response: "ok" };
			},
		},
		API_SERVICE: {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const envelope = (await new Request(input, init).json()) as any;
				const request = envelope.json ?? envelope;
				const label = request.metadata.source;
				const executionId = crypto.randomUUID();
				executions.set(label, executionId);
				await new Promise<void>((resolve) => responses.set(label, resolve));
				return admission(executionId);
			},
		},
	};
	const client = workersAiClient(env as never, fixtureGuard());
	const invoke = (label: string) =>
		callWorkersAi(client, "@cf/test", {
			messages: [{ role: "user", content: label }],
			attribution: { orgId: "org", tediId: "tedi", source: label },
		});
	const a = invoke("a"),
		b = invoke("b");
	while (responses.size < 2) await new Promise((r) => setTimeout(r, 1));
	responses.get("b")!();
	await b;
	responses.get("a")!();
	await a;
	assert.deepEqual(
		sent,
		new Map([
			["b", executions.get("b")!],
			["a", executions.get("a")!],
		]),
	);
	assert.notEqual(sent.get("a"), sent.get("b"));
}
console.log(
	"PASS signed Workers AI HTTPS/binding/run, missing capture, original expiry and reverse receipt isolation",
);

// Abort during actual HMAC signing, after the package passes the original signal.
for (const route of ["run", "binding", "https", "auto"] as const) {
	const savedFetch = globalThis.fetch;
	const originalSign = crypto.subtle.sign.bind(crypto.subtle);
	const descriptor = Object.getOwnPropertyDescriptor(crypto.subtle, "sign");
	const controller = new AbortController();
	let signatures = 0,
		admissions = 0,
		wires = 0;
	const wire = async () => {
		wires++;
		return Response.json({ choices: [{ message: { content: "ok" } }] });
	};
	const env = {
		SECRETS_MASTER_KEY: secret,
		TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
		AI_GATEWAY_ACCOUNT_ID: "account",
		AI_GATEWAY_LLM_ID: "gateway",
		...(route === "https" || route === "auto"
			? { CF_AI_GATEWAY_TOKEN: "token", CF_WORKERS_AI_TOKEN: "token" }
			: {}),
		...(route === "binding"
			? { AI_GATEWAY_BINDING_PROVIDERS: "workers-ai" }
			: {}),
		AI: { fetch: wire, run: wire },
		API_SERVICE: {
			fetch: async () => {
				admissions++;
				return admission(crypto.randomUUID());
			},
		},
	};
	const messages = [{ role: "user" as const, content: "fixture" }];
	const request = {
		messages,
		attribution: { orgId: "org", tediId: "tedi" },
		signal: controller.signal,
	};
	const observerOptions = {
		env: env as never,
		modelRef: "cloudflare/auto",
		beforeDispatch: fixtureGuard(),
		messages,
		metadata: { orgId: "org", tediId: "tedi" },
		signal: controller.signal,
	};
	Object.defineProperty(crypto.subtle, "sign", {
		configurable: true,
		value: async (...args: Parameters<typeof originalSign>) => {
			const algorithm = typeof args[0] === "string" ? args[0] : args[0].name;
			if (algorithm === "HMAC") {
				signatures++;
				controller.abort(
					new Error("request canceled during actual HMAC signing"),
				);
				// The original signal survives replacing the caller's mutable option.
				request.signal = new AbortController().signal;
				observerOptions.signal = request.signal;
			}
			return originalSign(...args);
		},
	});
	globalThis.fetch = wire;
	try {
		await assert.rejects(
			route === "auto"
				? (await import("./observer-llm")).observerCompletion(observerOptions)
				: callWorkersAi(
						workersAiClient(env as never, fixtureGuard()),
						"@cf/test",
						request,
					),
			/request canceled during actual HMAC signing/,
		);
		assert.equal(
			request.signal.aborted,
			false,
			"replacement signal is un-aborted; only original captured cancellation blocks admission",
		);
		assert.equal(signatures, 1, "the real shared HMAC signer was reached");
		assert.equal(
			admissions,
			0,
			"signing cancellation must stop before billing admission",
		);
		assert.equal(
			wires,
			0,
			"signing cancellation must stop before provider dispatch",
		);
	} finally {
		globalThis.fetch = savedFetch;
		if (descriptor) Object.defineProperty(crypto.subtle, "sign", descriptor);
		else Reflect.deleteProperty(crypto.subtle, "sign");
	}
}
console.log(
	"PASS Workers AI run/binding/HTTPS/Auto Router cancellation during real HMAC signing denies before admission and wire",
);
