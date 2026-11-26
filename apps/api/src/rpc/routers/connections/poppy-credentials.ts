import { getAppByIdForOrganization } from "@tedix/db/queries/app-records";
import { McpConfigSchema } from "@tedix/api-contract/schemas/app";
import { PoppyProviderToolConfigSchema } from "@tedix/api-contract/schemas/connections";
import { getToolByAppAndToolIdForOrganization } from "@tedix/db/queries/tools";
import {
	getOrganizationById,
	isOrganizationOffboarding,
} from "@tedix/db/queries/organizations";
import { createError, ErrorCodes, withServiceAuth } from "../../orpc";
import { connectionsOs, resolveCredentialChain } from "./policy-resolution";

export const fetchPoppyToken = connectionsOs.fetchPoppyToken
	.use(withServiceAuth)
	.handler(async ({ context, input }) => {
		const denied = () => {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"This Poppy app is not allowed to use the organization connection",
			);
		};
		// The MCP edge stamps this only after this request's Session check passes.
		if (
			context.serviceBindingPrincipal !== "mcp-edge" ||
			context.headers.get("X-Tedix-Auth-Poppy-App-Id") !== input.appId ||
			context.headers.get("X-Tedix-Org-Id") !== input.organizationId ||
			context.headers.get("X-Tedix-Mcp-Tool-Id") !== input.toolId
		)
			return denied();
		const app = await getAppByIdForOrganization(
			context.db,
			input.appId,
			input.organizationId,
		);
		const config = McpConfigSchema.safeParse(app?.metadata?.mcpConfig);
		const allowance = config.success ? config.data.poppyConnection : undefined;
		if (
			!app ||
			app.visibility === "disabled" ||
			app.metadata?.mcpConfig?.authMode !== "public" ||
			!allowance ||
			allowance.providerId !== input.providerId ||
			allowance.mcpServerUrl !== input.mcpServerUrl ||
			allowance.tools[input.toolId] !== input.mcpToolName ||
			allowance.connectionInstanceId !== input.connectionInstanceId
		)
			return denied();
		const tool = await getToolByAppAndToolIdForOrganization(context.db, input);
		const providerConfig = PoppyProviderToolConfigSchema.safeParse(
			tool?.config,
		);
		if (!providerConfig.success) return denied();
		const auth = providerConfig.data.auth;
		// Only this app's installed provider tools qualify, never aggregate or RPC tools.
		if (
			!tool?.enabled ||
			providerConfig.data.mcpServerUrl !== input.mcpServerUrl ||
			providerConfig.data.mcpToolName !== input.mcpToolName ||
			auth.connectionId !== input.providerId ||
			(auth.credentialScope ?? auth.scope ?? "tenant") !== "tenant" ||
			auth.connectionInstanceId !== input.connectionInstanceId
		)
			return denied();
		const org = await getOrganizationById(context.db, input.organizationId);
		if (
			!org?.descopeTenantId ||
			!org.features?.os ||
			isOrganizationOffboarding(org.metadata)
		)
			return denied();
		return resolveCredentialChain(context, {
			organizationId: org.id,
			descopeTenantId: org.descopeTenantId,
			providerId: input.providerId,
			connectionInstanceId: input.connectionInstanceId,
			scope: "tenant",
			scopes: auth.scopes,
			delegatedToolUse: { appId: input.appId, arguments: input.arguments },
		});
	});
