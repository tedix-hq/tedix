import { implement } from "@orpc/server";
import { webSearchContract } from "@tedix/api-contract/contracts/web-search";
import { resolveWebSearchAccess } from "@tedix/api-contract/schemas/web-search";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { insertCallCosts } from "@tedix/db/queries/tedi-usage";
import { runGatewayWebSearch } from "../../services/web-search";
import { requireOrgId } from "../org-scope";
import {
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withAuthorization,
} from "../orpc";

const webSearchOs = implement(webSearchContract).$context<BaseContext>();
const searchOs = webSearchOs.use(withAuth).use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"Web search runs only for the calling tedi, verified inside the caller's organization",
		},
		"connections.execute",
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
	return runGatewayWebSearch({
		env: context.env,
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
