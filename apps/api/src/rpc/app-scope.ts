/**
 * App-ownership resolution for oRPC handlers.
 *
 * Six routers used to carry their own `requireAppForOrg`; five were
 * byte-identical and the sixth (`mcp-server.ts`) collapsed the two failure
 * modes into one. Both shapes live here so the error contract of each call
 * site stays exactly what it was.
 */

import type { DbClient } from "@tedix/db/client";
import { getAppById } from "@tedix/db/queries/app-records";
import { createError, ErrorCodes } from "./orpc";

/**
 * Resolve an app the caller's organization owns.
 *
 * An unknown id is NOT_FOUND; a known app that belongs to another organization
 * (or to none) is FORBIDDEN.
 */
export async function requireAppForOrg(
	db: DbClient,
	orgId: string,
	appId: string,
) {
	const app = await getAppById(db, appId);
	if (!app) {
		throw createError(ErrorCodes.NOT_FOUND, "App not found");
	}
	if (!app.organizationId || app.organizationId !== orgId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"You do not have access to this app",
		);
	}
	return app;
}

/**
 * Same ownership check, but an app that belongs to another organization is
 * reported as NOT_FOUND rather than FORBIDDEN, so a caller cannot probe which
 * app ids exist.
 */
export async function requireAppForOrgOrNotFound(
	db: DbClient,
	orgId: string,
	appId: string,
) {
	const app = await getAppById(db, appId);
	if (!app || app.organizationId !== orgId) {
		throw createError(ErrorCodes.NOT_FOUND, "App not found");
	}
	return app;
}
