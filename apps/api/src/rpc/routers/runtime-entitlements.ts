import { implement, ORPCError } from "@orpc/server";
import { runtimeEntitlementsContract } from "@tedix/api-contract/contracts/runtime-entitlements";
import { getEffectiveInferencePolicies } from "@tedix/db/queries/billing/inference-policies";
import {
	getRuntimeEntitlement,
	runtimeEntitlementIsActive,
} from "@tedix/db/queries/runtime-entitlements";
import { resolveBillingSettlementMode } from "../../lib/billing-settlement-mode";
import { resolveAiGatewayAdmissionPolicy } from "../../services/ai-gateway-admission-policy";
import { authorizeRuntimeInference } from "../../services/runtime-entitlement-admission";
import { requireOrgId } from "../org-scope";
import { AUTHZ, type BaseContext, withAuth, withServiceAuth } from "../orpc";

const os = implement(runtimeEntitlementsContract).$context<BaseContext>();

const get = os.get
	.use(withAuth)
	.use(AUTHZ.osRead)
	.handler(async ({ context }) => {
		const organizationId = requireOrgId(context);
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
	.handler(async ({ context }) => {
		const entitlement = await getRuntimeEntitlement(
			context.db,
			requireOrgId(context),
		);
		if (!entitlement) {
			throw new ORPCError("NOT_FOUND", {
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

export const runtimeEntitlementsContractRouter = os.router({
	get,
	getEffective,
	authorizeInference,
});
