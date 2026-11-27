import type { DbQueryClient } from "@tedix/db/query-client";
import type { CoreStoreEnv } from "@tedix/db/core-store/client";
import { coreQueryDb } from "@tedix/db/core-store/scope";
import { getOrganizationResidencyPolicy } from "@tedix/db/queries/data-residency";
import { DataResidencyError } from "./data-residency";

const checks = new WeakMap<object, () => Promise<void>>();

export async function requireUnrestrictedModelEgress(
	db: DbQueryClient,
	organizationId: string,
	operation: string,
	binding?: D1Database,
): Promise<void> {
	if (!organizationId.trim())
		throw new DataResidencyError(
			"RESIDENCY_POLICY_UNAVAILABLE",
			"Organization attribution is required before model processing. No model request was sent.",
		);
	let policy;
	try {
		policy = await getOrganizationResidencyPolicy(
			binding ? coreQueryDb({ DB: binding }) : db,
			organizationId,
		);
	} catch {
		throw new DataResidencyError(
			"RESIDENCY_POLICY_UNAVAILABLE",
			"Data residency could not be checked. No model request was sent.",
		);
	}
	if (policy && policy.mode !== "unrestricted")
		throw new DataResidencyError(
			"EU_PROVIDER_ROUTE_REQUIRED",
			`This organization requires EU model processing. ${operation} has no verified regional adapter yet and is blocked. An administrator must configure a supported EU provider route before using this feature.`,
		);
}

/** Bind legacy model helpers to their actual organization without changing shared Worker env. */
export function organizationModelEnv<
	T extends CoreStoreEnv & {
		AI?: unknown;
		AI_GATEWAY_ACCOUNT_ID?: string;
		TEDIX_BILLING_SETTLEMENT_MODE?: string;
	},
>(
	env: T,
	db: DbQueryClient,
	organizationId: string,
	options: {
		onDispatch?: () => void;
		billWorkersAiSurface?: string | readonly string[];
	} = {},
): T {
	const check = () =>
		requireUnrestrictedModelEgress(
			env.CORE_STORE || "DB" in env ? coreQueryDb(env) : db,
			organizationId,
			"This auxiliary model feature",
		);
	const scoped = { ...env };
	checks.set(scoped, check);
	if (env.AI && typeof env.AI === "object") {
		scoped.AI = new Proxy(env.AI, {
			get(target, property) {
				const value = Reflect.get(target, property, target);
				if (property === "run" && typeof value === "function")
					return async (model: string, body: unknown, request?: AiOptions) => {
						await check();
						request?.signal?.throwIfAborted();
						const configured = options.billWorkersAiSurface;
						const requested = request?.gateway?.metadata?.surface;
						const source =
							typeof configured === "string"
								? configured
								: configured?.find((surface) => surface === requested);
						if (
							source &&
							env.TEDIX_BILLING_SETTLEMENT_MODE === "managed" &&
							(!request?.gateway ||
								request.gateway.metadata?.surface === source)
						) {
							const gateway = request?.gateway;
							const gatewayAccountId = env.AI_GATEWAY_ACCOUNT_ID?.trim();
							if (!gateway?.id || !gatewayAccountId)
								throw new Error(
									"Workers AI credit admission requires a gateway and account",
								);
							const { reserveKernelBilling, kernelRegionalExecution } =
								await import("../rpc/routers/kernel/billing-reservation");
							const { kernelGatewayMetadata } =
								await import("../rpc/routers/kernel/gateway-attribution");
							const admitted = await reserveKernelBilling(env, {
								context: { organizationId, source },
								source: "system",
								execution: {
									provider: "workers-ai",
									requestModel: model,
									gatewayAccountId,
									gatewayId: gateway.id,
									transportKind: "workers-ai-binding",
									apiKind: "workers-ai-chat",
									providerResource: null,
									providerOrigin: null,
									deployment: null,
								},
								body: JSON.stringify(body),
							});
							if (kernelRegionalExecution(admitted))
								throw new Error(
									"This Workers AI call has no regional provider route",
								);
							request = {
								...request,
								gateway: {
									...gateway,
									metadata: kernelGatewayMetadata(admitted),
								},
							};
						}
						request?.signal?.throwIfAborted();
						options.onDispatch?.();
						return value.call(target, model, body, request);
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}
	return scoped;
}

export async function assertModelEgressAllowed(env: object): Promise<void> {
	await checks.get(env)?.();
}
