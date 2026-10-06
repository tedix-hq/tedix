import { privateInferenceOriginGuard } from "./runtime-inference-origin";
import assert from "node:assert/strict";
import {
	BillingAdmissionError,
	applyAuthorizedInferenceAttribution,
	authorizeInferenceEntitlement,
	billingPolicyDeniedWorkflowResult,
	isBillingPolicyDeniedWorkflowResult,
} from "./billing-reservation-client";
import { decodeAiGatewayAttribution } from "@tedix/api-contract/schemas/ai-gateway-attribution";

const execution = {
	provider: "workers-ai",
	requestModel: "@cf/test",
	gatewayAccountId: "account",
	gatewayId: "gateway",
	transportKind: "workers-ai-binding",
	apiKind: "workers-ai-chat",
	providerResource: null,
	providerOrigin: null,
	deployment: null,
} as const;
const admission = {
	allowed: true,
	settlementMode: "disabled",
	attributionVersion: 3,
	executionId: "12345678-1234-4123-8123-123456789abc",
	sendBefore: "2099-01-01T00:00:00.000Z",
	reservationId: null,
	expiresAt: null,
	estimatedChargeMicros: null,
} as const;
await assert.rejects(
	authorizeInferenceEntitlement(
		{
			SECRETS_MASTER_KEY: "fixture-signing-secret",
			API_SERVICE: {
				fetch: async () => {
					throw new Error("must not call API without explicit mode");
				},
			} as unknown as Fetcher,
		},
		{
			metadata: { orgId: "org-1", tediId: "fixture-tedi" },
			beforeDispatch: fixtureOriginGuard("org-1"),
			execution,
			body: "{}",
		},
	),
	/TEDIX_BILLING_SETTLEMENT_MODE/,
);

const attributed = applyAuthorizedInferenceAttribution(
	{ orgId: "org-1", source: "os" },
	admission,
);
assert.equal(JSON.parse(attributed.attribution!).v, 3);
assert.equal(
	decodeAiGatewayAttribution(attributed.attribution)?.executionId,
	admission.executionId,
);
assert.equal(
	decodeAiGatewayAttribution(attributed.attribution)?.billingReservationId,
	undefined,
);
const managed = applyAuthorizedInferenceAttribution(attributed, {
	...admission,
	settlementMode: "managed",
	reservationId: "reservation",
	expiresAt: admission.sendBefore,
	estimatedChargeMicros: 0,
});
assert.equal(
	decodeAiGatewayAttribution(managed.attribution)?.billingReservationId,
	"reservation",
);
for (const invalid of [
	{ ...admission, attributionVersion: 2 },
	{ ...admission, executionId: undefined },
	{ ...admission, sendBefore: "2000-01-01T00:00:00.000Z" },
	{ ...admission, settlementMode: "external" },
	{ ...admission, reservationId: "unexpected-reservation" },
	{ ...admission, settlementMode: "managed" },
]) {
	let sends = 0;
	await assert.rejects(async () => {
		await authorizeInferenceEntitlement(
			{
				SECRETS_MASTER_KEY: "fixture-signing-secret",
				TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
				API_SERVICE: {
					fetch: async () => Response.json({ json: invalid }),
				} as unknown as Fetcher,
			},
			{
				metadata: { orgId: "org-1", tediId: "fixture-tedi" },
				execution,
				body: "{}",
				beforeDispatch: fixtureOriginGuard("org-1"),
			},
		);
		sends++;
	});
	assert.equal(sends, 0, "Invalid admission must stop before a provider send");
}

const local = billingPolicyDeniedWorkflowResult(
	new BillingAdmissionError(
		"payment_required",
		"Inference blocked by billing policy: payment_required",
	),
);
assert.deepEqual(local, {
	text: "I couldn't complete that turn because this workspace's billing policy blocked inference (payment_required). Please contact a workspace administrator.",
	stopReason: "billing_policy_denied",
	error: "Inference blocked by billing policy: payment_required",
	billingCode: "payment_required",
});
assert.equal(isBillingPolicyDeniedWorkflowResult(local), true);

const serialized = billingPolicyDeniedWorkflowResult(
	new Error(
		"remote RPC failure: Inference blocked by billing policy: hard_spend_limit",
	),
);
assert.equal(serialized?.billingCode, "hard_spend_limit");
assert.equal(isBillingPolicyDeniedWorkflowResult(serialized), true);

for (const transient of [
	new BillingAdmissionError(
		"billing_service_unavailable",
		"Paid inference requires the API_SERVICE billing binding",
	),
	new BillingAdmissionError(
		"billing_service_error",
		"Billing admission failed (503)",
	),
	new BillingAdmissionError(
		"billing_response_invalid",
		"Billing admission returned an invalid response",
	),
	new Error("transient provider reset"),
]) {
	assert.equal(
		billingPolicyDeniedWorkflowResult(transient),
		null,
		`${transient.message} remains retryable`,
	);
}

