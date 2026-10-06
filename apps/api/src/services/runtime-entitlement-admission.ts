import {
	captureCloudflareAutoRouting,
	type AiGatewayTransportEnv,
} from "@tedix/workers-ai/gateway-transport";
import type {
	AuthorizeRuntimeInferenceInput,
	AuthorizeRuntimeInferenceResponse,
} from "@tedix/api-contract/schemas/runtime-entitlements";
import {
	freezeProviderExecutionIdentity,
	providerDeploymentScope,
} from "@tedix/api-contract/schemas/provider-execution";
import { FiniteExecutionAuthorizationSchema } from "@tedix/api-contract/schemas/billing";
import { verifyRuntimeInferenceOrigin } from "@tedix/auth/runtime-inference-origin";
import {
	getFiniteExecutionAuthorization,
	latestHistoricalDecision,
} from "@tedix/db/queries/billing/historical-exposure";
import type { DbClient } from "@tedix/db/client";
import {
	assertProviderExecutionMatches,
	buildProviderExecutionInsertStatement,
	findProviderExecutionAdmission,
	prepareProviderExecutionAdmission,
	prepareKernelAutoRoutingAdmission,
} from "@tedix/db/queries/provider-executions";
import type { NewProviderExecutionAttemptRow } from "@tedix/db/schema/provider-executions";
import { resolveBillingSettlementMode } from "../lib/billing-settlement-mode";
import { authorizeRuntimeBudget } from "./runtime-budget-admission";
import {
	safeErrorClassification,
	safeExceptionTopology,
} from "../lib/safe-log-metadata";

