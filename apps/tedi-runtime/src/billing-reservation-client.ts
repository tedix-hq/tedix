import {
	signRuntimeInferenceOrigin,
	type NativeInferenceRequestProjection,
} from "@tedix/auth/runtime-inference-origin";
import {
	assertProviderDispatchReady,
	type ProviderBeforeDispatch,
} from "@tedix/workers-ai/gateway-transport";
import {
	readPrivateInferenceOrigin,
	requestInferenceOriginGuard,
	admittedInferenceDispatchGuard,
} from "./runtime-inference-origin";
import type { ProviderExecutionIdentity } from "@tedix/api-contract/schemas/provider-execution";
import { AuthorizeRuntimeInferenceResponseSchema } from "@tedix/api-contract/schemas/runtime-entitlements";
import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import {
	decodeAiGatewayAttribution,
	encodeAiGatewayAttribution,
} from "@tedix/api-contract/schemas/ai-gateway-attribution";
import type { AuthorizeRuntimeInferenceResponse } from "@tedix/api-contract/schemas/runtime-entitlements";
import { BillingSettlementModeSchema } from "@tedix/api-contract/schemas/runtime-entitlements";
import type { AigMetadata } from "./llm";
import { markInferenceAuthorize } from "./runtime-latency-markers";

export interface BillingReservationEnv {
	SECRETS_MASTER_KEY?: string;
	API_SERVICE?: Fetcher;
	TEDIX_BILLING_SETTLEMENT_MODE?: string;
}

export class BillingAdmissionError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "BillingAdmissionError";
		this.code = code;
	}
}

export const BILLING_POLICY_DENIED_STOP_REASON = "billing_policy_denied";

type BillingPolicyDenialCode = Extract<
	AuthorizeRuntimeInferenceResponse,
	{ allowed: false }
>["code"];

export interface BillingPolicyDeniedWorkflowResult {
	text: string;
	stopReason: typeof BILLING_POLICY_DENIED_STOP_REASON;
	error: string;
	billingCode: BillingPolicyDenialCode;
}

const BILLING_POLICY_DENIAL_CODES = new Set<BillingPolicyDenialCode>([
	"billing_not_configured",
	"subscription_inactive",
	"billing_period_inactive",
	"monthly_allowance_exhausted",
	"payment_required",
	"hard_spend_limit",
	"inference_capacity_exhausted",
	"model_tier_not_allowed",
	"entitlement_not_configured",
	"entitlement_inactive",
	"entitlement_period_inactive",
]);

const BILLING_POLICY_DENIED_MESSAGE = "Inference blocked by billing policy: ";

function errorMessage(error: unknown): string {
	try {
		if (error instanceof Error) return error.message;
		if (
			error &&
			typeof error === "object" &&
			typeof (error as { message?: unknown }).message === "string"
		) {
			return (error as { message: string }).message;
		}
		return String(error);
	} catch {
		return "Inference blocked by billing policy";
	}
}

function billingPolicyDenialCode(
	error: unknown,
): BillingPolicyDenialCode | null {
	if (
		error instanceof BillingAdmissionError &&
		BILLING_POLICY_DENIAL_CODES.has(error.code as BillingPolicyDenialCode)
	) {
		return error.code as BillingPolicyDenialCode;
	}
	const message = errorMessage(error);
	const marker = message.indexOf(BILLING_POLICY_DENIED_MESSAGE);
	if (marker === -1) return null;
	const candidate = message
		.slice(marker + BILLING_POLICY_DENIED_MESSAGE.length)
		.match(/^[a-z_]+/)?.[0];
	return candidate &&
		BILLING_POLICY_DENIAL_CODES.has(candidate as BillingPolicyDenialCode)
		? (candidate as BillingPolicyDenialCode)
		: null;
}

/**
 * Convert a policy denial into a successful native Workflow step result.
 *
 * Durable Object RPC does not promise to preserve custom Error prototypes, so
 * the classifier accepts both the local BillingAdmissionError and its stable
 * serialized message. Service/binding/response failures stay retryable.
 */
export function billingPolicyDeniedWorkflowResult(
	error: unknown,
): BillingPolicyDeniedWorkflowResult | null {
	const billingCode = billingPolicyDenialCode(error);
	if (!billingCode) return null;
	return {
		text: `I couldn't complete that turn because this workspace's billing policy blocked inference (${billingCode}). Please contact a workspace administrator.`,
		stopReason: BILLING_POLICY_DENIED_STOP_REASON,
		error: errorMessage(error),
		billingCode,
	};
}