assert.equal(
	isBillingPolicyDeniedWorkflowResult({
		text: "not enough",
		stopReason: "billing_policy_denied",
		error: "unknown denial",
		billingCode: "invented_code",
	}),
	false,
);

console.log("billing-reservation-client.test.ts: all assertions passed");

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

// The signed billing projection owns the original accepted root; Gateway run correlation remains ordinary metadata.
{
	const { createHash } = await import("node:crypto");
	const { verifyRuntimeInferenceOrigin } =
		await import("@tedix/auth/runtime-inference-origin");
	const { encodeAiGatewayAttribution } =
		await import("@tedix/api-contract/schemas/ai-gateway-attribution");
	const { azureGatewayFetch } = await import("./llm");
	const body = JSON.stringify({ private: "original input" });
	const owner = {
		orgId: "org-1",
		tediId: "fixture-tedi",
		objectId: "a".repeat(64),
	};
	const accepted = {
		owner,
		runId: "original-root-maintenance",
		sessionKey: "session",
		principalId: "principal",
		inputHash: createHash("sha256").update(body).digest("hex"),
		requestHash: "b".repeat(64),
		generation: 1,
	};
	const guard = privateInferenceOriginGuard(
		{
			kind: "accepted_native",
			root: {
				owner,
				objectName: "root",
				className: "AgentTediDO",
				path: [],
				generation: 1,
				accepted,
			},
			selected: {
				owner,
				className: "AgentTediDO",
				identityName: "root",
				facetName: null,
				path: [],
				generation: 1,
				accepted,
			},
			operation: null,
			configurationHash: null,
		},
		() => {},
		body,
	);
	const now = Date.now,
		time = now();
	let calls = 0,
		wires = 0;
	Date.now = () => time;
	try {
		const authorized = await authorizeInferenceEntitlement(
			{
				SECRETS_MASTER_KEY: "fixture-signing-secret",
				TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
				API_SERVICE: {
					fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
						calls++;
						const envelope = (await new Request(input, init).json()) as any;
						const { originToken, ...request } = envelope.json ?? envelope;
						assert.equal(request.runId, "original-root-maintenance");
						assert.equal(request.tediId, "fixture-tedi");
						const origin = await verifyRuntimeInferenceOrigin({
							secret: "fixture-signing-secret",
							request,
							token: originToken,
						});
						assert.equal(origin.kind, "accepted_native");
						assert.deepEqual(request.execution.autoRouting, {
							version: 1,
							modality: "text",
							mode: "restricted",
							allowedProviders: ["workers-ai"],
							allowedModels: ["@cf/example/model"],
						});
						assert.ok(!JSON.stringify(envelope).includes("original input"));
						return Response.json({
							json: {
								...admission,
								sendBefore: new Date(time + 1_000).toISOString(),
							},
						});
					},
				} as unknown as Fetcher,
			},
			{
				metadata: {
					orgId: "org-1",
					tediId: "fixture-tedi",
					attribution: encodeAiGatewayAttribution({
						runId: "ordinary-chat-correlation",
						workItemId: "work",
					}),
				},
				execution: {
					...execution,
					requestModel: "cloudflare/auto",
					transportKind: "gateway-https",
					autoRouting: {
						version: 1,
						modality: "text",
						mode: "restricted",
						allowedProviders: ["workers-ai"],
						allowedModels: ["@cf/example/model"],
					},
				},
				body,
				beforeDispatch: guard,
			},
		);
		assert.equal(
			decodeAiGatewayAttribution(authorized.attribution.attribution)?.runId,
			"ordinary-chat-correlation",
		);
		assert.ok(Object.isFrozen(authorized.receipt));
		assert.ok(Object.isFrozen(authorized.execution));
		assert.ok(Object.isFrozen(authorized.execution.autoRouting));
		assert.ok(Object.isFrozen(authorized.execution.autoRouting?.allowedModels));
		// Post-admission expiry: final real transport must enforce this receipt's narrower API window.
		Date.now = () => time + 1_001;
		const transport = azureGatewayFetch(
			{
				AZURE_OPENAI_RESOURCE: "fixture",
				AI_GATEWAY_ACCOUNT_ID: "account",
				AI_GATEWAY_LLM_ID: "gateway",
				AI_GATEWAY_BINDING_PROVIDERS: "azure-openai",
				AI: {
					fetch: async () => {
						wires++;
						return Response.json({});
					},
				},
			} as never,
			authorized.beforeDispatch,
		);
		await assert.rejects(
			transport(
				"https://gateway.ai.cloudflare.com/v1/account/gateway/azure-openai/fixture/openai/v1/responses",
			),
			{ phase: "before_dispatch" },
		);
		assert.equal(calls, 1);
		assert.equal(wires, 0);
	} finally {
		Date.now = now;
	}
}
console.log(
	"PASS signed original root projection, preserved correlation, immutable receipt and narrow API window at actual wire",
);
