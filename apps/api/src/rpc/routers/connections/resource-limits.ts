import {
	getConnectionInstance,
	getOrganizationConnectionAllowedResources,
	setOrganizationConnectionAllowedResources,
	setConnectionAllowedResources,
} from "@tedix/db/queries/connection-instances";
import { AUTHZ, ErrorCodes, createError, withAuthorization } from "../../orpc";
import { requireOrgId } from "../../org-scope";
import { authedOs } from "./policy-resolution";

export const getAllowedResources = authedOs.getAllowedResources
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		if (!input.id)
			return {
				allowedResources: await getOrganizationConnectionAllowedResources(
					context.db,
					organizationId,
					input.providerId,
				),
			};
		const instance = await getConnectionInstance(
			context.db,
			{ organizationId },
			input.id,
			input.providerId,
		);
		if (!instance)
			throw createError(ErrorCodes.NOT_FOUND, "Organization account not found");
		return { allowedResources: instance.allowedResources };
	});

export const setAllowedResources = authedOs.setAllowedResources
	.use(withAuthorization("integrations:manage", "connections.admin"))
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		if (!input.id) {
			const updated = await setOrganizationConnectionAllowedResources(
				context.db,
				organizationId,
				input.providerId,
				input.allowedResources,
			);
			if (!updated)
				throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
			return {
				allowedResources: await getOrganizationConnectionAllowedResources(
					context.db,
					organizationId,
					input.providerId,
				),
			};
		}
		const instance = await getConnectionInstance(
			context.db,
			{ organizationId },
			input.id,
			input.providerId,
		);
		if (!instance)
			throw createError(ErrorCodes.NOT_FOUND, "Organization account not found");
		const [updated] = await setConnectionAllowedResources(
			context.db,
			organizationId,
			input.id,
			input.providerId,
			input.allowedResources,
		);
		if (!updated)
			throw createError(ErrorCodes.NOT_FOUND, "Organization account not found");
		return { allowedResources: updated.allowedResources };
	});
