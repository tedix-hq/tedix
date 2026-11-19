import { implement } from "@orpc/server";
import { webSearchContract } from "@tedix/api-contract/contracts/web-search";
import {
	resolveWebSearchAccess,
	WebSearchPolicySchema,
	WEB_SEARCH_EXECUTE_SCOPE,
} from "@tedix/api-contract/schemas/web-search";
import {
	type BillingServiceCreditDenialCode,
	releaseBillingServiceCreditReservation,
	reserveBillingServiceCredits,
	settleBillingServiceCreditUsage,
} from "@tedix/db/queries/billing-service-credits";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { insertCallCosts } from "@tedix/db/queries/tedi-usage";
import { getConnectionProviderById } from "@tedix/db/queries/connection-providers";
import { runWebSearch } from "../../services/web-search";
import { resolveCredentialChain } from "./connections/policy-resolution";
import { withOrg } from "../org-scope";
import {
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withAuthorization,
} from "../orpc";

const webSearchOs = implement(webSearchContract).$context<BaseContext>();
// Machine plane: the dedicated scope the tedi runtime delegates over its
// service binding (`TEDI_RUNTIME_SERVICE_BINDING_SCOPES`). Human plane: no
// person calls this; the handler refuses every caller without a tedi identity.
const searchOs = webSearchOs.use(withAuth).use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"Web search runs only for the calling tedi, verified inside the caller's organization",
		},
		WEB_SEARCH_EXECUTE_SCOPE,
	),
);

/**
 * USD micros recorded as the provider cost of one search. Search providers do
 * not report a cost per call; a basic Tavily search costs USD 0.008.
 */
const WEB_SEARCH_PROVIDER_COST_MICROS = 8_000;

/** Why a search was not admitted, in words the tedi can pass on. */
export function webSearchCreditMessage(
	code: BillingServiceCreditDenialCode,
): string {
	switch (code) {
		case "monthly_credit_limit_reached":
			return "This month's Tedix credits are used up. An admin can buy a top-up or turn on pay-as-you-go.";
		case "tedi_monthly_credit_cap_reached":
			return "This tedi reached the monthly credit cap an admin set for it.";
		case "member_monthly_credit_cap_reached":
			return "The monthly credit cap an admin set was reached.";
		case "service_disabled":
			return "Web search is turned off for this organization.";
		case "service_monthly_credit_limit":
		case "service_tedi_credit_limit":
			return "The monthly web search credit limit was reached.";
		case "provider_cost_limit":
			return "The organization's web search spending limit was reached.";
		case "rate_card_unavailable":
			return "Web search pricing is temporarily unavailable.";
		default:
			return "Web search is not available for this organization's billing account.";
	}
}

const search = searchOs.search
	.use(withOrg)
	.handler(async ({ input, context }) => {
		const orgId = context.organizationId;
		const tediId = context.tediId;
		if (!tediId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Web search runs for a tedi credential only",
			);
		}
		const [tedi, organization] = await Promise.all([
			getTediByIdForOrganization(context.db, tediId, orgId),
			getOrganizationById(context.db, orgId),
		]);
		if (!tedi || tedi.retiredAt !== null || !organization) {
			throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
		}
		const access = resolveWebSearchAccess({
			organization: organization.metadata?.webSearch,
			tediPolicy: tedi.toolPolicy?.webSearch,
			runtimeTools: tedi.toolPolicy?.runtimeTools,
		});
		if (!access.enabled) {
			return {
				status: "disabled" as const,
				message: "Web search is not enabled for this tedi.",
			};
		}
		// Managed billing charges each search the web_search rate card's credits
		// from the organization pool: reserved before the provider call, drawn
		// when it returns results, released when it does not.
		const managed = context.env.TEDIX_BILLING_SETTLEMENT_MODE === "managed";
		const nowMs = Date.now();
		const reservationId = crypto.randomUUID();
		if (managed) {
			const decision = await reserveBillingServiceCredits(context.db, {
				id: reservationId,
				organizationId: orgId,
				tediId,
				serviceKey: "web_search",
				operationKey: "search",
				idempotencyKey: `web-search:${reservationId}`,
				expiresAt: new Date(nowMs + 10 * 60 * 1_000).toISOString(),
				metadata: { runId: input.runId ?? null },
				now: new Date(nowMs).toISOString(),
			});
			if (!decision.allowed)
				return {
					status: "unavailable" as const,
					message: webSearchCreditMessage(decision.code),
				};
		}
		const policy = WebSearchPolicySchema.parse(
			organization.metadata?.webSearch,
		);
		const runSearch = () =>
			runWebSearch({
				env: context.env,
				policy,
				resolveCredential: async (provider) => {
					if (!organization.descopeTenantId) return null;
					const registered = await getConnectionProviderById(
						context.db,
						`${provider}-api-key`,
					);
					if (!registered?.descopeAppId) return null;
					const credential = await resolveCredentialChain(context, {
						organizationId: orgId,
						descopeTenantId: organization.descopeTenantId,
						providerId: registered.descopeAppId,
						scope: "tenant",
					});
					return credential.accessToken;
				},
				query: input.query,
				limit: Math.min(input.limit ?? access.maxResults, access.maxResults),
				organizationId: orgId,
				tediId,
				runId: input.runId ?? null,
				recordReceipt: async (row) => {
					await insertCallCosts(context.db, [row]);
				},
			});
		let result: Awaited<ReturnType<typeof runWebSearch>>;
		try {
			result = await runSearch();
		} catch (error) {
			if (managed)
				await releaseBillingServiceCreditReservation(context.db, {
					reservationId,
					organizationId: orgId,
					reason: "search_threw",
					now: new Date().toISOString(),
				});
			throw error;
		}
		if (!managed) return result;
		try {
			const now = new Date().toISOString();
			if (result.status === "ok")
				await settleBillingServiceCreditUsage(context.db, {
					id: crypto.randomUUID(),
					reservationId,
					organizationId: orgId,
					tediId,
					providerUsageId: `web-search:${reservationId}`,
					provider: policy.provider ?? "ai-gateway",
					model: "web-search",
					providerCostMicros: WEB_SEARCH_PROVIDER_COST_MICROS,
					providerCostQuality: "estimated",
					providerSucceeded: true,
					occurredAt: now,
					metadata: { runId: input.runId ?? null },
					now,
				});
			else
				await releaseBillingServiceCreditReservation(context.db, {
					reservationId,
					organizationId: orgId,
					reason: `search_${result.status}`,
					now,
				});
		} catch (error) {
			// The search already ran; an unsettled hold expires on its own.
			console.error("[web-search] credit settlement failed", {
				organizationId: orgId,
				reservationId,
				message: error instanceof Error ? error.message : String(error),
			});
		}
		return result;
	});

export const webSearchContractRouter = webSearchOs.router({ search });
