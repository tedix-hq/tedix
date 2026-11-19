/**
 * Credit admission for workspace chat model calls.
 *
 * Every provider call reserves credits through apps/api before it is sent,
 * on the same path the kernel and the tedi runtime use. The call's AI Gateway
 * log names the reservation and execution, so settlement replaces the hold
 * with the actual cost. A call that never reached the provider, or that the
 * provider refused, releases its hold at once.
 */
import { encodeAiGatewayAttribution } from "@tedix/api-contract/schemas/ai-gateway-attribution";
import type { ProviderExecutionIdentity } from "@tedix/api-contract/schemas/provider-execution";
import {
	type AuthorizeRuntimeInferenceResponse,
	AuthorizeRuntimeInferenceResponseSchema,
	type AuthorizeWorkspaceInferenceInput,
	type ReleaseInferenceReservationInput,
	type RuntimeEntitlementDenialCode,
	runtimeInferenceDenialMessage,
} from "@tedix/api-contract/schemas/runtime-entitlements";
import {
	applyAiGatewayCustomCost,
	regionalAzureGatewayUrl,
} from "@tedix/workers-ai/gateway-transport";

export interface InferenceAdmissionPort {
	authorize(
		input: AuthorizeWorkspaceInferenceInput,
	): Promise<AuthorizeRuntimeInferenceResponse>;
	release(input: ReleaseInferenceReservationInput): Promise<void>;
}

/** Who a workspace chat model call is for; the gateway caps metadata at five entries. */
export interface WorkspaceModelCall {
	organizationId: string;
	workspaceId: string;
	turnId: string;
	/** The guest tedi the turn runs as; its tedi cap applies. */
	tediId?: string | null;
	/** Sign-in subject of the member who sent the turn; their member cap applies. */
	userId?: string | null;
}

/** Gateway work id for workspace chat calls, which belong to no Work Item. */
export const WORKSPACE_CHAT_WORK_ID = "system:workspace_chat";

/** A refused admission: the message is what the person reads in the chat. */
export class InferenceRefusedError extends Error {
	readonly code: RuntimeEntitlementDenialCode;

	constructor(code: RuntimeEntitlementDenialCode, detail?: string) {
		super(
			detail
				? `${runtimeInferenceDenialMessage(code)} ${detail}`
				: runtimeInferenceDenialMessage(code),
		);
		this.name = "InferenceRefusedError";
		this.code = code;
	}
}

/** The RPC methods apps/api's `WorkspaceConnectionsEntrypoint` offers this object. */
interface WorkspaceApiEntrypoint {
	authorizeWorkspaceInference(
		input: AuthorizeWorkspaceInferenceInput,
	): Promise<unknown>;
	releaseInferenceReservation(
		input: ReleaseInferenceReservationInput,
	): Promise<unknown>;
}

/** Admission over the API service binding's workspace entrypoint. */
export function apiInferenceAdmission(api: unknown): InferenceAdmissionPort {
	const rpc = api as WorkspaceApiEntrypoint;
	return {
		async authorize(input) {
			return AuthorizeRuntimeInferenceResponseSchema.parse(
				await rpc.authorizeWorkspaceInference(input),
			);
		},
		async release(input) {
			await rpc.releaseInferenceReservation(input);
		},
	};
}

function estimatedInputTokens(body: string): number {
	return Math.min(10_000_000, Math.max(1, Math.ceil(body.length / 3)));
}

/** Gateway metadata naming the admitted execution, so its log settles the hold. */
export function admittedGatewayMetadata(
	call: WorkspaceModelCall,
	decision: Extract<AuthorizeRuntimeInferenceResponse, { allowed: true }>,
): string {
	return JSON.stringify({
		surface: "workspace_object",
		workspaceId: call.workspaceId,
		orgId: call.organizationId,
		...(call.tediId ? { tediId: call.tediId } : {}),
		attribution: encodeAiGatewayAttribution({
			runId: call.turnId,
			workItemId: WORKSPACE_CHAT_WORK_ID,
			executionId: decision.executionId,
			...(decision.reservationId
				? { billingReservationId: decision.reservationId }
				: {}),
		}),
	});
}

/**
 * Reserve, send and settle one provider request. The refusal stays with the
 * caller (`onRefused`) because the provider SDK replaces a thrown fetch error
 * with its own connection message.
 */
export async function admittedProviderFetch(input: {
	admission: InferenceAdmissionPort;
	call: WorkspaceModelCall;
	execution: ProviderExecutionIdentity;
	request: Request;
	maxOutputTokens: number;
	send: (request: Request) => Promise<Response>;
	onRefused: (error: InferenceRefusedError) => void;
}): Promise<Response> {
	const body = await input.request.clone().text();
	const decision = await input.admission.authorize({
		organizationId: input.call.organizationId,
		workspaceId: input.call.workspaceId,
		turnId: input.call.turnId,
		tediId: input.call.tediId ?? null,
		userId: input.call.userId ?? null,
		execution: input.execution,
		estimatedInputTokens: estimatedInputTokens(body),
		estimatedOutputTokens: Math.min(
			2_000_000,
			Math.max(1, input.maxOutputTokens),
		),
		idempotencyKey: `workspace-inference:${crypto.randomUUID()}`,
	});
	if (!decision.allowed) {
		const refused = new InferenceRefusedError(decision.code, decision.message);
		input.onRefused(refused);
		throw refused;
	}
	if (Date.parse(decision.sendBefore) <= Date.now())
		throw new Error("Model call admission expired before it was sent");
	const release = (reason: ReleaseInferenceReservationInput["reason"]) =>
		decision.reservationId
			? input.admission
					.release({
						organizationId: input.call.organizationId,
						reservationId: decision.reservationId,
						reason,
					})
					.catch(() => {
						// Unreleased holds expire on their own; the reply still stands.
					})
			: Promise.resolve();

	const headers = new Headers(input.request.headers);
	headers.set("cf-aig-metadata", admittedGatewayMetadata(input.call, decision));
	applyAiGatewayCustomCost(headers, decision.providerRate);
	let url = input.request.url;
	if (decision.providerApiKey && decision.providerExecution) {
		// A regional pool sends with the organization's own provider key.
		url = regionalAzureGatewayUrl(url, decision.providerExecution);
		headers.set("api-key", decision.providerApiKey);
		headers.set("cf-aig-collect-log", "false");
		headers.set("cf-aig-skip-cache", "true");
	}
	let response: Response;
	try {
		response = await input.send(
			new Request(url, {
				method: input.request.method,
				headers,
				body,
				signal: input.request.signal,
				redirect: decision.providerApiKey ? "manual" : "follow",
			}),
		);
	} catch (error) {
		// A stopped turn may already have reached the provider; settle it then.
		if (!input.request.signal.aborted)
			await release("provider_request_not_sent");
		throw error;
	}
	if (!response.ok) await release("provider_request_failed");
	return response;
}
