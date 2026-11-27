import { isD1CoreStore } from "@tedix/db/core-store/scope";
import { baseErrorConstructors } from "@tedix/api-contract/errors";
import { requireUnrestrictedModelEgress } from "../../services/unrouted-model-egress";
import { DataResidencyError } from "../../services/data-residency";
import { implement } from "@orpc/server";
import { runtimeEntitlementsContract } from "@tedix/api-contract/contracts/runtime-entitlements";
import { getEffectiveInferencePolicies } from "@tedix/db/queries/billing/inference-policies";
import {
	getRuntimeEntitlement,
	runtimeEntitlementIsActive,
} from "@tedix/db/queries/runtime-entitlements";
import { resolveBillingSettlementMode } from "../../lib/billing-settlement-mode";
import { resolveAiGatewayAdmissionPolicy } from "../../services/ai-gateway-admission-policy";
import { authorizeRuntimeInference } from "../../services/runtime-entitlement-admission";
import { withOrg } from "../org-scope";
import { AUTHZ, type BaseContext, withAuth, withServiceAuth } from "../orpc";

const os = implement(runtimeEntitlementsContract).$context<BaseContext>();

const get = os.get
	.use(withAuth)
	.use(AUTHZ.osRead)
	.use(withOrg)
	.handler(async ({ context }) => {
		const organizationId = context.organizationId;
		const entitlement = await getRuntimeEntitlement(context.db, organizationId);
		const policySources = await getEffectiveInferencePolicies(
			context.db,
			organizationId,
		);
		const modelPolicy = policySources
			? (resolveAiGatewayAdmissionPolicy(policySources).organization ?? null)
			: null;
		return {
			entitlement:
				entitlement === null
					? null
					: {
							planKey: entitlement.profile.key,
							planName: entitlement.profile.name,
							status: entitlement.status,
							periodStart: entitlement.effectivePeriod.startsAt,
							periodEnd: entitlement.effectivePeriod.endsAt,
							active: runtimeEntitlementIsActive(entitlement, Date.now()),
							settlementMode: resolveBillingSettlementMode(context.env),
							source: entitlement.source,
							version: entitlement.version,
						},
			modelPolicy,
		};
	});

const getEffective = os.getEffective
	.use(withAuth)
	.use(AUTHZ.billingRead)
	.use(withOrg)
	.handler(async ({ context }) => {
		const entitlement = await getRuntimeEntitlement(
			context.db,
			context.organizationId,
		);
		if (!entitlement) {
			throw baseErrorConstructors.NOT_FOUND({
				message: "Runtime entitlement is not configured",
			});
		}
		return entitlement;
	});

const authorizeInference = os.authorizeInference
	.use(withServiceAuth)
	.handler(({ context, input }) =>
		authorizeRuntimeInference({
			db: context.db,
			env: context.env,
			request: input,
			plane: "remote_runtime",
		}),
	);

const checkModelEgress = os.checkModelEgress
	.use(withServiceAuth)
	.handler(async ({ context, input }) => {
		try {
			await requireUnrestrictedModelEgress(
				context.db,
				input.organizationId,
				input.operation,
				isD1CoreStore(context.env) ? context.env.DB : undefined,
			);
			return { allowed: true };
		} catch (error) {
			if (error instanceof DataResidencyError)
				return { allowed: false, message: error.message };
			throw error;
		}
	});

export const runtimeEntitlementsContractRouter = os.router({
	checkModelEgress,
	get,
	getEffective,
	authorizeInference,
});
