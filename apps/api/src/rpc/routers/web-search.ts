import { implement } from "@orpc/server";
import { webSearchContract } from "@tedix/api-contract/contracts/web-search";
import {
	resolveWebSearchAccess,
	WebSearchPolicySchema,
	WEB_SEARCH_EXECUTE_SCOPE,
} from "@tedix/api-contract/schemas/web-search";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { insertCallCosts } from "@tedix/db/queries/tedi-usage";
import { getConnectionProviderById } from "@tedix/db/queries/connection-providers";
import { runWebSearch } from "../../services/web-search";
import { resolveCredentialChain } from "./connections/policy-resolution";
import { requireOrgId } from "../org-scope";
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

const search = searchOs.search.handler(async ({ input, context }) => {
	const orgId = requireOrgId(context);
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
	return runWebSearch({
		env: context.env,
		policy: WebSearchPolicySchema.parse(organization.metadata?.webSearch),
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
});

export const webSearchContractRouter = webSearchOs.router({ search });
