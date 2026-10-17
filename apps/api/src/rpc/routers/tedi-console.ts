import { implement } from "@orpc/server";
import { tediConsoleContract } from "@tedix/api-contract/contracts/tedi-console";
import {
	mintTediConsoleSession,
	TEDI_CONSOLE_SESSION_TTL_SECONDS,
} from "@tedix/auth/tedi-console-session";
import { validateToken } from "@tedix/auth/jwt";
import {
	getTediConsoleGrant,
	setTediConsoleGrant,
} from "@tedix/db/queries/tedi-console";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { listOsOutputs } from "@tedix/db/queries/os-workspaces/outputs";
import { extractBearerToken } from "@tedix/worker-kit/request-auth";
import {
	AUTHZ,
	withAuthorization,
	withAuth,
	type BaseContext,
	createError,
	ErrorCodes,
} from "../orpc";
import { requireOrgId } from "../org-scope";
import { emitAuditEvent } from "../audit-helpers";
import { requireWorkspace } from "./os-workspaces-shared";
const os = implement(tediConsoleContract).$context<BaseContext>().use(withAuth);
const admin = os.use(withAuthorization("settings:manage", "mcp:tedis.admin"));
async function requireHumanAdmin(context: BaseContext) {
	const organizationId = requireOrgId(context);
	if (
		context.authType !== "user" ||
		!context.user?.sub ||
		context.tediId ||
		context.externalAgentPrincipalId ||
		context.user.entityType === "tedi"
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"A human organization administrator must grant console access",
		);
	const member = await getMemberByUserId(
		context.db,
		organizationId,
		context.user.sub,
	);
	if (
		member?.status !== "active" ||
		!["owner", "admin", "tenant-admin"].includes(member.role)
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Active organization administrator required",
		);
	return { organizationId, actorId: member.userId ?? context.user.sub };
}
async function requireTedi(context: BaseContext, tediId: string) {
	const tedi = await getTediByIdForOrganization(
		context.db,
		tediId,
		requireOrgId(context),
	);
	if (!tedi || tedi.retiredAt)
		throw createError(ErrorCodes.NOT_FOUND, "Active tedi not found");
	return tedi;
}
const getGrant = admin.getGrant.handler(async ({ context, input }) => {
	const { organizationId } = await requireHumanAdmin(context);
	await requireTedi(context, input.tediId);
	const grant = await getTediConsoleGrant(
		context.db,
		organizationId,
		input.tediId,
	);
	return {
		enabled: grant?.enabled ?? false,
		workspaceIds: grant?.workspaceIds ?? [],
	};
});
const setGrant = admin.setGrant.handler(async ({ context, input }) => {
	const { organizationId, actorId } = await requireHumanAdmin(context);
	await requireTedi(context, input.tediId);
	const workspaceIds = input.enabled ? [...new Set(input.workspaceIds)] : [];
	if (input.enabled && !workspaceIds.length)
		throw createError(ErrorCodes.BAD_REQUEST, "Choose at least one Workspace");
	// A human may delegate only Workspaces they can themselves open.
	for (const workspaceId of workspaceIds)
		await requireWorkspace(context, workspaceId);
	const grant = await setTediConsoleGrant(context.db, {
		organizationId,
		tediId: input.tediId,
		enabled: input.enabled,
		workspaceIds,
		revision: crypto.randomUUID(),
		grantedBy: actorId,
		updatedAt: new Date().toISOString(),
	});
	await emitAuditEvent(context.db, {
		organizationId,
		actorId,
		actorType: "user",
		action: "tedi.console.grant.updated",
		resourceType: "tedi",
		resourceId: input.tediId,
		metadata: { enabled: input.enabled, workspaceIds },
	});
	return { enabled: grant.enabled, workspaceIds: grant.workspaceIds };
});
const createSession = os.createSession
	.use(AUTHZ.tedisRead)
	.handler(async ({ context }) => {
		if (
			context.authType !== "tedi" ||
			!context.tediId ||
			!context.descopeUserId
		)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Existing tedi identity required",
			);
		const organizationId = requireOrgId(context);
		const tedi = await requireTedi(context, context.tediId);
		if (
			tedi.status !== "active" ||
			tedi.descopeUserId !== context.descopeUserId
		)
			throw createError(ErrorCodes.FORBIDDEN, "Tedi identity mismatch");
		const grant = await getTediConsoleGrant(
			context.db,
			organizationId,
			tedi.id,
		);
		if (!grant?.enabled || !grant.workspaceIds.length)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Console access has not been granted",
			);
		const token = extractBearerToken(context.headers.get("Authorization"));
		if (!token)
			throw createError(ErrorCodes.UNAUTHORIZED, "Tedi bearer token required");
		const payload = await validateToken(token, {
			projectId: context.env.DESCOPE_PROJECT_ID,
			baseUrl: context.env.DESCOPE_BASE_URL,
			allowTediJwt: true,
		});
		const expiresAt = Math.min(
			Math.floor(Date.now() / 1000) + TEDI_CONSOLE_SESSION_TTL_SECONDS,
			payload.exp ?? 0,
		);
		const sessionToken = await mintTediConsoleSession(
			context.env.SECRETS_MASTER_KEY,
			{ tediId: tedi.id, organizationId, grantRevision: grant.revision },
			expiresAt,
		);
		await emitAuditEvent(context.db, {
			organizationId,
			actorId: tedi.id,
			actorType: "tedi",
			action: "tedi.console.session.created",
			resourceType: "tedi",
			resourceId: tedi.id,
			metadata: { expiresAt, workspaceIds: grant.workspaceIds },
		});
		return { sessionToken, expiresAt };
	});
const read = os.read.use(AUTHZ.osRead).handler(async ({ context, input }) => {
	if (
		context.authType !== "tedi" ||
		!context.tediId ||
		!context.tediConsoleWorkspaceIds
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Restricted console session required",
		);
	const organizationId = requireOrgId(context);
	const tedi = await requireTedi(context, context.tediId);
	const ids = context.tediConsoleWorkspaceIds;
	if (input.workspaceId && !ids.includes(input.workspaceId))
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Workspace is outside the console grant",
		);
	const workspaces = [];
	for (const workspaceId of ids) {
		const workspace = await getOsWorkspace(context.db, {
			organizationId,
			workspaceId,
		});
		if (workspace)
			workspaces.push({
				id: workspace.id,
				name: workspace.name,
				description: workspace.description,
			});
	}
	const outputs = input.workspaceId
		? await listOsOutputs(
				context.db,
				organizationId,
				{ userIds: [], workspaceIds: ids },
				{ workspaceId: input.workspaceId },
			)
		: [];
	await emitAuditEvent(context.db, {
		organizationId,
		actorId: tedi.id,
		actorType: "tedi",
		action: "tedi.console.read",
		resourceType: "workspace",
		resourceId: input.workspaceId,
		metadata: { readOnly: true },
	});
	return {
		tediId: tedi.id,
		name: tedi.displayName ?? tedi.slug,
		readOnly: true as const,
		workspaces,
		outputs: outputs.map(({ id, title, kind }) => ({ id, title, kind })),
	};
});
export const tediConsoleRouter = os.router({
	getGrant,
	setGrant,
	createSession,
	read,
});