export async function authorizeRuntimeInference(
	input: {
		db: DbClient;
		env:
			| CloudflareEnv
			| ({
					TEDIX_BILLING_SETTLEMENT_MODE?: string;
					SECRETS_MASTER_KEY?: string;
			  } & AiGatewayTransportEnv);
	} & (
		| { plane: "remote_runtime"; request: AuthorizeRuntimeInferenceInput }
		| {
				plane: "organization_kernel";
				request: Omit<AuthorizeRuntimeInferenceInput, "originToken">;
		  }
	) & {
			nowMs?: number;
		},
): Promise<AuthorizeRuntimeInferenceResponse> {
	let phase = "validate_caller";
	const context: {
		plane?: "remote_runtime" | "organization_kernel";
		settlementMode?: "managed" | "external" | "disabled";
		originKind?: "accepted_native" | "unselected_native";
		rootClass?: "AgentTediDO";
		selectedClass?: string;
		rootGeneration?: number;
		selectedGeneration?: number;
		hasFiniteAuthorization?: boolean;
	} = {};
	try {
		if (
			input.plane !== "remote_runtime" &&
			input.plane !== "organization_kernel"
		)
			throw new Error("Inference requires a server-owned caller plane");
		context.plane = input.plane;
		phase = "validate_execution";
		input = {
			...input,
			request: structuredClone(input.request),
		} as typeof input;
		const identity = freezeProviderExecutionIdentity(input.request.execution);
		if (identity.requestModel === "cloudflare/auto") {
			if (!identity.autoRouting)
				throw Error("Auto inference requires routing evidence");
			const messages =
				identity.autoRouting.modality === "image"
					? [{ content: [{ type: "image_url" }] }]
					: [];
			const configured = captureCloudflareAutoRouting(input.env, messages);
			if (JSON.stringify(identity.autoRouting) !== JSON.stringify(configured))
				throw Error("Deployment Auto routing mismatch");
		}
		phase = "resolve_settlement_mode";
		const mode = resolveBillingSettlementMode(input.env);
		context.settlementMode = mode;
		if (mode !== input.request.settlementMode)
			throw new Error("Runtime settlement mode mismatch");
		const now = input.nowMs ?? Date.now();
		phase = "verify_origin";
		const origin =
			input.plane === "remote_runtime"
				? await verifyRuntimeInferenceOrigin({
						secret: input.env.SECRETS_MASTER_KEY ?? "",
						token: input.request.originToken,
						request: (({ originToken: _token, ...projection }) => projection)(
							input.request,
						),
						nowMs: now,
					})
				: null;
		if (origin) {
			context.originKind = origin.kind;
			context.rootClass = origin.root.className;
			context.selectedClass = origin.selected.className;
			context.rootGeneration = origin.root.generation;
			context.selectedGeneration = origin.selected.generation;
		}
		phase = "read_latest_decision";
		const current = origin
			? await latestHistoricalDecision(
					input.db,
					origin.root.owner.orgId,
					origin.root.owner.tediId,
				)
			: null;
		phase = "read_authorization";
		const verified = current
			? await getFiniteExecutionAuthorization(
					input.db,
					origin!.root.owner.orgId,
					origin!.root.owner.tediId,
					current.id,
				)
			: null;
		phase = "prepare_candidate";
		const parsed = FiniteExecutionAuthorizationSchema.safeParse(
			verified?.payload,
		);
		const authorization = parsed.success ? parsed.data : null;
		context.hasFiniteAuthorization = authorization !== null;
		const sendBefore = authorization
			? Math.min(
					now + 600_000,
					now + authorization.input.maxSendDurationSeconds * 1000,
					Date.parse(authorization.input.expiresAt),
					Date.parse(authorization.input.funding.periodEnd),
				)
			: now + 600_000;
		const candidate: NewProviderExecutionAttemptRow = {
			...identity,
			id: crypto.randomUUID(),
			organizationId: input.request.organizationId,
			tediId: input.request.tediId ?? null,
			source: input.request.source,
			runId: input.request.runId ?? null,
			workItemId: input.request.workItemId,
			traceId: input.request.traceId ?? null,
			idempotencyKey: input.request.idempotencyKey,
			settlementMode: mode,
			billingReservationId: mode === "managed" ? crypto.randomUUID() : null,
			deploymentScope: providerDeploymentScope(identity),
			authorizedAt: new Date(now).toISOString(),
			sendBefore: new Date(sendBefore).toISOString(),
		};
		phase = "find_existing";
		const existing = await findProviderExecutionAdmission(
			input.db,
			candidate.organizationId,
			candidate.idempotencyKey,
		);
		if (existing) {
			phase = "validate_original_window";
			// Original persisted IDs and window are the only retry authority; never renew them.
			Object.assign(candidate, {
				id: existing.id,
				billingReservationId: existing.billingReservationId,
				authorizedAt: existing.authorizedAt,
				sendBefore: existing.sendBefore,
			});
			if (Date.parse(existing.sendBefore) <= now)
				throw new Error("Execution admission expired");
		}
		phase = "prepare_native_guard";
		const prepared = origin
			? await prepareProviderExecutionAdmission(
					input.db,
					candidate,
					origin,
					authorization,
				)
			: identity.requestModel === "cloudflare/auto"
				? await prepareKernelAutoRoutingAdmission(candidate)
				: null;
		const execution = prepared?.execution ?? candidate;
		if (existing) {
			phase = "validate_replay_identity";
			assertProviderExecutionMatches(existing, execution);
			phase = "replay_guard_read";
			if (
				prepared &&
				!(await findProviderExecutionAdmission(
					input.db,
					candidate.organizationId,
					candidate.idempotencyKey,
					prepared.guard,
				))
			)
				throw new Error("Native execution policy no longer permits replay");
		}
		const {
			execution: _identity,
			workItemId: _workItem,
			originToken: _originToken,
			...budget
		} = input.request as Omit<AuthorizeRuntimeInferenceInput, "originToken"> & {
			originToken?: string;
		};
		phase = "budget_admission";
		const decision = await authorizeRuntimeBudget({
			...input,
			request: {
				...budget,
				provider: identity.provider,
				model: identity.requestModel,
			},
			execution: mode === "managed" ? execution : undefined,
			executionGuard: prepared?.guard,
		});
		if (!decision.allowed) return decision;
		if (!existing && mode !== "managed") {
			phase = "unmanaged_insert";
			await buildProviderExecutionInsertStatement(
				input.db,
				execution,
				prepared?.guard,
			);
		}
		phase = "final_guarded_read";
		const persisted = await findProviderExecutionAdmission(
			input.db,
			candidate.organizationId,
			candidate.idempotencyKey,
			prepared?.guard,
		);
		if (!persisted) throw new Error("Execution admission was not persisted");
		phase = "validate_persisted_identity";
		assertProviderExecutionMatches(persisted, execution);
		return {
			...decision,
			attributionVersion: 3,
			executionId: persisted.id,
			sendBefore: persisted.sendBefore,
		};
	} catch (error) {
		// Diagnostics must never replace the original financial/admission failure.
		try {
			console.error("[runtime-inference-admission] Failed", {
				phase,
				...context,
				topology: safeExceptionTopology(error),
				...safeErrorClassification(error),
			});
		} catch {
			// Classification and console implementations can themselves throw.
		}
		throw error;
	}
}