export function isBillingPolicyDeniedWorkflowResult(
	result: unknown,
): result is BillingPolicyDeniedWorkflowResult {
	if (!result || typeof result !== "object") return false;
	const value = result as Record<string, unknown>;
	return (
		value.stopReason === BILLING_POLICY_DENIED_STOP_REASON &&
		typeof value.text === "string" &&
		value.text.trim().length > 0 &&
		typeof value.error === "string" &&
		typeof value.billingCode === "string" &&
		BILLING_POLICY_DENIAL_CODES.has(
			value.billingCode as BillingPolicyDenialCode,
		)
	);
}

function sourceFromMetadata(
	source: string | undefined,
): NativeInferenceRequestProjection["source"] {
	if (!source) return "system";
	if (source.startsWith("observer:")) return "observer";
	if (source.includes("compaction")) return "compaction";
	if (
		source.startsWith("cron:") ||
		source.includes("schedule") ||
		source.includes("automation")
	) {
		return "automation";
	}
	if (source.includes("evaluation")) return "evaluation";
	return "operator";
}

function parseBody(body: BodyInit | null | undefined): {
	inputTokens: number;
	outputTokens: number;
} {
	if (typeof body !== "string") {
		return { inputTokens: 1, outputTokens: 4_096 };
	}
	let outputTokens = 4_096;
	try {
		const parsed = JSON.parse(body) as Record<string, unknown>;
		const requested =
			parsed.max_completion_tokens ??
			parsed.max_tokens ??
			parsed.max_output_tokens;
		if (
			typeof requested === "number" &&
			Number.isSafeInteger(requested) &&
			requested > 0
		) {
			outputTokens = Math.min(requested, 2_000_000);
		}
	} catch {
		// The byte estimate below is still a safe upper-bound input estimate.
	}
	return {
		inputTokens: Math.max(1, Math.ceil(body.length / 3)),
		outputTokens,
	};
}

function unwrapResponse(
	value: unknown,
): AuthorizeRuntimeInferenceResponse | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const candidate =
		record.json && typeof record.json === "object" ? record.json : record;
	const parsed = AuthorizeRuntimeInferenceResponseSchema.safeParse(candidate);
	return parsed.success ? parsed.data : null;
}

export function applyAuthorizedInferenceAttribution(
	metadata: AigMetadata | undefined,
	decision: Extract<AuthorizeRuntimeInferenceResponse, { allowed: true }>,
): AigMetadata {
	const attribution = decodeAiGatewayAttribution(metadata?.attribution);
	return {
		...metadata,
		attribution: encodeAiGatewayAttribution({
			runId:
				attribution?.runId ??
				`system:${metadata?.tediId ?? "unknown"}:${metadata?.source ?? "inference"}`,
			workItemId:
				attribution?.workItemId ?? `system:${metadata?.source ?? "inference"}`,
			executionId: decision.executionId,
			...(decision.reservationId
				? { billingReservationId: decision.reservationId }
				: {}),
		}),
	};
}

export interface AuthorizedInferenceRequest {
	readonly attribution: Readonly<AigMetadata>;
	readonly execution: Readonly<ProviderExecutionIdentity>;
	readonly receipt: Readonly<
		Extract<AuthorizeRuntimeInferenceResponse, { allowed: true }>
	>;
	readonly beforeDispatch: ProviderBeforeDispatch;
}

/**
 * Reserve the organization entitlement before a provider request and thread the
 * reservation id into the existing packed Gateway attribution field.
 */
