import { osAudit } from "../os-audit";
import { WEB_PUSH_AUDIT } from "../settings-audit";
import { implement } from "@orpc/server";
import { webPushContract } from "@tedix/api-contract/contracts/web-push";
import { WebPushPreferencesSchema } from "@tedix/api-contract/schemas/web-push";
import {
	deletePushConfig,
	deletePushConfigs,
	listPushConfigs,
	listPushSubscriptionKeys,
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

// Each person keeps their newest devices; older ones stop receiving pushes.
export const PUSH_DEVICE_CAP = 10;
// New devices one person may add per window; refreshing a known device is free.
export const PUSH_SUBSCRIBE_LIMIT = 5;
export const PUSH_SUBSCRIBE_WINDOW_MS = 10 * 60_000;
const webPushOs = implement(webPushContract).$context<BaseContext>();
const os = webPushOs
	.use(withAuth)
	.use(AUTHZ.osRead)
	.use(osAudit(WEB_PUSH_AUDIT));
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
export const webPushRouter = webPushOs.router({
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
		const current = await listPushSubscriptionKeys(context.db, scope);
		const since = new Date(Date.now() - PUSH_SUBSCRIBE_WINDOW_MS).toISOString();
		const known = current.some((row) => row.key === key);
		const recent = current.filter((row) => (row.createdAt ?? "") > since);
		if (!known && recent.length >= PUSH_SUBSCRIBE_LIMIT)
			throw createError(
				ErrorCodes.TOO_MANY_REQUESTS,
				"Too many push devices registered recently. Try again later.",
			);
		await savePushConfig(context.db, scope, key, {
			...input,
			expirationTime: input.expirationTime ?? null,
		});
		const older = current.filter((row) => row.key !== key);
		await deletePushConfigs(
			context.db,
			scope,
			older.slice(PUSH_DEVICE_CAP - 1).map((row) => row.key),
		);
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
