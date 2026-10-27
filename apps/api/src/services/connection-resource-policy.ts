import { getAggregateConnectionSourceTool } from "@tedix/db/queries/app-records";
import { getOrganizationConnectionAllowedResources } from "@tedix/db/queries/connection-instances";
import { resolveConnectionResourceAccess } from "@tedix/api-contract/utils/connection-resource-policy";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { ConnectionInstanceRow } from "@tedix/db/schema/connection-instances";
import { getToolByAppAndToolIdForOrganization } from "@tedix/db/queries/tools";
import { type BaseContext, ErrorCodes, createError } from "../rpc/orpc";

/** Re-read the installed source tool before vault access, including approval replay. */
export async function assertConnectionResourceArguments(
	context: BaseContext,
	instance: Pick<
		ConnectionInstanceRow,
		"organizationId" | "providerId" | "allowedResources"
	>,
	toolUse?: { appId: string; arguments: JsonValue },
): Promise<string> {
	const denied = () => {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Provider call is outside the connection's allowed resources or its target cannot be verified",
		);
	};
	const toolId = context.headers.get("X-Tedix-Mcp-Tool-Id");
	if (!instance.organizationId || !toolUse || !toolId) return denied();
	const source = {
		organizationId: instance.organizationId,
		appId: toolUse.appId,
		toolId,
	};
	const tool =
		(await getToolByAppAndToolIdForOrganization(context.db, source)) ??
		(await getAggregateConnectionSourceTool(context.db, source));
	if (!tool?.enabled) return denied();
	const decision = resolveConnectionResourceAccess({
		allowedResources: instance.allowedResources,
		providerId: instance.providerId,
		config: tool.config,
		arguments: toolUse.arguments,
	});
	if (!decision.allowed || !decision.resourceId) return denied();
	return decision.resourceId;
}

export async function assertOrganizationConnectionResourceArguments(
	context: BaseContext,
	organizationId: string,
	providerId: string,
	toolUse?: { appId: string; arguments: JsonValue },
) {
	const allowedResources = await getOrganizationConnectionAllowedResources(
		context.db,
		organizationId,
		providerId,
	);
	if (allowedResources !== null)
		await assertConnectionResourceArguments(
			context,
			{ organizationId, providerId, allowedResources },
			toolUse,
		);
}
