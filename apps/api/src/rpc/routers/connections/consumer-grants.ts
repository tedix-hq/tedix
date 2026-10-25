import {
	getConnectionConsumerGrants,
	setConnectionConsumerGrants,
} from "@tedix/db/queries/organizations";
import { getConnectionInstance } from "@tedix/db/queries/connection-instances";
import { AUTHZ, ErrorCodes, createError, withAuthorization } from "../../orpc";
import { requireOrgId } from "../../org-scope";
import { authedOs } from "./policy-resolution";

export const getConsumerGrants = authedOs.getConsumerGrants
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) =>
		getConnectionConsumerGrants(
			context.db,
			requireOrgId(context),
			input.providerId,
			input.connectionInstanceId,
		),
	);

export const setConsumerGrants = authedOs.setConsumerGrants
	.use(withAuthorization("integrations:manage", "connections.admin"))
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		if (
			input.connectionInstanceId &&
			!(await getConnectionInstance(
				context.db,
				{ organizationId },
				input.connectionInstanceId,
				input.providerId,
			))
		)
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Organization connection account not found",
			);
		const row = await setConnectionConsumerGrants(
			context.db,
			organizationId,
			input.providerId,
			input.policy,
			input.connectionInstanceId,
		);
		if (!row) throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		return { success: true as const };
	});
