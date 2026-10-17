import { verifyTediConsoleSession } from "@tedix/auth/tedi-console-session";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { getTediConsoleGrant } from "@tedix/db/queries/tedi-console";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { createError, ErrorCodes, type BaseContext } from "./orpc";
export async function authenticateTediConsoleSession(
	context: BaseContext,
	token: string,
) {
	let session;
	try {
		session = await verifyTediConsoleSession(
			context.env.SECRETS_MASTER_KEY,
			token,
		);
	} catch {
		throw createError(
			ErrorCodes.UNAUTHORIZED,
			"Invalid or expired console session",
		);
	}
	if (
		context.organizationId &&
		context.organizationId !== session.organizationId
	)
		throw createError(ErrorCodes.FORBIDDEN, "Console organization mismatch");
	const [grant, tedi, organization] = await Promise.all([
		getTediConsoleGrant(context.db, session.organizationId, session.tediId),
		getTediByIdForOrganization(
			context.db,
			session.tediId,
			session.organizationId,
		),
		getOrganizationById(context.db, session.organizationId),
	]);
	if (
		!grant?.enabled ||
		grant.revision !== session.grantRevision ||
		!tedi ||
		tedi.retiredAt ||
		tedi.status !== "active"
	)
		throw createError(ErrorCodes.FORBIDDEN, "Console access revoked");
	const hostTenantId = context.headers.get("X-Tedix-Tenant-Id");
	if (hostTenantId && hostTenantId !== organization?.descopeTenantId)
		throw createError(ErrorCodes.FORBIDDEN, "Console tenant host mismatch");
	context.authType = "tedi";
	context.tediId = session.tediId;
	context.organizationId = session.organizationId;
	context.tediScopes = ["apps:read"];
	context.tediConsoleWorkspaceIds = grant.workspaceIds;
	// A restricted credential must never keep an upstream human or admin identity.
	context.user = undefined;
	context.userId = undefined;
	context.serviceAccount = undefined;
	context.apiKey = undefined;
}