export async function authorizeInferenceEntitlement(
	env: BillingReservationEnv,
	input: {
		metadata: AigMetadata | undefined;
		execution: ProviderExecutionIdentity;
		body: BodyInit | null | undefined;
		beforeDispatch: ProviderBeforeDispatch;
		signal?: AbortSignal | null;
	},
): Promise<AuthorizedInferenceRequest> {
	const requestGuard = requestInferenceOriginGuard(input.beforeDispatch);
	input.signal?.throwIfAborted();
	const origin = readPrivateInferenceOrigin(requestGuard)!;
	if (!env.SECRETS_MASTER_KEY)
		throw new Error("Inference origin signing secret unavailable");
	input = {
		...input,
		metadata: structuredClone(input.metadata),
		execution: structuredClone(input.execution),
	};
	const organizationId = input.metadata?.orgId;
	if (!organizationId) {
		throw new BillingAdmissionError(
			"missing_billing_attribution",
			"Paid inference requires organization billing attribution",
		);
	}
	if (!env.API_SERVICE) {
		throw new BillingAdmissionError(
			"billing_service_unavailable",
			"Paid inference requires the API_SERVICE billing binding",
		);
	}
	const settlementMode = BillingSettlementModeSchema.safeParse(
		env.TEDIX_BILLING_SETTLEMENT_MODE,
	);
	if (!settlementMode.success) {
		throw new BillingAdmissionError(
			"billing_settlement_mode_missing",
			"Inference requires an explicit TEDIX_BILLING_SETTLEMENT_MODE",
		);
	}
	// This whole function sits on the critical path of every provider request,
	// awaited inside the fetch wrapper, and nothing else measures it: AI Gateway
	// starts its clock on arrival and the facet markers stop before it. Time the
	// body estimate and the RPC separately — they would need different fixes.
	const authorizeAt = Date.now();
	const attribution = decodeAiGatewayAttribution(input.metadata?.attribution);
	const estimate = parseBody(input.body);
	const parseMs = Date.now() - authorizeAt;
	const idempotencyKey = `inference:${crypto.randomUUID()}`;
	const request: NativeInferenceRequestProjection = {
		organizationId,
		settlementMode: settlementMode.data,
		tediId: input.metadata?.tediId ?? null,
		source: sourceFromMetadata(input.metadata?.source),
		execution: input.execution,
		workItemId: attribution?.workItemId ?? null,
		estimatedInputTokens: estimate.inputTokens,
		estimatedOutputTokens: estimate.outputTokens,
		runId:
			origin.kind === "accepted_native" ? origin.root.accepted.runId : null,
		traceId: input.metadata?.sessionKeyHash ?? null,
		idempotencyKey,
		metadata: {
			source: input.metadata?.source ?? "system",
		},
	};
	const mark = (outcome: "authorized" | "denied" | "error", rpcMs: number) =>
		markInferenceAuthorize({
			runId: attribution?.runId ?? null,
			provider: input.execution.provider,
			model: input.execution.requestModel,
			source: input.metadata?.source ?? null,
			parseMs,
			rpcMs,
			totalMs: Date.now() - authorizeAt,
			estimatedInputTokens: estimate.inputTokens ?? null,
			outcome,
		});
	const originToken = await signRuntimeInferenceOrigin({
		secret: env.SECRETS_MASTER_KEY,
		request,
		origin,
	});
	assertProviderDispatchReady(requestGuard);
	input.signal?.throwIfAborted();
	const signedRequest = { ...request, originToken };
	const rpcAt = Date.now();
	let decision: AuthorizeRuntimeInferenceResponse;
	try {
		decision = await callRpc<AuthorizeRuntimeInferenceResponse>(
			"runtimeEntitlements/authorizeInference",
			signedRequest,
			{
				apiUrl: "https://api",
				fetch: serviceBindingFetch(env.API_SERVICE),
				headers: {
					"X-Service-Binding": "true",
					"X-Tedix-Org-Id": "system",
				},
			},
		);
	} catch (error) {
		mark("error", Date.now() - rpcAt);
		throw new BillingAdmissionError(
			"billing_service_error",
			`Billing admission failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const rpcMs = Date.now() - rpcAt;
	const parsedDecision = unwrapResponse(decision);
	if (!parsedDecision) {
		mark("error", rpcMs);
		throw new BillingAdmissionError(
			"billing_response_invalid",
			"Billing admission returned an invalid response",
		);
	}
	decision = parsedDecision;
	if (!decision.allowed) {
		mark("denied", rpcMs);
		throw new BillingAdmissionError(
			decision.code,
			`Inference blocked by billing policy: ${decision.code}`,
		);
	}
	if (decision.settlementMode !== settlementMode.data)
		throw new BillingAdmissionError(
			"billing_response_invalid",
			"Billing admission changed the settlement mode",
		);
	if (Date.parse(decision.sendBefore) <= Date.now())
		throw new BillingAdmissionError(
			"execution_expired",
			"Execution admission expired before send",
		);
	mark("authorized", rpcMs);
	const beforeDispatch = admittedInferenceDispatchGuard(
		requestGuard,
		decision.sendBefore,
		input.signal,
	);
	assertProviderDispatchReady(beforeDispatch);
	return Object.freeze({
		attribution: Object.freeze(
			applyAuthorizedInferenceAttribution(input.metadata, decision),
		),
		execution: Object.freeze(structuredClone(input.execution)),
		receipt: Object.freeze(structuredClone(decision)),
		beforeDispatch,
	});
}
