import { implement } from "@orpc/server";
import { webPushContract } from "@tedix/api-contract/contracts/web-push";
import { WebPushPreferencesSchema } from "@tedix/api-contract/schemas/web-push";
import {
	deletePushConfig,
	listPushConfigs,
	savePushConfig,
} from "@tedix/db/queries/web-push";
import { getProjectByIdForOrganization } from "@tedix/db/queries/projects";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { pushEndpointKey, webPushKeys } from "../../services/web-push";
import {
	AUTHZ,
	withAuth,
	createError,
	ErrorCodes,
	type BaseContext,
} from "../orpc";
import { requireOrgId } from "../org-scope";

const os = implement(webPushContract)
	.$context<BaseContext>()
	.use(withAuth)
	.use(AUTHZ.osRead);
function userScope(context: BaseContext) {
	if (
		context.authType !== "user" ||
		!context.userId ||
		context.externalAgentPrincipalId
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Push settings require a person signed in to Tedix OS",
		);
	return { organizationId: requireOrgId(context), userId: context.userId };
}
export const webPushRouter = os.router({
	getStatus: os.getStatus.handler(async ({ context }) => {
		const scope = userScope(context);
		const keys = webPushKeys(context.env);
		const parsed = WebPushPreferencesSchema.safeParse(
			(await listPushConfigs(context.db, scope, "preferences"))[0]?.value,
		);
		return {
			enabled: !!keys,
			publicKey: keys?.publicKey ?? null,
			preferences: parsed.success ? parsed.data : { mutedProjectIds: [] },
		};
	}),
	subscribe: os.subscribe.handler(async ({ context, input }) => {
		const scope = userScope(context);
		if (!webPushKeys(context.env)) return { enabled: false };
		const key = await pushEndpointKey(input.endpoint);
		const current = await listPushConfigs(context.db, scope, "subscription:");
		if (current.length >= 10 && !current.some((row) => row.key === key))
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Remove an old push device first",
			);
		await savePushConfig(context.db, scope, key, {
			...input,
			expirationTime: input.expirationTime ?? null,
		});
		return { enabled: true };
	}),
	unsubscribe: os.unsubscribe.handler(async ({ context, input }) => {
		await deletePushConfig(
			context.db,
			userScope(context),
			await pushEndpointKey(input.endpoint),
		);
		return { ok: true as const };
	}),
	setPreferences: os.setPreferences.handler(async ({ context, input }) => {
		const scope = userScope(context);
		for (const id of input.mutedProjectIds) {
			if (
				!(await getProjectByIdForOrganization(
					context.db,
					scope.organizationId,
					id,
				))
			)
				throw createError(ErrorCodes.NOT_FOUND, "Project not found");
		}
		for (const id of input.mutedWorkspaceIds ?? []) {
			if (
				!(await getOsWorkspace(context.db, {
					organizationId: scope.organizationId,
					workspaceId: id,
				}))
			)
				throw createError(ErrorCodes.NOT_FOUND, "Workspace not found");
		}
		const current = WebPushPreferencesSchema.safeParse(
			(await listPushConfigs(context.db, scope, "preferences"))[0]?.value,
		);
		const preferences = {
			mutedProjectIds: input.mutedProjectIds,
			mutedWorkspaceIds:
				input.mutedWorkspaceIds ??
				(current.success ? (current.data.mutedWorkspaceIds ?? []) : []),
		};
		await savePushConfig(context.db, scope, "preferences", preferences);
		return preferences;
	}),
	setVisibility: os.setVisibility.handler(async ({ context, input }) => {
		const scope = userScope(context);
		const key = `visible:${input.clientId}`;
		if (input.conversationId)
			await savePushConfig(context.db, scope, key, {
				conversationId: input.conversationId,
			});
		else await deletePushConfig(context.db, scope, key);
		return { ok: true as const };
	}),
});
