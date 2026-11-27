import { call } from "@orpc/server";
import { isTenantGrantablePermission } from "@tedix/auth/rbac";
import {
	type AppOperations,
	WorkspaceListAppOperationsSchema,
	WorkspaceRunAppOperationSchema,
} from "@tedix/api-contract/schemas/workspace-app-operation";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { createContext } from "../rpc/context";

/**
 * The sender's own context for the app runtime procedures, which still derive
 * and enforce workspace access, app grants and the run receipt themselves.
 */
async function senderContext(
	env: CloudflareEnv,
	request: { organizationId: string; userId: string; turnId: string },
) {
	const context = createContext(
		new Request("https://api.internal/workspace-app-operation"),
		env,
	);
	const member = await getMemberByUserId(
		context.db,
		request.organizationId,
		request.userId,
	);
	if (
		member?.status !== "active" ||
		member.kind === "external_agent" ||
		member.kind === "browser_agent"
	)
		throw new Error("An active person must send the turn to use app steps");
	context.organizationId = request.organizationId;
	context.authType = "user";
	context.user = {
		sub: request.userId,
		iss: "workspace-store",
		aud: "api.internal",
		iat: 0,
		exp: 0,
	};
	context.userRole = member.role;
	context.userPermissionOverrides = (member.customPermissions ?? []).filter(
		isTenantGrantablePermission,
	);
	context.workspaceAgentTurnId = request.turnId;
	const { createOsAppRuntimeRouter } =
		await import("../rpc/routers/os-app-runtime");
	return { context, router: createOsAppRuntimeRouter() };
}

/** The steps an app declares, read as the person who sent the turn. */
export async function listWorkspaceAppOperations(
	env: CloudflareEnv,
	input: unknown,
): Promise<AppOperations> {
	const request = WorkspaceListAppOperationsSchema.parse(input);
	const { context, router } = await senderContext(env, request);
	const result = await call(
		router.listOperations,
		{ workspaceId: request.workspaceId, gadgetId: request.appId },
		{ context },
	);
	return { appId: request.appId, ...result };
}

/** Runs one declared step as the person who sent the turn. */
export async function runWorkspaceAppOperation(
	env: CloudflareEnv,
	input: unknown,
) {
	const request = WorkspaceRunAppOperationSchema.parse(input);
	const { context, router } = await senderContext(env, request);
	const scope = { workspaceId: request.workspaceId, gadgetId: request.appId };
	const opened = await call(router.open, scope, { context });
	return call(
		router.invokeOperation,
		{
			...scope,
			session: opened.session,
			name: request.name,
			input: request.input,
		},
		{ context },
	);
}
