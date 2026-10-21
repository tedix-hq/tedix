import { isPlatformPrincipal } from "@tedix/auth/types";
import { getConnectionProviderOwnershipForOrganization } from "@tedix/db/queries/connection-providers";
import { type BaseContext, createError, ErrorCodes } from "../../orpc";
import { requireOrgId } from "../../org-scope";

export async function requireProviderManagement(
	context: BaseContext,
	appId: string,
): Promise<void> {
	const organizationId = requireOrgId(context);
	if (isPlatformPrincipal(context)) return;
	if (
		context.authType === "user" &&
		(context.userRole === "owner" || context.userRole === "admin") &&
		(await getConnectionProviderOwnershipForOrganization(
			context.db,
			appId,
			organizationId,
		))
	)
		return;
	throw createError(
		ErrorCodes.FORBIDDEN,
		"Connection providers may only be managed by platform administrators or their owning organization's administrators.",
	);
}
