import {
	getConnectionConsumerGrants,
	setConnectionConsumerGrants,
} from "@tedix/db/queries/organizations";
import { getConnectionInstance } from "@tedix/db/queries/connection-instances";
import {
	getPersonalConnectionConsumerGrants,
	setPersonalConnectionConsumerGrants,
} from "@tedix/db/queries/personal-connection-grants";
import {
	type BaseContext,
	AUTHZ,
	ErrorCodes,
	createError,
	userHoldsPermission,
	withAuthorization,
} from "../../orpc";
import { requireOrgId } from "../../org-scope";
import { authedOs } from "./policy-resolution";

function personalOwner(context: BaseContext) {
	if (context.authType !== "user" || context.tediId || !context.userId)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only the person can choose who uses their personal connection",
		);
	return context.userId;
}

export const getConsumerGrants = authedOs.getConsumerGrants
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) =>
		input.scope === "user"
			? getPersonalConnectionConsumerGrants(
					context.db,
					personalOwner(context),
					requireOrgId(context),
					input.providerId,
					input.connectionInstanceId,
				)
			: getConnectionConsumerGrants(
					context.db,
					requireOrgId(context),
					input.providerId,
					input.connectionInstanceId,
				),
	);

export const setConsumerGrants = authedOs.setConsumerGrants
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Personal policies require the authenticated owner; organization policies require integrations:manage",
			},
			"connections.admin",
		),
	)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		if (input.scope === "user") {
			const userId = personalOwner(context);
			if (
				input.connectionInstanceId &&
				!(await getConnectionInstance(
					context.db,
					{ userId: context.descopeUserId ?? context.user!.sub! },
					input.connectionInstanceId,
					input.providerId,
				))
			)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Personal connection account not found",
				);
			const row = await setPersonalConnectionConsumerGrants(
				context.db,
				userId,
				organizationId,
				input.providerId,
				input.policy,
				input.connectionInstanceId,
			);
			if (!row)
				throw createError(ErrorCodes.NOT_FOUND, "Connection owner not found");
			return { success: true as const };
		}
		if (
			context.authType === "user" &&
			!userHoldsPermission(context, "integrations:manage")
		)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Insufficient permissions. Required: integrations:manage",
			);
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
